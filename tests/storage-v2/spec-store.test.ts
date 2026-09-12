import { afterEach, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { created, creation, temporary, mutation, code, withRequirements, raw } from "./fixtures";
import { transactionSchema } from "../../src/storage/types";
import { operationIdSchema } from "../../src/spec/domain/ids";
import { FileSpecStore } from "../../src/storage/file/spec-store";
import { canonicalBytes, encodeRecord } from "../../src/storage/file/canonical-json";
import { revisionRequestSchema } from "../../src/revision/schema";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); });
async function setup() { const x = await created(); cleanup.push(x.cleanup); return x; }

test("genesis and semantic mutation preserve full Spec, sequences, generations and audit", async () => {
  const { store, result, root } = await setup();
  expect(String(result.sequence)).toBe("1"); expect(String(result.spec_generation)).toBe("0"); expect(String(result.run_generation)).toBe("0");
  const t = mutation(result); t.state.spec.metadata.description = "Exact metadata\n";
  const next = await store.commit(t); expect(String(next.sequence)).toBe("2"); expect(String(next.spec_generation)).toBe("1"); expect(next.replayed).toBe(false);
  expect((await new FileSpecStore(root).loadSpec(result.spec_id)).state).toEqual(t.state);
  const history = await store.history(result.spec_id); expect(history.map((c) => String(c.payload.sequence))).toEqual(["2", "1"]);
  expect(history[0]!.payload.transaction.events).toEqual(t.events); expect(history[0]!.payload.transaction.actor).toEqual(t.actor);
  expect((await store.verifySpecHistory(result.spec_id)).commits).toBe(2);
});
test("audit-only transaction advances only CommitSequence", async () => {
  const { store, result } = await setup(); const next = await store.commit(mutation(result, "operation_audit", "unused", true));
  expect(String(next.sequence)).toBe("2"); expect(String(next.spec_generation)).toBe("0"); expect(next.state).toEqual(result.state);
});
test("same OperationId and exact intent returns exact old result even after later commits", async () => {
  const { store, result, request } = await setup();
  const first = await store.commit(mutation(result)); const second = await store.commit(mutation(first, "operation_second", "second"));
  const replay = await store.commit(mutation(result));
  expect({ ...replay, replayed: false }).toEqual(first);
  const createReplay = await store.createSpec(request.transaction, request.blobs);
  expect(createReplay.commit_id).toBe(result.commit_id); expect(createReplay.replayed).toBe(true);
  expect((await store.inspectHead(result.spec_id)).commit_id).toBe(second.commit_id);
  expect((await store.history(result.spec_id)).length).toBe(3);
});
test("operation reuse changed state or preconditions rejected before stale CAS", async () => {
  const { store, result } = await setup(); const first = await store.commit(mutation(result));
  await code(store.commit(mutation(result, "operation_edit", "different")), "STORE_OPERATION_REUSE");
  await code(store.commit(mutation(first, "operation_edit")), "STORE_OPERATION_REUSE");
});
test("creation is absence CAS; directories do not imply Spec existence", async () => {
  const x = await temporary(); cleanup.push(x.cleanup); const { transaction, blobs } = creation();
  await x.store.fs.prepare(); await x.store.fs.ensureDir(x.store.fs.paths.commits(transaction.spec_id));
  await code(x.store.loadSpec(transaction.spec_id), "STORE_NOT_FOUND"); await x.store.createSpec(transaction, blobs);
  await code(x.store.createSpec({ ...transaction, operation: operationIdSchema.parse("operation_other") }, blobs), "STORE_ALREADY_EXISTS");
});
test.each(["head", "spec-generation", "run-generations", "artifacts"])("stale %s rejected", async (kind) => {
  const { store, result } = await setup(), t = mutation(result);
  if (kind === "head") await store.commit(mutation(result, "operation_win"));
  if (kind === "spec-generation") t.expected!.head.spec_generation = "9" as never;
  if (kind === "run-generations") t.expected!.head.run_generations.push({ run: "run_no" as never, generation: "1" as never });
  if (kind === "artifacts") t.expected!.current_artifacts = withRequirements(t).transaction.state.spec.artifacts.current;
  await code(store.commit(t), "STORE_CONFLICT");
});
test("CAS cannot be omitted and run-only cannot mutate Spec", async () => {
  const { store, result } = await setup(); const { expected: _, ...bad } = mutation(result);
  await code(store.commit(bad as never), "STORE_INTEGRITY");
  const t = mutation(result, "operation_audit", "unused", true); t.state.spec.title = "sneaky";
  await code(store.commit(t), "STORE_CONFLICT");
});
test("artifact exact bytes, metadata, findings-ready references and lineage survive publication", async () => {
  const { store, result } = await setup(); const next = withRequirements(mutation(result));
  const saved = await store.commit(next.transaction, next.blobs);
  expect(saved.records).toEqual([next.document, next.revision]);
  expect(saved.state.spec.artifacts.current).toEqual(next.transaction.state.spec.artifacts.current);
  expect((await store.verifySpecHistory(result.spec_id)).records).toBe(2);
});
test("named revision cannot be overwritten under a different content hash", async () => {
  const { store, result } = await setup(); const next = withRequirements(mutation(result)); const saved = await store.commit(next.transaction, next.blobs);
  const t = mutation(saved, "operation_rewrite");
  const changed = encodeRecord({ ...next.revision, created: { ...next.revision.created, at: "2026-08-26T12:00:01.000Z" } });
  t.state.records[1] = changed.reference;
  await code(store.commit(t, [{ hash: changed.reference.hash, bytes: changed.bytes }]), "STORE_INTEGRITY");
});
test("revision feedback exact whitespace persists as a first-class strict domain record", async () => {
  const { store, result } = await setup(), a = withRequirements(mutation(result)); const saved = await store.commit(a.transaction, a.blobs);
  const request = revisionRequestSchema.parse({ schema: "aira.dev/revision-request/v1", id: "revision_feedback", spec_id: result.spec_id,
    previous_artifact: saved.state.spec.artifacts.current[0]!.artifact, feedback: "  Preserve this feedback.\r\n\n", actor: { kind: "human", id: "local" },
    requested_at: "2026-08-26T12:00:00.000Z", operation: "operation_feedback", status: "pending" });
  const record = encodeRecord(request), t = mutation(saved, "operation_feedback");
  t.state.records.push(record.reference); t.state.spec.revisions.push(request.id);
  const published = await store.commit(t, [{ hash: record.reference.hash, bytes: record.bytes }]);
  expect(published.records.at(-1)).toEqual(request);
});
test("required missing blob and incorrect byte length fail before HEAD", async () => {
  const { store, result } = await setup(), t = mutation(result), blob = raw("audit data");
  t.events[0]!.payloads.push({ hash: blob.hash, bytes: blob.bytes.length, media_type: "text/plain" });
  await code(store.commit(t), "STORE_INTEGRITY");
  t.events[0]!.payloads[0]!.bytes++;
  await code(store.commit(t, [blob]), "STORE_INTEGRITY"); expect((await store.inspectHead(result.spec_id)).commit_id).toBe(result.commit_id);
});
test("clock order is not commit order", async () => {
  const { store, result, root } = await setup(); const back = new FileSpecStore(root, { clock: () => "2020-01-01T00:00:00.000Z" });
  expect(String((await back.commit(mutation(result))).sequence)).toBe("2"); expect((await store.history(result.spec_id))[0]!.payload.at).toStartWith("2020");
});
test("input snapshots detach before first await", async () => {
  const { store, result } = await setup(), t = mutation(result); const promise = store.commit(t); t.state.spec.title = "changed during await";
  expect((await promise).state.spec.title).toBe("Updated title");
});
test("history pagination and operation lookup are rooted at HEAD", async () => {
  const { store, result } = await setup(); const next = await store.commit(mutation(result));
  expect((await store.history(result.spec_id, { limit: 1 })).map((c) => c.id)).toEqual([next.commit_id]);
  expect((await store.history(result.spec_id, { before: next.commit_id })).map((c) => c.id)).toEqual([result.commit_id]);
  expect((await store.findCommittedOperation(result.spec_id, operationIdSchema.parse("operation_edit")))?.id).toBe(next.commit_id);
  expect(await store.findCommittedOperation(result.spec_id, operationIdSchema.parse("operation_missing"))).toBeNull();
});
test("reads do not create storage, migrate, rewrite bytes or clean artifacts", async () => {
  const x = await temporary(); cleanup.push(x.cleanup);
  await code(x.store.loadSpec(creation().transaction.spec_id), "STORE_NOT_FOUND"); expect(await readdir(x.root)).toEqual([]);
  const { transaction, blobs } = creation(); await x.store.createSpec(transaction, blobs);
  const path = x.store.fs.paths.head(transaction.spec_id), before = await readFile(path);
  await x.store.loadSpec(transaction.spec_id, "deep"); expect(await readFile(path)).toEqual(before);
  expect(canonicalBytes((await x.store.inspectHead(transaction.spec_id)))).toEqual(new Uint8Array(before));
});
