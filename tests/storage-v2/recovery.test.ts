import { afterEach, expect, test, spyOn } from "bun:test";
import { writeFile, readdir, unlink, mkdir, mkdtemp, rm, statfs, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { created, creation, mutation, temporary, code, raw } from "./fixtures";
import { FileSpecStore } from "../../src/storage/file/spec-store";
import { fileStoreFormat, type Failpoint } from "../../src/storage/file/fsync";
import { canonicalBytes } from "../../src/storage/file/canonical-json";
import { inspectStorage } from "../../src/storage/file/recovery";
import { launch } from "./processes";
import { lockMetadataSchema } from "../../src/storage/file/locks";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
async function setup() { const x = await created(); clean.push(x.cleanup); return x; }
const boundaries: Failpoint[] = ["after-lock-acquisition", "after-blob-publication", "after-commit-publication", "after-head-temp-write",
  "after-head-temp-fsync", "before-head-rename", "after-head-rename", "after-head-directory-fsync", "before-lock-release"];

test("publication boundaries are ordered, durable directory sync precedes acknowledgement/release", async () => {
  const x = await setup(), trace: string[] = [];
  const store = new FileSpecStore(x.root, { failpoint: (point) => { trace.push(point); } });
  const sync = store.fs.syncDir.bind(store.fs);
  const spy = spyOn(store.fs, "syncDir").mockImplementation(async (path) => { await sync(path); trace.push(`sync:${path}`); });
  try { await store.commit(mutation(x.result)); } finally { spy.mockRestore(); }
  expect(trace.filter((p) => !p.startsWith("sync:"))).toEqual(boundaries);
  const renamed = trace.indexOf("after-head-rename"), durable = trace.indexOf("after-head-directory-fsync");
  expect(trace.slice(renamed, durable)).toContain(`sync:${store.fs.paths.spec(x.result.spec_id)}`);
});
for (const boundary of boundaries) test(`injected I/O failure at ${boundary} never acknowledges partial state`, async () => {
  const x = await setup();
  const store = new FileSpecStore(x.root, { failpoint: (point) => { if (point === boundary) throw Object.assign(Error("injected I/O failure"), { code: "EIO" }); } });
  await code(store.commit(mutation(x.result)), "STORE_IO");
  const current = await x.store.loadSpec(x.result.spec_id);
  const after = ["after-head-rename", "after-head-directory-fsync", "before-lock-release"].includes(boundary);
  expect(String(current.head.sequence)).toBe(after ? "2" : "1");
  expect(await x.store.locks.owner(x.result.spec_id)).toBeNull();
});
test("failure of final HEAD directory fsync leaves committed authority but no success acknowledgement", async () => {
  const x = await setup(); let renamed = false;
  const store = new FileSpecStore(x.root, { failpoint: (point) => { if (point === "after-head-rename") renamed = true; } });
  const sync = store.fs.syncDir.bind(store.fs);
  const spy = spyOn(store.fs, "syncDir").mockImplementation(async (path) => {
    if (renamed && path === store.fs.paths.spec(x.result.spec_id)) { renamed = false; throw Object.assign(Error("fsync EIO"), { code: "EIO" }); }
    await sync(path);
  });
  try { await code(store.commit(mutation(x.result)), "STORE_IO"); } finally { spy.mockRestore(); }
  expect(String((await x.store.inspectHead(x.result.spec_id)).sequence)).toBe("2");
  expect((await x.store.commit(mutation(x.result))).replayed).toBe(true);
});
test("orphan/temporary/unknown inspection never promotes or deletes", async () => {
  const x = await setup(), blob = raw("unreachable raw bytes"); await x.store.blobs.put(blob.bytes);
  const store = new FileSpecStore(x.root, { failpoint: (point) => { if (point === "before-head-rename") throw Error("crash boundary"); } });
  await code(store.commit(mutation(x.result)), "STORE_IO");
  await writeFile(join(x.store.fs.paths.spec(x.result.spec_id), "operator-note"), "not authoritative");
  const paths = await readdir(x.store.fs.paths.spec(x.result.spec_id));
  const report = await inspectStorage(x.store);
  expect(report.entries.some((e) => e.kind === "commit" && e.classification === "orphaned")).toBe(true);
  expect(report.entries.some((e) => e.kind === "blob" && e.classification === "orphaned")).toBe(true);
  expect(report.entries.some((e) => e.classification === "temporary")).toBe(true);
  expect(report.entries.some((e) => e.classification === "unknown")).toBe(true);
  expect((await x.store.loadSpec(x.result.spec_id)).head.commit_id).toBe(x.result.commit_id);
  expect(await readdir(x.store.fs.paths.spec(x.result.spec_id))).toEqual(paths);
});
test("unknown/missing FORMAT never silently migrates, repairs or dispatches as current", async () => {
  const x = await setup(), path = join(x.store.fs.paths.root, "FORMAT");
  await writeFile(path, canonicalBytes({ ...fileStoreFormat, schema: "aira.dev/file-store/v2" }));
  await code(x.store.loadSpec(x.result.spec_id), "STORE_SCHEMA_UNSUPPORTED"); await code(x.store.commit(mutation(x.result)), "STORE_SCHEMA_UNSUPPORTED");
  await code(x.store.loadSpec(creation("spec_absent").transaction.spec_id), "STORE_SCHEMA_UNSUPPORTED");
  await code(x.store.blobs.get(raw("absent blob").hash), "STORE_SCHEMA_UNSUPPORTED");
  await unlink(path); await code(x.store.loadSpec(x.result.spec_id), "STORE_SCHEMA_UNSUPPORTED");
  await code(x.store.blobs.put(raw("no migration").bytes), "STORE_SCHEMA_UNSUPPORTED");
});
test("fully identified dead cleaner can itself be recovered, no time-based stealing", async () => {
  const x = await setup(); await launch(x.root, "lock-die", x.result.spec_id).done();
  const owner = (await x.store.locks.owner(x.result.spec_id))!;
  const path = join(x.store.fs.paths.lock(x.result.spec_id), "recovery"); await mkdir(path);
  await writeFile(join(path, "owner.json"), canonicalBytes(lockMetadataSchema.parse({ ...owner, owner: "e".repeat(48) })));
  expect(await x.store.locks.recover(x.result.spec_id)).toBe(true);
  const lock = await x.store.locks.acquire(x.result.spec_id); await x.store.locks.release(lock);
});
test("known volatile temporary filesystems fail closed without a durability bypass", async () => {
  if (![0x01021994, 0x858458f6].includes((await statfs(tmpdir())).type >>> 0)) return;
  const root = await mkdtemp(join(await realpath(tmpdir()), "aira-volatile-test-"));
  clean.push(() => rm(root, { recursive: true, force: true }));
  await code(new FileSpecStore(root).blobs.put(raw("cannot survive OS loss").bytes), "STORE_DURABILITY_UNSUPPORTED");
  expect(await readdir(root)).toEqual([]);
});
test.each(["noFollow", "directorySync", "atomicReplace", "exclusiveLink"] as const)("unsupported durability capability %s", async (missing) => {
  const x = await temporary({ capabilities: () => ({ noFollow: true, directorySync: true, atomicReplace: true, exclusiveLink: true, [missing]: false }) }); clean.push(x.cleanup);
  const request = creation(); await code(x.store.createSpec(request.transaction, request.blobs), "STORE_DURABILITY_UNSUPPORTED");
  expect(await readdir(x.root)).toEqual([]);
});
