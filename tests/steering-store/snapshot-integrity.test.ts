import { afterEach, describe, expect, test } from "bun:test";
import { readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileSpecStore } from "../../src/storage/file/spec-store";
import { FileSteeringStore } from "../../src/storage/file/steering-store";
import { FileSteeringSnapshotStore } from "../../src/storage/file/steering-snapshot-store";
import { inspectStorage } from "../../src/storage/file/recovery";
import { canonicalBytes } from "../../src/storage/file/canonical-json";
import { steeringSnapshotLocatorSchema } from "../../src/storage/steering-snapshot-types";
import { steeringHeadOf } from "../../src/storage/steering-transaction";
import { contentHashSchema } from "../../src/spec/domain/primitives";
import type { SteeringSnapshotId } from "../../src/steering";
import { code, raw } from "../storage-v2/fixtures";
import { snapshot as domainSnapshot } from "../steering-domain/snapshot/fixtures";
import { at, created, project, publish, revision, snapshotMetadata } from "./fixtures";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of clean.splice(0)) await cleanup(); });

async function setup() {
  const first = revision();
  const context = await created([first]);
  clean.push(context.cleanup);
  const store = new FileSteeringSnapshotStore(context.root, { clock: () => at });
  const snapshot = domainSnapshot([first.revision], {}, at);
  const result = await store.putSnapshot(snapshot, snapshotMetadata(context.result, snapshot));
  return { ...context, first, store, snapshot, snapshotResult: result };
}

async function pointLocatorAt(
  context: Awaited<ReturnType<typeof setup>>,
  value: unknown,
  bytes = canonicalBytes(value),
): Promise<void> {
  const hash = await context.store.blobs.put(bytes);
  const locator = steeringSnapshotLocatorSchema.parse({
    ...context.snapshotResult.locator,
    record: { ...context.snapshotResult.locator.record, hash, bytes: bytes.length },
  });
  await writeFile(context.store.fs.paths.steeringSnapshotLocator(context.snapshot.id), canonicalBytes(locator));
}

describe("SteeringSnapshot record and locator integrity", () => {
  test.each([
    ["wrong snapshot id", (record: any) => {
      record.snapshot.id = `steering_snapshot_${"f".repeat(64)}`;
    }, "STORE_INTEGRITY"],
    ["wrong semantic hash", (record: any) => {
      record.semantic_hash = raw("wrong semantic hash").hash;
    }, "STORE_INTEGRITY"],
    ["project mismatch", (record: any) => {
      record.source.head.project = "other";
    }, "STORE_INTEGRITY"],
    ["malformed rule provenance", (record: any) => {
      delete record.snapshot.semantic.resources[0].revision.rules[0].source.content_hash;
    }, "STORE_INTEGRITY"],
    ["malformed enforcement reference", (record: any) => {
      record.snapshot.semantic.applicable_rules[0].enforcement = [{ kind: "unknown-mechanism" }];
    }, "STORE_INTEGRITY"],
    ["unsupported snapshot schema", (record: any) => {
      record.snapshot.schema = "aira.dev/steering-snapshot/v2";
    }, "STORE_SCHEMA_UNSUPPORTED"],
    ["unsupported record schema", (record: any) => {
      record.schema = "aira.dev/steering-snapshot-record/v2";
    }, "STORE_SCHEMA_UNSUPPORTED"],
  ] as const)("fails closed for %s", async (_name, mutate, expected) => {
    const context = await setup();
    const record = structuredClone(context.snapshotResult.record) as any;
    mutate(record);
    await pointLocatorAt(context, record);
    await code(context.store.getSnapshot(context.snapshot.id), expected);
  });

  test("modified record bytes, a missing record, and a wrong locator mapping never return a snapshot", async () => {
    const modified = await setup();
    await writeFile(modified.store.fs.paths.blob(modified.snapshotResult.locator.record.hash), "changed");
    await code(modified.store.getSnapshot(modified.snapshot.id), "STORE_CORRUPT_BLOB");

    const missing = await setup();
    await unlink(missing.store.fs.paths.blob(missing.snapshotResult.locator.record.hash));
    await code(missing.store.getSnapshot(missing.snapshot.id), "STORE_INTEGRITY");

    const mapped = await setup();
    const otherRevision = revision("# Security\n", "1", undefined, "steering.security");
    const current = await mapped.store.registry.commit(publish(mapped.result, otherRevision, "operation_add_security"), [otherRevision]);
    const other = domainSnapshot([otherRevision.revision], {}, "2026-08-26T12:00:03.000Z");
    const otherStored = await mapped.store.putSnapshot(other, snapshotMetadata(current, other, "operation_other_snapshot"));
    const forged = { ...otherStored.locator, snapshot: mapped.snapshotResult.locator.snapshot };
    await writeFile(mapped.store.fs.paths.steeringSnapshotLocator(mapped.snapshot.id), canonicalBytes(forged));
    await code(mapped.store.getSnapshot(mapped.snapshot.id), "STORE_INTEGRITY");
  });

  test("noncanonical record bytes and unsupported locator versions fail closed", async () => {
    const noncanonical = await setup();
    const text = JSON.stringify(noncanonical.snapshotResult.record, null, 2);
    await pointLocatorAt(noncanonical, noncanonical.snapshotResult.record, new TextEncoder().encode(text));
    await code(noncanonical.store.getSnapshot(noncanonical.snapshot.id), "STORE_INTEGRITY");

    const locator = await setup();
    await writeFile(locator.store.fs.paths.steeringSnapshotLocator(locator.snapshot.id),
      canonicalBytes({ ...locator.snapshotResult.locator, schema: "aira.dev/steering-snapshot-locator/v2" }));
    await code(locator.store.getSnapshot(locator.snapshot.id), "STORE_SCHEMA_UNSUPPORTED");
    const report = await inspectStorage(new FileSpecStore(locator.root));
    expect(report.entries.some((entry) => entry.kind === "snapshot" && entry.classification === "corrupt" &&
      entry.error === "STORE_SCHEMA_UNSUPPORTED")).toBe(true);
    expect(report.entries.some((entry) => entry.kind === "head" && entry.path === "steering/HEAD" &&
      entry.classification === "reachable")).toBe(true);
    expect((await locator.store.registry.loadRegistry(project)).head).toEqual(locator.result.head);
  });

  test("an orphan Steering commit cannot authenticate snapshot source attribution", async () => {
    const context = await setup();
    const second = revision("# Architecture orphan\n", "2", context.first.revision);
    const transaction = publish(context.result, second, "operation_orphan_snapshot_source");
    const failing = new FileSteeringStore(context.root, { clock: () => at,
      failpoint: (point) => { if (point === "after-commit-publication") throw new Error("leave orphan"); } });
    await code(failing.commit(transaction, [second]), "STORE_IO");
    const names = (await readdir(context.store.fs.paths.steeringCommits())).filter((name) => name.endsWith(".json"));
    const orphanName = names.find((name) => !name.startsWith(context.result.commit_id.slice(7)))!;
    const orphanHash = contentHashSchema.parse(`sha256:${orphanName.slice(0, 64)}`);
    const orphan = await context.store.registry.commits.read(project, orphanHash);
    const snapshot = domainSnapshot([second.revision], {}, "2026-08-26T12:00:04.000Z");
    const baseMetadata = snapshotMetadata(context.result, snapshot, "operation_publish_from_orphan");
    const metadata = { ...baseMetadata, source: { ...baseMetadata.source, head: steeringHeadOf(orphan) } };
    await code(context.store.putSnapshot(snapshot, metadata), "STORE_INTEGRITY");
    expect(await context.store.hasSnapshot(snapshot.id)).toBe(false);
  });

  test("inspection recognizes immutable snapshot locators, record blobs, and publication temporaries", async () => {
    const context = await setup();
    await writeFile(join(context.store.fs.paths.steeringSnapshotLocators(), `.publish-tmp-${"b".repeat(48)}`), "temporary");
    const generic = raw("unattributed shared blob");
    await context.store.blobs.put(generic.bytes);
    const report = await inspectStorage(new FileSpecStore(context.root));
    expect(report.entries.some((entry) => entry.kind === "snapshot" && entry.classification === "reachable" &&
      entry.path.startsWith("steering/snapshot-locators/"))).toBe(true);
    expect(report.entries.some((entry) => entry.kind === "snapshot" && entry.classification === "reachable" &&
      entry.path.includes(context.snapshotResult.locator.record.hash.slice(7)))).toBe(true);
    expect(report.entries.some((entry) => entry.kind === "snapshot" && entry.classification === "temporary")).toBe(true);
    expect(report.entries.some((entry) => entry.kind === "blob" && entry.path.includes(generic.hash.slice(7)))).toBe(true);

    await writeFile(context.store.fs.paths.blob(context.snapshotResult.locator.record.hash), "corrupt");
    const corrupted = await inspectStorage(new FileSpecStore(context.root));
    expect(corrupted.entries.some((entry) => entry.kind === "snapshot" && entry.classification === "corrupt" &&
      entry.path.includes(context.snapshotResult.locator.record.hash.slice(7)))).toBe(true);
  });

  test("symlinked snapshot locator directories and unsafe temporary targets fail closed", async () => {
    const firstRevision = revision(), firstContext = await created([firstRevision]); clean.push(firstContext.cleanup);
    const firstStore = new FileSteeringSnapshotStore(firstContext.root, { clock: () => at });
    const firstSnapshot = domainSnapshot([firstRevision.revision], {}, at);
    await firstStore.fs.ensureDir(firstStore.fs.paths.steeringSnapshotLocators());
    const displaced = join(firstContext.root, "displaced-snapshot-locators");
    await rename(firstStore.fs.paths.steeringSnapshotLocators(), displaced);
    await symlink(displaced, firstStore.fs.paths.steeringSnapshotLocators());
    await code(firstStore.putSnapshot(firstSnapshot, snapshotMetadata(firstContext.result, firstSnapshot)), "STORE_PATH_UNSAFE");

    const secondRevision = revision(), secondContext = await created([secondRevision]); clean.push(secondContext.cleanup);
    const token = "a".repeat(48);
    const secondStore = new FileSteeringSnapshotStore(secondContext.root, { clock: () => at, token: () => token });
    const secondSnapshot = domainSnapshot([secondRevision.revision], {}, at);
    await secondStore.fs.ensureDir(secondStore.fs.paths.steeringSnapshotLocators());
    const outside = join(secondContext.root, "outside-temp-target");
    await writeFile(outside, "do not replace");
    await symlink(outside, join(secondStore.fs.paths.steeringSnapshotLocators(), `.publish-tmp-${token}`));
    await code(secondStore.putSnapshot(secondSnapshot, snapshotMetadata(secondContext.result, secondSnapshot)), "STORE_PATH_UNSAFE");
    expect(await readFile(outside, "utf8")).toBe("do not replace");
    expect(await secondStore.hasSnapshot(secondSnapshot.id)).toBe(false);
  });

  test("invalid IDs and symlinked locator paths fail closed without traversal or repair", async () => {
    const context = await setup();
    for (const id of ["steering_snapshot_../escape", "steering_snapshot_short", `steering_snapshot_${"A".repeat(64)}`])
      await code(context.store.getSnapshot(id as SteeringSnapshotId), "STORE_PATH_UNSAFE");

    const path = context.store.fs.paths.steeringSnapshotLocator(context.snapshot.id);
    const displaced = join(context.root, "displaced-snapshot-locator");
    await rename(path, displaced);
    await symlink(displaced, path);
    await code(context.store.getSnapshot(context.snapshot.id), "STORE_PATH_UNSAFE");
  });
});
