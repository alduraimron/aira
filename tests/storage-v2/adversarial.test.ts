import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdir, rename, writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { created, mutation, code, raw, temporary, at } from "./fixtures";
import { withRun } from "./run-fixture";
import { FileSpecStore } from "../../src/storage/file/spec-store";
import { canonicalBytes, hashCanonical } from "../../src/storage/file/canonical-json";
import { commitSchema, headSchema } from "../../src/storage/types";
import { headOf } from "../../src/storage/transaction";
import { readRecords } from "../../src/storage/file/records";
import { inspectStorage } from "../../src/storage/file/recovery";
import { parseRecord } from "../../src/storage/records";
import { claimRecordSchema } from "../../src/execution/schema";
import { launch } from "./processes";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
async function setup() { const x = await created(); clean.push(x.cleanup); return x; }

test.each([null, [], {}, { schema: "aira.dev/store-head/v1" }].map((value) => [value]))("canonical JSON is not a HEAD: %p", async (value) => {
  const x = await setup(); await writeFile(x.store.fs.paths.head(x.result.spec_id), canonicalBytes(value));
  await code(x.store.loadSpec(x.result.spec_id), "STORE_CORRUPT_HEAD");
});
test("valid blob hash cannot substitute the wrong record type", async () => {
  const x = await setup(), bytes = canonicalBytes(x.result.state.spec), hash = await x.store.blobs.put(bytes);
  await code(readRecords(x.store.blobs, [{ hash, contract: "aira.dev/requirements/v1" }]), "STORE_INTEGRITY");
});
test.each(["directory", "owner-file", "metadata"])("same-token lock %s substitution is rejected", async (kind) => {
  const x = await setup(), lock = await x.store.locks.acquire(x.result.spec_id), dir = x.store.fs.paths.lock(lock.spec);
  const bytes = await readFile(join(dir, "owner.json"));
  if (kind === "directory") { await rename(dir, `${dir}.old`); await mkdir(dir); }
  if (kind === "owner-file") await rename(join(dir, "owner.json"), join(x.root, "old-owner"));
  await writeFile(join(dir, "owner.json"), kind === "metadata" ? canonicalBytes({ ...JSON.parse(bytes.toString()), pid: process.pid + 1 }) : bytes);
  await code(x.store.locks.assertOwner(lock), "STORE_LOCK_OWNERSHIP");
  await code(x.store.locks.release(lock), "STORE_LOCK_OWNERSHIP");
  expect(await readFile(join(dir, "owner.json"))).toBeDefined();
});
test("lock replacement at final pre-rename barrier never advances HEAD", async () => {
  const x = await setup();
  const store = new FileSpecStore(x.root, { failpoint: async (p) => {
    if (p !== "before-head-rename") return;
    const dir = x.store.fs.paths.lock(x.result.spec_id), bytes = await readFile(join(dir, "owner.json"));
    await rename(dir, `${dir}.old`); await mkdir(dir); await writeFile(join(dir, "owner.json"), bytes);
  } });
  await code(store.commit(mutation(x.result)), "STORE_LOCK_OWNERSHIP");
  expect((await x.store.inspectHead(x.result.spec_id)).commit_id).toBe(x.result.commit_id);
});
test("mutation checks the destination mount, not only the project mount", async () => {
  const x = await setup(), inspected: string[] = [], check = x.store.fs.mutationSupport.bind(x.store.fs);
  const spy = spyOn(x.store.fs, "mutationSupport").mockImplementation(async (path) => { inspected.push(path); await check(path); });
  try { await x.store.commit(mutation(x.result)); } finally { spy.mockRestore(); }
  expect(inspected).toContain(x.store.fs.paths.root);
  expect(inspected).toContain(x.store.fs.paths.commits(x.result.spec_id));
});
test("nested blob prefix symlink is rejected", async () => {
  const x = await setup(), b = raw("nested path"), hash = await x.store.blobs.put(b.bytes);
  const prefix = join(x.store.fs.paths.root, "blobs", "sha256", hash.slice(7, 9));
  await rename(prefix, `${prefix}.old`); await symlink(`${prefix}.old`, prefix);
  await code(x.store.blobs.get(hash), "STORE_PATH_UNSAFE");
});
test("deep duplicate operation cannot hide behind several unique descendants", async () => {
  const x = await setup(); let result = x.result;
  for (let i = 0; i < 4; i++) result = await x.store.commit(mutation(result, `operation_${i}`, `Title ${i}`));
  const chain = [...await x.store.history(x.result.spec_id)].reverse();
  let parent = chain[0]!;
  for (let i = 1; i < chain.length; i++) {
    const c = commitSchema.parse(chain[i]);
    if (i === 1) c.payload.transaction.operation = parent.payload.transaction.operation;
    c.payload.parent = parent.id; c.payload.transaction.expected!.head = headSchema.parse(headOf(parent));
    c.payload.operation_hash = hashCanonical(c.payload.transaction); c.id = hashCanonical(c.payload);
    await writeFile(x.store.fs.paths.commit(x.result.spec_id, c.id), canonicalBytes(c)); parent = c;
  }
  await writeFile(x.store.fs.paths.head(x.result.spec_id), canonicalBytes(headOf(parent)));
  await code(x.store.verifySpecHistory(x.result.spec_id), "STORE_OPERATION_REUSE");
  await code(x.store.commit(mutation(result, "operation_later")), "STORE_OPERATION_REUSE");
});
test("HEAD generation vector must agree with the hashed aggregate", async () => {
  const x = await setup(); const h = { ...x.result.head, run_generations: [{ run: "run_ghost", generation: "0" }] };
  await writeFile(x.store.fs.paths.head(x.result.spec_id), canonicalBytes(h));
  await code(x.store.loadSpec(x.result.spec_id), "STORE_CORRUPT_HEAD");
});
test("run identity cannot be rebound even with schema-valid inputs and correct generations", async () => {
  const x = await setup(), request = withRun(x.result), running = await x.store.commit(request.transaction, request.blobs);
  const t = mutation(running, "operation_rebind"); t.mutation.kind = "spec-and-run"; t.mutation.runs = [request.run.id];
  t.state.runs[0]!.generation = "1" as never; t.state.runs[0]!.commit_sequence = "3" as never;
  t.state.runs[0]!.snapshot.generation = "0" as never; t.state.spec.run_binding!.snapshot = t.state.runs[0]!.snapshot;
  await code(x.store.commit(t), "STORE_INTEGRITY");
});
test("schema-valid rehashed commit with mismatched claim inputs fails current and deep loading", async () => {
  const x = await setup(), request = withRun(x.result), saved = await x.store.commit(request.transaction, request.blobs);
  const c = commitSchema.parse((await x.store.history(x.result.spec_id))[0]);
  const tasks = request.records.find((r) => r.schema === "aira.dev/tasks/v1");
  if (!tasks || tasks.schema !== "aira.dev/tasks/v1") throw Error("fixture");
  const run = c.payload.transaction.state.runs[0]!;
  run.claims.push(claimRecordSchema.parse({ schema: "aira.dev/task-claim/v1", id: "claim_bad", task: tasks.tasks[0]!.identity,
    run: run.id, attempt: "attempt_future", owner: "test", generation: "0",
    fence: { run: run.id, claim: "claim_bad", attempt: "attempt_future", owner: "test", epoch: "0" },
    snapshot: { ...run.snapshot, generation: "0" }, status: "active", lease: { issued_at: at, expires_at: "2026-08-27T12:00:00.000Z" } }));
  expect(commitSchema.safeParse(c).success).toBe(true);
  c.payload.operation_hash = hashCanonical(c.payload.transaction); c.id = hashCanonical(c.payload);
  await writeFile(x.store.fs.paths.commit(saved.spec_id, c.id), canonicalBytes(c));
  await writeFile(x.store.fs.paths.head(saved.spec_id), canonicalBytes(headOf(c)));
  for (const mode of ["current", "full", "deep"] as const) await code(x.store.loadSpec(saved.spec_id, mode), "STORE_INTEGRITY");
});
test("invalid lock identity cannot initialize v2 state before validation", async () => {
  const x = await temporary(); clean.push(x.cleanup);
  await code(x.store.locks.acquire("../unsafe" as never), "STORE_PATH_UNSAFE");
  expect(await x.store.fs.present(x.store.fs.paths.root)).toBe(false);
});
test("recovery cannot quarantine a same-token owner metadata replacement", async () => {
  const x = await setup(); await launch(x.root, "lock-die", x.result.spec_id).done();
  const owner = await x.store.locks.owner(x.result.spec_id), immutable = x.store.fs.immutable.bind(x.store.fs);
  const spy = spyOn(x.store.fs, "immutable").mockImplementation(async (path, bytes) => {
    await immutable(path, bytes);
    if (path.endsWith("/recovery/owner.json")) await writeFile(join(x.store.fs.paths.lock(x.result.spec_id), "owner.json"), canonicalBytes({ ...owner, acquired_at: "2001-01-01T00:00:00.000Z" }));
  });
  try { await code(x.store.recoverLock(x.result.spec_id), "STORE_LOCK_OWNERSHIP"); } finally { spy.mockRestore(); }
  expect(await x.store.locks.owner(x.result.spec_id)).not.toBeNull();
});
test("storage inventory never decodes current records under an unsupported FORMAT", async () => {
  const x = await setup(); await writeFile(join(x.store.fs.paths.root, "FORMAT"), canonicalBytes({ schema: "aira.dev/file-store/v99" }));
  const spy = spyOn(x.store.commits, "read").mockImplementation(async () => { throw Error("must not decode"); });
  try {
    const report = await inspectStorage(x.store); expect(report.complete).toBe(false);
    expect(report.entries).toEqual([{ path: "FORMAT", kind: "other", classification: "unknown", error: "STORE_SCHEMA_UNSUPPORTED" }]);
    expect(spy).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});
test("opaque future-schema-looking custom data does not change validation error taxonomy", () => {
  try {
    parseRecord({ schema: "aira.dev/workspace-handle/v1", provider_data: { nested: { schema: "aira.dev/vendor/v77" } } });
    throw Error("invalid record accepted");
  } catch (error) { expect(error).toMatchObject({ code: "STORE_INTEGRITY" }); }
});
test("corrupt current commit never falls forward to a valid higher-sequence orphan", async () => {
  const x = await setup();
  const store = new FileSpecStore(x.root, { failpoint: (p) => { if (p === "before-head-rename") throw Error("stop"); } });
  await code(store.commit(mutation(x.result)), "STORE_IO");
  const report = await inspectStorage(x.store);
  expect(report.entries.some((e) => e.kind === "commit" && e.classification === "orphaned")).toBe(true);
  expect(String((await x.store.loadSpec(x.result.spec_id)).head.sequence)).toBe("1");
  await writeFile(x.store.fs.paths.commit(x.result.spec_id, x.result.commit_id), canonicalBytes({ schema: "aira.dev/store-commit/v1" }));
  await code(x.store.loadSpec(x.result.spec_id), "STORE_CORRUPT_COMMIT");
  expect((await inspectStorage(x.store)).entries.some((e) => e.classification === "orphaned")).toBe(false);
});
