import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { steeringCommitSchema, steeringHeadSchema, steeringResourceExpectationSchema } from "../../src/storage/steering-types";
import { steeringHeadOf } from "../../src/storage/steering-transaction";
import { FileSteeringStore } from "../../src/storage/file/steering-store";
import { FileSpecStore } from "../../src/storage/file/spec-store";
import { inspectStorage } from "../../src/storage/file/recovery";
import { canonicalBytes, hashCanonical } from "../../src/storage/file/canonical-json";
import { steeringResourceRevisionSchema } from "../../src/steering/schema";
import { code, raw } from "../storage-v2/fixtures";
import { created, project, publish, revision } from "./fixtures";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of clean.splice(0)) await cleanup(); });
async function setup(initial = true) {
  const first = revision();
  const context = await created(initial ? [first] : []);
  clean.push(context.cleanup);
  return { ...context, first };
}

async function forge(context: Awaited<ReturnType<typeof setup>>, commit: ReturnType<typeof steeringCommitSchema.parse>) {
  commit.payload.operation_hash = hashCanonical(commit.payload.transaction);
  commit.id = hashCanonical(commit.payload);
  await writeFile(context.store.fs.paths.steeringCommit(commit.id), canonicalBytes(commit));
  await writeFile(context.store.fs.paths.steeringHead(), canonicalBytes(steeringHeadOf(commit)));
  return commit;
}

describe("Steering HEAD, commit, registry, and blob integrity", () => {
  test.each(["malformed", "version", "project", "sequence", "generation"])("rejects corrupt Steering HEAD: %s", async (kind) => {
    const context = await setup();
    const head = steeringHeadSchema.parse(context.result.head);
    let bytes: string | Uint8Array = canonicalBytes(head), expected = "STORE_CORRUPT_HEAD";
    if (kind === "malformed") bytes = "{";
    if (kind === "version") { head.schema = "aira.dev/steering-store-head/v2" as never; bytes = canonicalBytes(head); expected = "STORE_SCHEMA_UNSUPPORTED"; }
    if (kind === "project") { head.project = "other" as never; bytes = canonicalBytes(head); }
    if (kind === "sequence") { head.sequence = "9" as never; bytes = canonicalBytes(head); }
    if (kind === "generation") { head.steering_generation = "9" as never; bytes = canonicalBytes(head); }
    await writeFile(context.store.fs.paths.steeringHead(), bytes);
    await code(context.store.loadRegistry(project), expected as never);
  });

  test.each(["bytes", "hash", "version", "unknown-key"])("rejects corrupt Steering commit: %s", async (kind) => {
    const context = await setup();
    const commit = steeringCommitSchema.parse((await context.store.history(project))[0]!);
    let expected = "STORE_INTEGRITY";
    if (kind === "bytes") commit.payload.transaction.registry.resources[0]!.revisions[0]!.content.media_type = "text/plain";
    if (kind === "hash") commit.id = raw("wrong").hash;
    if (kind === "version") { commit.schema = "aira.dev/steering-store-commit/v2" as never; expected = "STORE_SCHEMA_UNSUPPORTED"; }
    if (kind === "unknown-key") { Object.assign(commit.payload, { unexpected: true }); expected = "STORE_CORRUPT_COMMIT"; }
    await writeFile(context.store.fs.paths.steeringCommit(context.result.commit_id), canonicalBytes(commit));
    await code(context.store.loadRegistry(project), expected as never);
  });

  test("missing and corrupt exact body blobs fail full reads and deep verification", async () => {
    const missing = await setup();
    await unlink(missing.store.fs.paths.blob(missing.first.revision.content.hash));
    await code(missing.store.loadRegistry(project), "STORE_INTEGRITY");
    await code(missing.store.verifyHistory(project), "STORE_INTEGRITY");

    const corrupt = await setup();
    await writeFile(corrupt.store.fs.paths.blob(corrupt.first.revision.content.hash), "changed");
    await code(corrupt.store.loadRegistry(project), "STORE_CORRUPT_BLOB");
  });

  test("missing immutable revision-record blobs fail even current inspection mode", async () => {
    const context = await setup();
    const record = context.result.registry.resources[0]!.revisions[0]!.record;
    await unlink(context.store.fs.paths.blob(record.hash));
    await code(context.store.loadRegistry(project, "current"), "STORE_INTEGRITY");
  });

  test("current mode still validates immutable revision records but may defer raw body verification", async () => {
    const context = await setup();
    await unlink(context.store.fs.paths.blob(context.first.revision.content.hash));
    expect((await context.store.loadRegistry(project, "current")).registry).toEqual(context.result.registry);
    await code(context.store.loadRegistry(project, "full"), "STORE_INTEGRITY");
  });

  test("unknown Steering transaction, registry, and resource schema versions fail closed", async () => {
    const context = await setup(false), publication = revision();
    const transaction = publish(context.result, publication);
    await code(context.store.commit({ ...transaction, schema: "aira.dev/steering-store-transaction/v2" } as never, [publication]), "STORE_SCHEMA_UNSUPPORTED");
    await code(context.store.commit({ ...transaction, registry: { ...transaction.registry, schema: "aira.dev/steering-registry/v2" } } as never, [publication]), "STORE_SCHEMA_UNSUPPORTED");
    await code(context.store.commit(transaction, [{ ...publication,
      revision: { ...publication.revision, schema: "aira.dev/steering-resource/v2" } as never }]), "STORE_SCHEMA_UNSUPPORTED");
  });

  test("project provenance mismatch and illegal current revision references fail closed", async () => {
    const context = await setup(false);
    const base = revision();
    const wrong = {
      revision: steeringResourceRevisionSchema.parse({ ...base.revision,
        provenance: { kind: "project", project: "other", authorship: "authored" } }),
      body: base.body,
    };
    await code(context.store.commit(publish(context.result, wrong), [wrong]), "STORE_INTEGRITY");

    const valid = publish(context.result, base, "operation_illegal_current");
    valid.registry.resources[0]!.current = { ...base.revision.identity, revision: "2" } as never;
    await code(context.store.commit(valid, [base]), "STORE_INTEGRITY");
  });

  test.each(["head", "commit", "steering-directory", "lock-directory", "lock-path"])("rejects Steering control-path symlink substitution: %s", async (kind) => {
    const context = await setup();
    const path = kind === "head" ? context.store.fs.paths.steeringHead() :
      kind === "commit" ? context.store.fs.paths.steeringCommit(context.result.commit_id) :
      kind === "lock-directory" ? context.store.fs.paths.steeringLocks() :
      kind === "lock-path" ? context.store.fs.paths.steeringLock() : context.store.fs.paths.steering();
    const target = join(context.root, `displaced-steering-${kind}`);
    if (kind === "lock-path") await mkdir(target);
    else await rename(path, target);
    await symlink(target, path);
    if (kind === "lock-directory" || kind === "lock-path")
      await code(context.store.commit(publish(context.result, revision("# Architecture v2\n", "2", context.first.revision))), "STORE_PATH_UNSAFE");
    else await code(context.store.loadRegistry(project), "STORE_PATH_UNSAFE");
  });

  test("Steering lock replacement at the final pre-rename barrier cannot advance HEAD", async () => {
    const context = await setup();
    const second = revision("# Architecture v2\n", "2", context.first.revision);
    const store = new FileSteeringStore(context.root, { clock: () => "2026-08-26T12:00:00.000Z", failpoint: async (point) => {
      if (point !== "before-head-rename") return;
      const path = context.store.fs.paths.steeringLock();
      const bytes = await readFile(join(path, "owner.json"));
      await rename(path, `${path}.old`);
      await mkdir(path);
      await writeFile(join(path, "owner.json"), bytes);
    } });
    await code(store.commit(publish(context.result, second, "operation_lock_replacement"), [second]), "STORE_LOCK_OWNERSHIP");
    expect((await context.store.inspectHead(project)).commit_id).toBe(context.result.commit_id);
    expect(String((await context.store.inspectHead(project)).steering_generation)).toBe("0");
  });

  test("a corrupted orphan operation commit cannot reserve OperationId or become authority", async () => {
    const context = await setup();
    const namesBefore = new Set(await readdir(context.store.fs.paths.steeringCommits()));
    const orphanRevision = revision("# Architecture orphan\n", "2", context.first.revision);
    const operation = "operation_corrupt_orphan";
    const failing = new FileSteeringStore(context.root, { clock: () => "2026-08-26T12:00:01.000Z",
      failpoint: (point) => { if (point === "after-commit-publication") throw new Error("orphan commit"); } });
    await code(failing.commit(publish(context.result, orphanRevision, operation), [orphanRevision]), "STORE_IO");
    const orphanName = (await readdir(context.store.fs.paths.steeringCommits())).find((name) => !namesBefore.has(name))!;
    await writeFile(join(context.store.fs.paths.steeringCommits(), orphanName), "{");

    const security = revision("# Security\n", "1", undefined, "steering.security");
    const committed = await context.store.commit(publish(context.result, security, operation), [security]);
    expect(committed.replayed).toBe(false);
    expect((await context.store.findCommittedOperation(project, committed.operation))?.id).toBe(committed.commit_id);
    expect((await context.store.verifyHistory(project)).commits).toBe(2);
    expect((await context.store.loadRegistry(project)).head).toEqual(committed.head);
  });

  test("a higher orphan commit never becomes authority without HEAD publication", async () => {
    const context = await setup();
    const second = revision("# Architecture v2\n", "2", context.first.revision);
    const transaction = publish(context.result, second);
    const failing = new FileSteeringStore(context.root, { clock: () => "2026-08-26T12:00:00.000Z",
      failpoint: (point) => { if (point === "after-commit-publication") throw new Error("stop before HEAD"); } });
    await code(failing.commit(transaction, [second]), "STORE_IO");
    expect((await context.store.loadRegistry(project)).head).toEqual(context.result.head);
    expect((await context.store.verifyHistory(project)).commits).toBe(1);
    expect((await readdir(context.store.fs.paths.steeringCommits())).filter((name) => name.endsWith(".json"))).toHaveLength(2);
    const inspection = await inspectStorage(new FileSpecStore(context.root));
    expect(inspection.complete).toBe(true);
    expect(inspection.entries.some((entry) => entry.kind === "commit" && entry.classification === "orphaned" && entry.path.startsWith("steering/"))).toBe(true);
  });
});

describe("Steering deep history verification", () => {
  test("valid exact parent chain verifies all immutable revisions and blobs", async () => {
    const context = await setup();
    const second = revision("# Architecture v2\n", "2", context.first.revision);
    const next = await context.store.commit(publish(context.result, second), [second]);
    const report = await context.store.verifyHistory(project);
    expect(report.commits).toBe(2);
    expect(report.revisions).toBe(2);
    expect(report.blobs).toBeGreaterThanOrEqual(4);
    expect((await context.store.loadRegistry(project, "deep")).head).toEqual(next.head);
  });

  test.each(["broken-parent", "duplicate-operation", "decreasing-generation"])("rejects forged history: %s", async (kind) => {
    const context = await setup();
    const second = revision("# Architecture v2\n", "2", context.first.revision);
    await context.store.commit(publish(context.result, second), [second]);
    const latest = steeringCommitSchema.parse((await context.store.history(project))[0]!);
    let expected = "STORE_CORRUPT_COMMIT";
    if (kind === "broken-parent") {
      const missing = raw("missing-parent").hash;
      latest.payload.parent = missing;
      latest.payload.transaction.expected!.head.commit_id = missing;
    }
    if (kind === "duplicate-operation") {
      latest.payload.transaction.operation = context.request.transaction.operation;
      expected = "STORE_OPERATION_REUSE";
    }
    if (kind === "decreasing-generation") {
      latest.payload.steering_generation = "0" as never;
      latest.payload.transaction.registry.generation = "0" as never;
    }
    await forge(context, latest);
    await code(context.store.verifyHistory(project), expected as never);
  });

  test("resource expectations are strict active/retired/absent states", () => {
    expect(steeringResourceExpectationSchema.safeParse({ id: "steering.architecture", status: "active" }).success).toBe(false);
    expect(steeringResourceExpectationSchema.safeParse({ id: "steering.architecture", status: "absent", current: revision().revision.identity }).success).toBe(false);
  });
});
