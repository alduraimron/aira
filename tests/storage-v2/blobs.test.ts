import { afterEach, expect, test } from "bun:test";
import { writeFile, symlink, readFile } from "node:fs/promises";
import { temporary, code, raw } from "./fixtures";
import { hashBytes } from "../../src/storage/file/canonical-json";
import type { ContentHash } from "../../src/spec/domain/primitives";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
async function setup() { const x = await temporary(); clean.push(x.cleanup); return x; }

test("BlobStore exact bytes, empty content, exists and verify", async () => {
  const { store } = await setup();
  for (const input of [new Uint8Array(), new Uint8Array([0, 255, 13, 10]), raw("hello\r\n").bytes]) {
    const hash = await store.blobs.put(input); expect(hash).toBe(hashBytes(input));
    expect(await store.blobs.get(hash)).toEqual(input); expect(await store.blobs.exists(hash)).toBe(true);
    expect(await store.blobs.verify(hash)).toEqual({ hash, bytes: input.length });
  }
});
test("BlobStore does not silently coerce non-byte input", async () => {
  const { store } = await setup(); await code(store.blobs.put("not bytes" as never), "STORE_INTEGRITY");
});
test("missing blob is distinct from corruption", async () => {
  const { store } = await setup(), hash = raw("missing").hash;
  expect(await store.blobs.exists(hash)).toBe(false); await code(store.blobs.get(hash), "STORE_NOT_FOUND");
});
test("idempotent concurrent immutable put never exposes partial bytes", async () => {
  const { store } = await setup(), bytes = new Uint8Array(1024 * 1024).fill(199);
  const hashes = await Promise.all(Array.from({ length: 8 }, () => store.blobs.put(bytes)));
  expect(new Set(hashes).size).toBe(1); expect(await store.blobs.get(hashes[0]!)).toEqual(bytes);
});
test("put snapshots caller memory before yielding", async () => {
  const { store } = await setup(), bytes = raw("hello").bytes, copy = bytes.slice();
  const put = store.blobs.put(bytes); bytes.fill(0);
  expect(await store.blobs.get(await put)).toEqual(copy);
});
test("tampered blob fails get, exists and republish without overwrite", async () => {
  const { store } = await setup(), input = raw("right"), hash = await store.blobs.put(input.bytes), path = store.fs.paths.blob(hash);
  await writeFile(path, "wrong");
  await code(store.blobs.get(hash), "STORE_CORRUPT_BLOB"); await code(store.blobs.exists(hash), "STORE_CORRUPT_BLOB");
  await code(store.blobs.put(input.bytes), "STORE_INTEGRITY"); expect(await readFile(path, "utf8")).toBe("wrong");
});
test.each(["../../escape", "sha256:../x", `sha256:${"A".repeat(64)}`, `sha256:${"0".repeat(63)}`])("unsafe hash rejected %s", async (hash) => {
  const { store } = await setup(); await code(store.blobs.get(hash as ContentHash), "STORE_PATH_UNSAFE");
});
test("reject symlinked immutable target", async () => {
  const { root, store } = await setup(), input = raw("right");
  await store.fs.prepare(); await store.fs.ensureDir(store.fs.paths.blob(input.hash).split("/").slice(0, -1).join("/"));
  const outside = `${root}/outside`; await writeFile(outside, input.bytes); await symlink(outside, store.fs.paths.blob(input.hash));
  await code(store.blobs.get(input.hash), "STORE_PATH_UNSAFE"); await code(store.blobs.put(input.bytes), "STORE_PATH_UNSAFE");
});
test("required filesystem capability mismatch fails before publication", async () => {
  const x = await temporary({ capabilities: () => ({ noFollow: true, directorySync: false, atomicReplace: true, exclusiveLink: true }) }); clean.push(x.cleanup);
  await code(x.store.blobs.put(raw("no").bytes), "STORE_DURABILITY_UNSUPPORTED");
});
