import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FileSpecStore } from "../../src/storage/file/spec-store";
import { FileSteeringStore } from "../../src/storage/file/steering-store";
import { FileSteeringSnapshotStore } from "../../src/storage/file/steering-snapshot-store";
import { specIdSchema } from "../../src/spec/domain/ids";
import type { BlobInput } from "../../src/storage/types";
import type { SteeringRevisionPublication, SteeringTransaction } from "../../src/storage/steering-types";
import type { SteeringSnapshotPublicationMetadata } from "../../src/storage";
import type { SteeringSnapshot } from "../../src/steering";
import { launchWorker } from "../storage-v2/processes";
import { code, creation as specCreation } from "../storage-v2/fixtures";
import { snapshot as domainSnapshot } from "../steering-domain/snapshot/fixtures";
import { at, created, project, publish, revision, snapshotMetadata } from "./fixtures";

const worker = fileURLToPath(new URL("./process-worker.ts", import.meta.url));
const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of clean.splice(0)) await cleanup(); });

async function requestFile(root: string, transaction: SteeringTransaction,
  revisions: readonly SteeringRevisionPublication[] = [], blobs: readonly BlobInput[] = []) {
  const path = join(root, `steering-request-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify({ transaction,
    revisions: revisions.map((publication) => ({ revision: publication.revision, hex: Buffer.from(publication.body).toString("hex") })),
    blobs: blobs.map((blob) => ({ hash: blob.hash, hex: Buffer.from(blob.bytes).toString("hex") })) }));
  return path;
}

async function snapshotRequestFile(root: string, snapshot: SteeringSnapshot, metadata: SteeringSnapshotPublicationMetadata) {
  const path = join(root, `snapshot-request-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify({ snapshot, metadata }));
  return path;
}

async function setup() {
  const context = await created();
  clean.push(context.cleanup);
  return context;
}

test("two OS processes mutating the same expected Steering HEAD have exactly one authority winner", async () => {
  const context = await setup(), gate = join(context.root, "start");
  const architecture = revision(), security = revision("# Security\n", "1", undefined, "steering.security");
  const a = launchWorker(worker, context.root, "race", await requestFile(context.root,
    publish(context.result, architecture, "operation_process_a"), [architecture]), "", gate);
  const b = launchWorker(worker, context.root, "race", await requestFile(context.root,
    publish(context.result, security, "operation_process_b"), [security]), "", gate);
  await Promise.all([a.until("ready"), b.until("ready")]);
  await writeFile(gate, "go");
  const results = (await Promise.all([a.done(), b.done()])).map((result) => result.last!);
  expect(results.filter((result) => result.ok).length).toBe(1);
  expect(results.find((result) => !result.ok)?.code).toBe("STORE_CONFLICT");
  expect((await context.store.verifyHistory(project)).commits).toBe(2);
  expect((await context.store.loadRegistry(project)).registry.resources).toHaveLength(1);
}, 30_000);

test("two OS processes retrying the same exact OperationId converge on one commit", async () => {
  const context = await setup(), gate = join(context.root, "start"), publication = revision();
  const transaction = publish(context.result, publication, "operation_process_retry");
  const path = await requestFile(context.root, transaction, [publication]);
  const children = [launchWorker(worker, context.root, "race", path, "", gate), launchWorker(worker, context.root, "race", path, "", gate)];
  await Promise.all(children.map((child) => child.until("ready")));
  await writeFile(gate, "go");
  const results = (await Promise.all(children.map((child) => child.done()))).map((result) => result.last!);
  expect(results.every((result) => result.ok)).toBe(true);
  const commits = results.map((result) => result.result as { commit_id: string; replayed: boolean });
  expect(commits[0]!.commit_id).toBe(commits[1]!.commit_id);
  expect(commits.map((commit) => commit.replayed).sort()).toEqual([false, true]);
  expect((await context.store.verifyHistory(project)).commits).toBe(2);
}, 30_000);

test("concurrent reuse of one OperationId for different Steering intents is rejected", async () => {
  const context = await setup(), gate = join(context.root, "start");
  const architecture = revision(), security = revision("# Security\n", "1", undefined, "steering.security");
  const operation = "operation_process_reuse_conflict";
  const children = [
    launchWorker(worker, context.root, "race", await requestFile(context.root,
      publish(context.result, architecture, operation), [architecture]), "", gate),
    launchWorker(worker, context.root, "race", await requestFile(context.root,
      publish(context.result, security, operation), [security]), "", gate),
  ];
  await Promise.all(children.map((child) => child.until("ready")));
  await writeFile(gate, "go");
  const results = (await Promise.all(children.map((child) => child.done()))).map((result) => result.last!);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)?.code).toBe("STORE_OPERATION_REUSE");
  expect((await context.store.verifyHistory(project)).commits).toBe(2);
}, 30_000);

test("multiple OS processes publishing one identical snapshot converge on one immutable locator", async () => {
  const first = revision(), context = await created([first]); clean.push(context.cleanup);
  const snapshot = domainSnapshot([first.revision], {}, at);
  const metadata = snapshotMetadata(context.result, snapshot, "operation_process_snapshot");
  const path = await snapshotRequestFile(context.root, snapshot, metadata), gate = join(context.root, "start");
  const children = [launchWorker(worker, context.root, "snapshot-race", path, "", gate),
    launchWorker(worker, context.root, "snapshot-race", path, "", gate)];
  await Promise.all(children.map((child) => child.until("ready")));
  await writeFile(gate, "go");
  const results = (await Promise.all(children.map((child) => child.done()))).map((result) => result.last!);
  expect(results.every((result) => result.ok)).toBe(true);
  const publications = results.map((result) => result.result as { reused: boolean; locator: { record: { hash: string } } });
  expect(new Set(publications.map((publication) => publication.locator.record.hash)).size).toBe(1);
  expect(publications.map((publication) => publication.reused).sort()).toEqual([false, true]);
  const store = new FileSteeringSnapshotStore(context.root);
  expect(await store.getSnapshot(snapshot.id)).toEqual(snapshot);
  expect((await context.store.verifyHistory(project)).commits).toBe(1);
}, 30_000);

test("concurrent alternate records for one SteeringSnapshotId fail closed", async () => {
  const first = revision(), context = await created([first]); clean.push(context.cleanup);
  const left = domainSnapshot([first.revision], {}, at);
  const right = domainSnapshot([first.revision], {}, "2026-08-26T12:00:01.000Z");
  expect(left.id).toBe(right.id);
  const gate = join(context.root, "start");
  const children = [
    launchWorker(worker, context.root, "snapshot-race", await snapshotRequestFile(context.root, left,
      snapshotMetadata(context.result, left, "operation_snapshot_collision_left")), "", gate),
    launchWorker(worker, context.root, "snapshot-race", await snapshotRequestFile(context.root, right,
      snapshotMetadata(context.result, right, "operation_snapshot_collision_right")), "", gate),
  ];
  await Promise.all(children.map((child) => child.until("ready")));
  await writeFile(gate, "go");
  const results = (await Promise.all(children.map((child) => child.done()))).map((result) => result.last!);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)?.code).toBe("STORE_INTEGRITY");
  expect([left.audit, right.audit]).toContainEqual((await new FileSteeringSnapshotStore(context.root).getSnapshot(left.id)).audit);
}, 30_000);

test("snapshot publication from an old state does not hold the registry lock and retains old attribution", async () => {
  const first = revision(), context = await created([first]); clean.push(context.cleanup);
  const snapshot = domainSnapshot([first.revision], {}, at);
  const request = await snapshotRequestFile(context.root, snapshot,
    snapshotMetadata(context.result, snapshot, "operation_snapshot_old_state"));
  const gate = join(context.root, "release-snapshot");
  const child = launchWorker(worker, context.root, "snapshot-put", request, "hold-snapshot", gate);
  await child.until("held");

  const second = revision("# Architecture v2\n", "2", first.revision);
  const current = await context.store.commit(publish(context.result, second, "operation_mutate_during_snapshot"), [second]);
  await writeFile(gate, "go");
  expect((await child.done()).last?.ok).toBe(true);

  const snapshots = new FileSteeringSnapshotStore(context.root);
  expect((await snapshots.inspectSnapshot(snapshot.id)).source.head).toEqual(context.result.head);
  expect((await snapshots.verifySnapshot(snapshot.id)).source_head).toEqual(context.result.head);
  expect((await context.store.inspectHead(project)).commit_id).toBe(current.commit_id);
}, 30_000);

test("immutable snapshot publication does not acquire or nest the Steering authority lock", async () => {
  const first = revision(), context = await created([first]); clean.push(context.cleanup);
  const snapshots = new FileSteeringSnapshotStore(context.root, { clock: () => at, lockTimeoutMs: 20 });
  const snapshot = domainSnapshot([first.revision], {}, at);
  const lock = await context.store.locks.acquire(project);
  try {
    const published = await snapshots.putSnapshot(snapshot, snapshotMetadata(context.result, snapshot));
    expect(published.snapshot.id).toBe(snapshot.id);
  } finally { await context.store.locks.release(lock); }
  expect((await context.store.verifyHistory(project)).commits).toBe(1);
}, 30_000);

test("Steering lock ownership is inode-pinned and explicit dead-owner recovery is reused", async () => {
  const context = await setup();
  const lock = await context.store.locks.acquire(project);
  await code(context.store.locks.release({ ...lock, owner: "0".repeat(48) }), "STORE_LOCK_OWNERSHIP");
  expect((await context.store.locks.owner(project))?.owner).toBe(lock.owner);
  await context.store.locks.release(lock);

  await launchWorker(worker, context.root, "lock-die", project).done();
  expect((await context.store.locks.owner(project))?.pid).not.toBe(process.pid);
  expect(await context.store.recoverLock(project)).toBe(true);
  expect(await context.store.locks.owner(project)).toBeNull();
}, 30_000);

test("existing SpecStore publication remains compatible beside Steering authority", async () => {
  const context = await setup();
  const specStore = new FileSpecStore(context.root);
  const request = specCreation("spec_beside_steering", "operation_spec_beside_steering");
  const spec = await specStore.createSpec(request.transaction, request.blobs);
  const steering = await context.store.commit(publish(context.result, revision()), [revision()]);
  expect((await specStore.inspectHead(spec.spec_id)).commit_id).toBe(spec.commit_id);
  expect((await context.store.inspectHead(project)).commit_id).toBe(steering.commit_id);
});

test("Steering and per-Spec locks are independent authority boundaries", async () => {
  const context = await setup();
  const steeringStore = new FileSteeringStore(context.root, { lockTimeoutMs: 20 });
  const specStore = new FileSpecStore(context.root, { lockTimeoutMs: 20 });
  const spec = specIdSchema.parse("spec_lock_independence");
  expect(steeringStore.fs.paths.steeringLock()).not.toBe(specStore.fs.paths.lock(spec));
  const steeringLock = await steeringStore.locks.acquire(project);
  const specLock = await specStore.locks.acquire(spec);
  try {
    await code(steeringStore.commit(publish(context.result, revision()), [revision()]), "STORE_LOCKED");
  } finally {
    await specStore.locks.release(specLock);
    await steeringStore.locks.release(steeringLock);
  }
  const result = await context.store.commit(publish(context.result, revision()), [revision()]);
  expect(String(result.sequence)).toBe("2");
});
