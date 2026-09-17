import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Failpoint } from "../../src/storage/file/fsync";
import type { SteeringRevisionPublication, SteeringTransaction } from "../../src/storage/steering-types";
import type { SteeringSnapshotPublicationMetadata } from "../../src/storage";
import type { SteeringSnapshot } from "../../src/steering";
import { FileSteeringSnapshotStore } from "../../src/storage/file/steering-snapshot-store";
import { launchWorker } from "../storage-v2/processes";
import { snapshot as domainSnapshot } from "../steering-domain/snapshot/fixtures";
import { at, created, creation, project, publish, revision, snapshotMetadata, temporary } from "./fixtures";

const worker = fileURLToPath(new URL("./process-worker.ts", import.meta.url));
const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of clean.splice(0)) await cleanup(); });

async function registryRequestFile(
  root: string,
  transaction: SteeringTransaction,
  revisions: readonly SteeringRevisionPublication[],
) {
  const path = join(root, `steering-crash-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify({ transaction,
    revisions: revisions.map((publication) => ({
      revision: publication.revision,
      hex: Buffer.from(publication.body).toString("hex"),
    })), blobs: [] }));
  return path;
}

async function snapshotRequestFile(root: string, snapshot: SteeringSnapshot, metadata: SteeringSnapshotPublicationMetadata) {
  const path = join(root, `snapshot-crash-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify({ snapshot, metadata }));
  return path;
}

const boundaries: Failpoint[] = [
  "after-lock-acquisition",
  "after-steering-body-blob-publication",
  "after-steering-revision-record-publication",
  "after-blob-publication",
  "after-commit-publication",
  "after-head-temp-write",
  "after-head-temp-fsync",
  "before-head-rename",
  "after-head-rename",
  "after-head-directory-fsync",
  "before-lock-release",
];
const published = (boundary: Failpoint): boolean =>
  ["after-head-rename", "after-head-directory-fsync", "before-lock-release"].includes(boundary);

for (const boundary of boundaries) {
  test(`Steering mutation SIGKILL at ${boundary} leaves only old or new authority`, async () => {
    const first = revision(), context = await created([first]); clean.push(context.cleanup);
    const second = revision("# Architecture v2\n", "2", first.revision);
    const transaction = publish(context.result, second, "operation_crash_mutation");
    const request = await registryRequestFile(context.root, transaction, [second]);
    const killed = await launchWorker(worker, context.root, "commit", request, boundary).done();
    expect(killed.exit).not.toBe(0);

    const read = await launchWorker(worker, context.root, "inspect", project).done();
    expect(read.last?.ok).toBe(true);
    const registry = read.last?.registry as { generation: string; resources: { current: unknown }[] };
    expect(registry.generation).toBe(published(boundary) ? "1" : "0");
    expect(registry.resources[0]!.current).toEqual(published(boundary) ? second.revision.identity : first.revision.identity);
    expect((await launchWorker(worker, context.root, "recover", project).done()).last?.recovered).toBe(true);

    const retry = await launchWorker(worker, context.root, "commit", request).done();
    expect(retry.last?.ok).toBe(true);
    expect((retry.last?.result as { replayed: boolean }).replayed).toBe(published(boundary));
    const verified = await context.store.verifyHistory(project);
    expect(verified.commits).toBe(2);
    expect(String(verified.head.steering_generation)).toBe("1");
  }, 30_000);

  test(`Steering genesis SIGKILL at ${boundary} makes HEAD alone determine existence`, async () => {
    const context = await temporary(); clean.push(context.cleanup);
    const first = revision();
    const requestValue = creation("operation_crash_genesis", [first]);
    const request = await registryRequestFile(context.root, requestValue.transaction, requestValue.publications);
    const killed = await launchWorker(worker, context.root, "commit", request, boundary).done();
    expect(killed.exit).not.toBe(0);

    const read = await launchWorker(worker, context.root, "inspect", project).done();
    expect(read.last?.ok).toBe(published(boundary));
    if (!published(boundary)) expect(read.last?.code).toBe("STORE_NOT_FOUND");
    expect((await launchWorker(worker, context.root, "recover", project).done()).last?.recovered).toBe(true);

    const retry = await launchWorker(worker, context.root, "commit", request).done();
    expect(retry.last?.ok).toBe(true);
    expect((retry.last?.result as { replayed: boolean }).replayed).toBe(published(boundary));
    const verified = await context.store.verifyHistory(project);
    expect(verified.commits).toBe(1);
    expect(String(verified.head.sequence)).toBe("1");
    expect(String(verified.head.steering_generation)).toBe("0");
  }, 30_000);
}

for (const boundary of ["after-snapshot-record-publication", "after-snapshot-locator-publication"] as const) {
  test(`snapshot SIGKILL at ${boundary} returns no partial snapshot and retry converges`, async () => {
    const first = revision(), context = await created([first]); clean.push(context.cleanup);
    const snapshot = domainSnapshot([first.revision], {}, at);
    const metadata = snapshotMetadata(context.result, snapshot, "operation_snapshot_crash");
    const request = await snapshotRequestFile(context.root, snapshot, metadata);
    const killed = await launchWorker(worker, context.root, "snapshot-put", request, boundary).done();
    expect(killed.exit).not.toBe(0);

    const read = await launchWorker(worker, context.root, "snapshot-inspect", snapshot.id).done();
    const locatorPublished = boundary === "after-snapshot-locator-publication";
    expect(read.last?.ok).toBe(locatorPublished);
    if (!locatorPublished) expect(read.last?.code).toBe("STORE_NOT_FOUND");

    const retry = await launchWorker(worker, context.root, "snapshot-put", request).done();
    expect(retry.last?.ok).toBe(true);
    expect((retry.last?.result as { reused: boolean }).reused).toBe(locatorPublished);
    const store = new FileSteeringSnapshotStore(context.root);
    expect(await store.getSnapshot(snapshot.id)).toEqual(snapshot);
    expect((await context.store.verifyHistory(project)).commits).toBe(1);
  }, 30_000);
}

test("OperationId replay after post-HEAD crash and later unrelated commits returns the original generation", async () => {
  const first = revision(), context = await created([first]); clean.push(context.cleanup);
  const second = revision("# Architecture v2\n", "2", first.revision);
  const transaction = publish(context.result, second, "operation_crash_then_later_replay");
  const request = await registryRequestFile(context.root, transaction, [second]);
  expect((await launchWorker(worker, context.root, "commit", request, "after-head-rename").done()).exit).not.toBe(0);
  expect((await launchWorker(worker, context.root, "recover", project).done()).last?.recovered).toBe(true);

  const committed = await context.store.loadRegistry(project);
  const security = revision("# Security\n", "1", undefined, "steering.security");
  const later = await context.store.commit(publish(committed, security, "operation_after_crash"), [security]);
  const replay = await context.store.commit(transaction, [second]);
  expect(replay.replayed).toBe(true);
  expect(replay.commit_id).toBe(committed.head.commit_id);
  expect(String(replay.steering_generation)).toBe("1");
  expect(await context.store.inspectHead(project)).toEqual(later.head);
  expect((await context.store.verifyHistory(project)).commits).toBe(3);
}, 30_000);
