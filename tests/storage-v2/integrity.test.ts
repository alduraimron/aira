import { afterEach, expect, test } from "bun:test";
import { writeFile, readFile, unlink, rename, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { created, creation, temporary, mutation, code, raw, withRequirements } from "./fixtures";
import { canonicalBytes, hashCanonical } from "../../src/storage/file/canonical-json";
import { commitSchema, type StoreCommit } from "../../src/storage/types";
import { headOf } from "../../src/storage/transaction";
import { inspectStorage } from "../../src/storage/file/recovery";
import { specIdSchema } from "../../src/spec/domain/ids";
import { specKey, specIdFromKey } from "../../src/storage/file/paths";
import { withRun } from "./run-fixture";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
async function setup() { const x = await created(); clean.push(x.cleanup); return x; }
async function forge(x: Awaited<ReturnType<typeof setup>>, commit: ReturnType<typeof commitSchema.parse>) {
  commit.payload.operation_hash = hashCanonical(commit.payload.transaction); commit.id = hashCanonical(commit.payload);
  await writeFile(x.store.fs.paths.commit(x.result.spec_id, commit.id), canonicalBytes(commit));
  await writeFile(x.store.fs.paths.head(x.result.spec_id), canonicalBytes(headOf(commit))); return commit;
}

test.each(["nonexistent", "spec-id", "generation", "sequence", "version", "noncanonical", "malformed"])("HEAD tampering %s", async (kind) => {
  const x = await setup(); const head = { ...x.result.head };
  let expected = "STORE_CORRUPT_HEAD";
  if (kind === "nonexistent") { head.commit_id = raw("missing commit").hash; expected = "STORE_CORRUPT_COMMIT"; }
  if (kind === "spec-id") head.spec_id = specIdSchema.parse("spec_other");
  if (kind === "generation") head.spec_generation = "8" as never;
  if (kind === "sequence") head.sequence = "2" as never;
  if (kind === "version") { head.schema = "aira.dev/store-head/v2" as never; expected = "STORE_SCHEMA_UNSUPPORTED"; }
  await writeFile(x.store.fs.paths.head(x.result.spec_id), kind === "noncanonical" ? JSON.stringify(head, null, 2) : kind === "malformed" ? "{" : canonicalBytes(head));
  await code(x.store.loadSpec(x.result.spec_id), expected as never);
});
test.each(["bytes", "hash", "spec-id", "version", "nested-version", "unknown-key"])("commit tampering %s", async (kind) => {
  const x = await setup(), commit = commitSchema.parse((await x.store.history(x.result.spec_id))[0]!);
  let expected = "STORE_INTEGRITY";
  if (kind === "bytes") commit.payload.transaction.state.spec.title = "tampered";
  if (kind === "hash") commit.id = raw("wrong").hash;
  if (kind === "spec-id") commit.payload.spec_id = specIdSchema.parse("spec_other");
  if (kind === "version") { commit.schema = "aira.dev/store-commit/v999" as never; expected = "STORE_SCHEMA_UNSUPPORTED"; }
  if (kind === "nested-version") { commit.payload.transaction.state.spec.schema = "aira.dev/spec/v999" as never; expected = "STORE_SCHEMA_UNSUPPORTED"; }
  if (kind === "unknown-key") { Object.assign(commit.payload, { unexpected: true }); expected = "STORE_CORRUPT_COMMIT"; }
  await writeFile(x.store.fs.paths.commit(x.result.spec_id, x.result.commit_id), canonicalBytes(commit));
  await code(x.store.loadSpec(x.result.spec_id), expected as never);
});
test.each(["parent", "generation-jump", "duplicate-operation"])("deep verification rejects rehashed %s", async (kind) => {
  const x = await setup(); await x.store.commit(mutation(x.result));
  const commit = commitSchema.parse((await x.store.history(x.result.spec_id))[0]!);
  if (kind === "parent") commit.payload.parent = raw("absent parent").hash;
  if (kind === "generation-jump") { commit.payload.spec_generation = "9" as never; commit.payload.transaction.state.spec.generation = "9" as never; }
  if (kind === "duplicate-operation") commit.payload.transaction.operation = x.request.transaction.operation;
  await forge(x, commit);
  await code(x.store.verifySpecHistory(x.result.spec_id), kind === "duplicate-operation" ? "STORE_OPERATION_REUSE" : "STORE_CORRUPT_COMMIT");
});
test("immutable commit target collision never overwrites existing bytes", async () => {
  const x = await setup(); const commit = (await x.store.history(x.result.spec_id))[0]!;
  const path = x.store.fs.paths.commit(x.result.spec_id, commit.id); await writeFile(path, "different bytes");
  await code(x.store.commits.publish(commit), "STORE_INTEGRITY"); expect(await readFile(path, "utf8")).toBe("different bytes");
});
test("required structured artifact blob deletion fails full and current loads", async () => {
  const x = await setup(), request = withRequirements(mutation(x.result)); await x.store.commit(request.transaction, request.blobs);
  await unlink(x.store.fs.paths.blob(request.blobs[0]!.hash));
  await code(x.store.loadSpec(x.result.spec_id), "STORE_INTEGRITY"); await code(x.store.loadSpec(x.result.spec_id, "current"), "STORE_INTEGRITY");
});
test("ordinary current mode verifies records but may defer large raw blob hashing", async () => {
  const x = await setup(), t = mutation(x.result), blob = raw("large raw context or evidence bytes");
  t.state.blobs.push({ hash: blob.hash, bytes: blob.bytes.length, media_type: "application/octet-stream" });
  await x.store.commit(t, [blob]); await unlink(x.store.fs.paths.blob(blob.hash));
  expect((await x.store.loadSpec(x.result.spec_id, "current")).state).toEqual(t.state);
  await code(x.store.loadSpec(x.result.spec_id, "full"), "STORE_INTEGRITY");
});
test("pinned behavioral content cannot be missing or reattributed", async () => {
  const x = await setup(), request = withRun(x.result);
  const asset = request.records.find((r) => r.schema === "aira.dev/behavioral-asset/v1")!;
  if (asset.schema !== "aira.dev/behavioral-asset/v1") throw Error("fixture");
  const missing = request.blobs.filter((b) => b.hash !== asset.identity.hash);
  await code(x.store.commit(request.transaction, missing), "STORE_INTEGRITY");
  await x.store.commit(request.transaction, request.blobs); await writeFile(x.store.fs.paths.blob(asset.identity.hash), "tampered");
  await code(x.store.loadSpec(x.result.spec_id), "STORE_CORRUPT_BLOB");
});
test("incompatible behavioral pins fail before durable use, no default fallback", async () => {
  const x = await setup(), request = withRun(x.result);
  request.transaction.state.behavioral_environment!.domain_schema = "aira.dev/spec/v99";
  await code(x.store.commit(request.transaction, request.blobs), "STORE_INTEGRITY");
  expect((await x.store.inspectHead(x.result.spec_id)).commit_id).toBe(x.result.commit_id);
});
test.each(["../escape", "spec_a/../../bad", "spec_a\\bad", "SPEC_A", "spec_..", "spec_%2f"])("unsafe Spec ID %s", async (id) => {
  const x = await setup(); await code(x.store.loadSpec(id as never), "STORE_PATH_UNSAFE");
});
test("path encoding reversible and stable, with no raw ID directory component", () => {
  for (const text of ["spec_a", "spec_a-b_c", `spec_${"a".repeat(64)}`]) {
    const id = specIdSchema.parse(text), key = specKey(id);
    expect(key).toMatch(/^s-[0-9a-f]+$/); expect(specIdFromKey(key)).toBe(id); expect(key).not.toContain(text);
  }
  expect(() => specIdFromKey("s-2e2e2f")).toThrow();
});
test.each(["head", "commit", "spec-directory", "control-root", "locks"])("reject symlink substitution %s", async (kind) => {
  const x = await setup();
  const path = kind === "head" ? x.store.fs.paths.head(x.result.spec_id) : kind === "commit" ? x.store.fs.paths.commit(x.result.spec_id, x.result.commit_id) :
    kind === "spec-directory" ? x.store.fs.paths.spec(x.result.spec_id) : kind === "locks" ? x.store.fs.paths.locks() : x.store.fs.paths.root;
  const target = join(x.root, `displaced-${kind}`); await rename(path, target); await symlink(target, path);
  if (kind === "locks") await code(x.store.commit(mutation(x.result)), "STORE_PATH_UNSAFE");
  else await code(x.store.loadSpec(x.result.spec_id), "STORE_PATH_UNSAFE");
});
test("inspection marks corrupt roots and does not call their blobs safe orphans", async () => {
  const x = await setup(); await writeFile(x.store.fs.paths.head(x.result.spec_id), "bad");
  const inspection = await inspectStorage(x.store); expect(inspection.complete).toBe(false);
  expect(inspection.entries.some((e) => e.kind === "head" && e.classification === "corrupt")).toBe(true);
  expect(inspection.entries.some((e) => e.classification === "orphaned")).toBe(false);
});
