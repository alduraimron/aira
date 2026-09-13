import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile, rm, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { detectReadFormat, type ReadLayout, type ProjectReadFormat } from "../../src/compatibility/format";
import { fileCompatibilityQueries } from "../../src/compatibility/file";
import { CompatibilityQueries } from "../../src/compatibility/query";
import { fileStoreFormat } from "../../src/storage/format";
import { canonicalBytes } from "../../src/storage/file/canonical-json";
import { FileSpecStore } from "../../src/storage/file/spec-store";
import { creation } from "../storage-v2/fixtures";
import { project, at, ids } from "./fixtures";
const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
async function setup() { const x = await project(); clean.push(x.cleanup); return x; }
async function v2(x: Awaited<ReturnType<typeof setup>>) { const store = new FileSpecStore(x.root), request = creation();
  const result = await store.createSpec(request.transaction, request.blobs); return { store, request, result }; }

test("no Aira state vs ambiguous empty control root vs legacy project", async () => {
  const x = await setup(); expect((await detectReadFormat(x.layout)).kind).toBe("legacy-v1");
  await rm(join(x.root, ".aira"), { recursive: true }); expect((await detectReadFormat(x.layout)).kind).toBe("none");
  expect(await readdir(x.root)).toEqual([]); await mkdir(join(x.root, ".aira")); expect((await detectReadFormat(x.layout)).kind).toBe("ambiguous");
  await writeFile(join(x.root, ".aira/config.yaml"), "broken: ["); expect((await detectReadFormat(x.layout)).kind).toBe("legacy-v1");
});
test("supported v2 FORMAT is strict and independent of state existence", async () => {
  const x = await setup(); await rm(join(x.root, ".aira/runs"), { recursive: true }); await v2(x);
  expect((await detectReadFormat(x.layout)).kind).toBe("v2");
  const q = await fileCompatibilityQueries(x.root, "project_test").list(at);
  expect(q.items.map((i) => i.kind)).toEqual(["v2-spec"]);
});
test.each(["version", "unknown-field", "noncanonical", "malformed", "wrong-store", "missing", "symlink"])("explicit dispatch rejects FORMAT %s", async (kind) => {
  const x = await setup(), storage = await v2(x), path = join(storage.store.fs.paths.root, "FORMAT");
  let expected: ProjectReadFormat["kind"] = "corrupt-v2";
  if (kind === "version") { await writeFile(path, JSON.stringify({ schema: "aira.dev/file-store/v99", future_encoding: "do-not-decode" })); expected = "unsupported-v2"; }
  if (kind === "unknown-field") await writeFile(path, canonicalBytes({ ...fileStoreFormat, extra: true }));
  if (kind === "wrong-store") await writeFile(path, canonicalBytes({ ...fileStoreFormat, store: "v1" }));
  if (kind === "noncanonical") await writeFile(path, JSON.stringify(fileStoreFormat, null, 2));
  if (kind === "malformed") await writeFile(path, "{");
  if (kind === "missing") { await rm(path); expected = "ambiguous"; }
  if (kind === "symlink") { await rm(path); await writeFile(join(x.root, "marker"), canonicalBytes(fileStoreFormat)); await symlink(join(x.root, "marker"), path); expected = "ambiguous"; }
  expect((await detectReadFormat(x.layout)).kind).toBe(expected);
  const result = await fileCompatibilityQueries(x.root, "project_test").list(at);
  expect(result.items.filter((i) => i.kind === "legacy-v1-run").length).toBe(1);
  expect(result.items.some((i) => i.kind === "v2-spec")).toBe(false);
  expect(result.failures.some((f) => f.source_format === "v2")).toBe(true);
});
test("future FORMAT returns unsupported without asking a current-state decoder", async () => {
  const x = await setup(); await v2(x); await writeFile(join(x.root, ".aira/state/v2/FORMAT"), '{"schema":"aira.dev/file-store/v5"}');
  let decoded = false;
  const queries = new CompatibilityQueries(() => detectReadFormat(x.layout), x.reader, {
    async list() { decoded = true; throw Error("forbidden"); }, async load() { decoded = true; throw Error("forbidden"); },
  });
  const result = await queries.list(at); expect(result.format.kind).toBe("unsupported-v2"); expect(decoded).toBe(false);
});
test("mixed projects retain separate item semantics and full v2 details", async () => {
  const x = await setup(), storage = await v2(x), q = fileCompatibilityQueries(x.root, "project_test"), result = await q.list(at);
  expect(result.format.kind).toBe("mixed"); expect(result.items.map((i) => i.kind)).toEqual(["legacy-v1-run", "v2-spec"]);
  const legacy = await q.legacyDetail(ids[5]!, at); expect(legacy.mutable).toBe(false); expect(legacy.resumable).toBe(false); expect(legacy.importable).toBe(true);
  const spec = await q.specDetail(storage.result.spec_id); expect(spec.mutable).toBe(true); expect(spec.resumable).toBe(false); expect(spec.importable).toBe(false);
  expect(spec.snapshot).toEqual(await storage.store.loadSpec(storage.result.spec_id));
});
test("corrupt legacy run does not destroy v2 readability", async () => {
  const x = await setup(); await v2(x); await writeFile(join(x.root, ".aira/runs", ids[5]!, "run.json"), "broken");
  const result = await fileCompatibilityQueries(x.root, "project_test").list(at);
  expect(result.items.find((i) => i.kind === "legacy-v1-run")?.importable).toBe(false);
  expect(result.items.some((i) => i.kind === "v2-spec")).toBe(true);
});
test("corrupt authoritative v2 commit fails closed while v1 remains readable", async () => {
  const x = await setup(), storage = await v2(x);
  await writeFile(storage.store.fs.paths.commit(storage.result.spec_id, storage.result.commit_id), "bad");
  const result = await fileCompatibilityQueries(x.root, "project_test").list(at);
  expect(result.items.map((i) => i.kind)).toEqual(["legacy-v1-run"]);
  expect(result.failures.some((f) => f.code === "STORE_CORRUPT_COMMIT")).toBe(true);
  await expect(storage.store.commit(storage.request.transaction, storage.request.blobs)).rejects.toMatchObject({ code: "STORE_CORRUPT_COMMIT" });
});
test("conflicting version roots, unexpected authority marker and unsafe namespace are ambiguous", async () => {
  const x = await setup(); await v2(x); await mkdir(join(x.root, ".aira/state/v3"));
  expect((await detectReadFormat(x.layout)).kind).toBe("ambiguous");
  await rm(join(x.root, ".aira/state/v3"), { recursive: true }); await writeFile(join(x.root, ".aira/FORMAT"), "conflicting");
  expect((await detectReadFormat(x.layout)).kind).toBe("ambiguous");
});
test("orphan spec directories and materialized files never become history items", async () => {
  const x = await setup(), storage = await v2(x), orphan = creation("spec_orphan").transaction.spec_id;
  await storage.store.fs.ensureDir(storage.store.fs.paths.spec(orphan)); await writeFile(join(storage.store.fs.paths.spec(orphan), "spec.yaml"), "not authority");
  const result = await fileCompatibilityQueries(x.root, "project_test").list(at);
  expect(result.items.filter((i) => i.kind === "v2-spec").length).toBe(1);
  expect(result.failures.some((f) => f.code === "QUERY_NONAUTHORITATIVE_DIRECTORY")).toBe(true);
});
test("provider-neutral dispatch works with an in-memory layout port", async () => {
  const layout: ReadLayout = { async kind(path) { return path === ".aira" || path === ".aira/runs" ? "directory" : "missing"; }, async list() { return ["runs"]; }, async read() { throw Error("should not read config"); } };
  expect((await detectReadFormat(layout)).kind).toBe("legacy-v1");
});
