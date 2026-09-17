import { afterEach, describe, expect, test } from "bun:test";
import { stat, unlink, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { FileSteeringSnapshotStore } from "../../src/storage/file/steering-snapshot-store";
import { code } from "../storage-v2/fixtures";
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
  const metadata = snapshotMetadata(context.result, snapshot);
  return { ...context, first, store, snapshot, metadata };
}

describe("immutable SteeringSnapshot publication and lookup", () => {
  test("put/get/has/inspect/verify round-trip the exact domain snapshot without registry mutation", async () => {
    const context = await setup();
    const beforeHead = await context.store.registry.inspectHead(project);
    const beforeHistory = await context.store.registry.history(project);
    const result = await context.store.putSnapshot(context.snapshot, context.metadata);

    expect(result.reused).toBe(false);
    expect(result.record.snapshot).toEqual(context.snapshot);
    expect(result.record.snapshot_id).toBe(context.snapshot.id);
    expect(result.record.semantic_hash).toBe(context.snapshot.content.hash);
    expect(result.record.source.head).toEqual(context.result.head);
    expect(relative(context.store.fs.paths.root,
      context.store.fs.paths.steeringSnapshotLocator(context.snapshot.id)))
      .toBe(`steering/snapshot-locators/${context.snapshot.id.slice("steering_snapshot_".length)}.json`);
    expect(await context.store.hasSnapshot(context.snapshot.id)).toBe(true);
    expect(await context.store.getSnapshot(context.snapshot.id)).toEqual(context.snapshot);
    expect(await context.store.inspectSnapshot(context.snapshot.id)).toEqual(result.record);
    expect(Object.isFrozen(await context.store.getSnapshot(context.snapshot.id))).toBe(true);

    const report = await context.store.verifySnapshot(context.snapshot.id);
    expect(report).toMatchObject({
      snapshot_id: context.snapshot.id,
      semantic_hash: context.snapshot.content.hash,
      source_head: context.result.head,
      resources: 1,
    });
    expect(report.blobs).toBeGreaterThanOrEqual(3);
    expect(await context.store.registry.inspectHead(project)).toEqual(beforeHead);
    expect(await context.store.registry.history(project)).toEqual(beforeHistory);

    const fresh = new FileSteeringSnapshotStore(context.root);
    const loaded = await fresh.getSnapshot(context.snapshot.id);
    expect(loaded.semantic.effective_rules.map((rule) => rule.semantics.key))
      .toEqual(context.snapshot.semantic.effective_rules.map((rule) => rule.semantics.key));
    expect(loaded.semantic.applicable_rules.map((rule) => ({ resource: rule.resource, rule: rule.rule })))
      .toEqual(context.snapshot.semantic.applicable_rules.map((rule) => ({ resource: rule.resource, rule: rule.rule })));
    expect(loaded.semantic.enforcement).toEqual(context.snapshot.semantic.enforcement);
    expect(loaded.semantic.resolver).toEqual(context.snapshot.semantic.resolver);
  });

  test("identical publication reuses one record and locator while alternate audit bytes collide", async () => {
    const context = await setup();
    const first = await context.store.putSnapshot(context.snapshot, context.metadata);
    const recordPath = context.store.fs.paths.blob(first.locator.record.hash);
    const locatorPath = context.store.fs.paths.steeringSnapshotLocator(context.snapshot.id);
    const beforeRecord = await stat(recordPath), beforeLocator = await stat(locatorPath);

    const retry = await context.store.putSnapshot(context.snapshot, context.metadata);
    expect(retry.reused).toBe(true);
    expect(retry.locator).toEqual(first.locator);
    expect(`${(await stat(recordPath)).dev}:${(await stat(recordPath)).ino}`)
      .toBe(`${beforeRecord.dev}:${beforeRecord.ino}`);
    expect(`${(await stat(locatorPath)).dev}:${(await stat(locatorPath)).ino}`)
      .toBe(`${beforeLocator.dev}:${beforeLocator.ino}`);

    const alternate = domainSnapshot([context.first.revision], {}, "2026-08-26T12:00:01.000Z");
    expect(alternate.id).toBe(context.snapshot.id);
    expect(alternate.content.hash).toBe(context.snapshot.content.hash);
    await code(context.store.putSnapshot(alternate,
      snapshotMetadata(context.result, alternate, "operation_snapshot_collision")), "STORE_INTEGRITY");
    expect(await context.store.getSnapshot(context.snapshot.id)).toEqual(context.snapshot);
  });

  test("an old attributable snapshot remains exact after the current Steering revision changes", async () => {
    const context = await setup();
    const snapshotA = context.snapshot;
    const metadataA = context.metadata;
    const second = revision("# Architecture\n\nUse ports and adapters.\n", "2", context.first.revision);
    const current = await context.store.registry.commit(publish(context.result, second), [second]);
    const snapshotB = domainSnapshot([second.revision], {}, "2026-08-26T12:00:02.000Z");
    expect(snapshotB.id).not.toBe(snapshotA.id);

    const storedA = await context.store.putSnapshot(snapshotA, metadataA);
    const storedB = await context.store.putSnapshot(snapshotB,
      snapshotMetadata(current, snapshotB, "operation_snapshot_b"));
    expect(storedA.record.source.head).toEqual(context.result.head);
    expect(storedB.record.source.head).toEqual(current.head);
    expect((await context.store.getSnapshot(snapshotA.id)).semantic.resources[0]!.revision.identity)
      .toEqual(context.first.revision.identity);
    expect((await context.store.getSnapshot(snapshotB.id)).semantic.resources[0]!.revision.identity)
      .toEqual(second.revision.identity);
    expect((await context.store.registry.loadRegistry(project)).registry.resources[0]!.current)
      .toEqual(second.revision.identity);
    expect(await context.store.verifySnapshot(snapshotA.id)).toMatchObject({ source_head: context.result.head });
    expect(await context.store.verifySnapshot(snapshotB.id)).toMatchObject({ source_head: current.head });
  });

  test.each(["missing-body", "wrong-body", "missing-revision-record"] as const)(
    "deep verification fails closed for %s while ordinary historical decode stays self-contained",
    async (kind) => {
      const context = await setup();
      await context.store.putSnapshot(context.snapshot, context.metadata);
      if (kind === "missing-body") await unlink(context.store.fs.paths.blob(context.first.revision.content.hash));
      if (kind === "wrong-body") await writeFile(context.store.fs.paths.blob(context.first.revision.content.hash), "wrong body");
      if (kind === "missing-revision-record") {
        const record = context.result.registry.resources[0]!.revisions[0]!.record;
        await unlink(context.store.fs.paths.blob(record.hash));
      }
      expect(await context.store.getSnapshot(context.snapshot.id)).toEqual(context.snapshot);
      await code(context.store.verifySnapshot(context.snapshot.id),
        kind === "wrong-body" ? "STORE_CORRUPT_BLOB" : "STORE_INTEGRITY");
    },
  );

  test("publication rejects noncurrent and cross-project source attribution", async () => {
    const context = await setup();
    const second = revision("# Architecture v2\n", "2", context.first.revision);
    const current = await context.store.registry.commit(publish(context.result, second), [second]);
    const impossible = { ...context.metadata, source: { ...context.metadata.source, head: current.head } };
    await code(context.store.putSnapshot(context.snapshot, impossible), "STORE_INTEGRITY");

    const foreign = { ...context.metadata, source: { ...context.metadata.source,
      head: { ...context.metadata.source.head, project: "other" } } };
    await code(context.store.putSnapshot(context.snapshot, foreign as never), "STORE_INTEGRITY");
    expect(await context.store.hasSnapshot(context.snapshot.id)).toBe(false);
  });
});
