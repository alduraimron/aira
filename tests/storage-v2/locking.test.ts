import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { created, code, mutation } from "./fixtures";
import { lockMetadataSchema } from "../../src/storage/file/locks";
import { canonicalBytes } from "../../src/storage/file/canonical-json";
import { launch } from "./processes";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
async function setup() { const x = await created({ lockTimeoutMs: 20 }); clean.push(x.cleanup); return x; }

test("non-owner cannot release another process/session lock", async () => {
  const x = await setup(), lock = await x.store.locks.acquire(x.result.spec_id);
  await code(x.store.locks.release({ ...lock, owner: "0".repeat(48) }), "STORE_LOCK_OWNERSHIP");
  expect((await x.store.locks.owner(x.result.spec_id))?.owner).toBe(lock.owner); await x.store.locks.release(lock);
  await code(x.store.locks.release(lock), "STORE_LOCK_OWNERSHIP");
});
test("live PID lock is never stolen, even with ancient acquisition time", async () => {
  const x = await setup(), lock = await x.store.locks.acquire(x.result.spec_id), path = join(x.store.fs.paths.lock(lock.spec), "owner.json");
  const owner = await x.store.locks.owner(lock.spec);
  await writeFile(path, canonicalBytes({ ...owner, acquired_at: "2000-01-01T00:00:00.000Z" }));
  await code(x.store.locks.recover(lock.spec), "STORE_LOCKED"); await code(x.store.commit(mutation(x.result)), "STORE_LOCKED");
  await x.store.locks.release(lock);
});
test("a dead local process owner can be recovered explicitly", async () => {
  const x = await setup(); await launch(x.root, "lock-die", x.result.spec_id).done();
  const before = await x.store.locks.owner(x.result.spec_id); expect(before?.pid).not.toBe(process.pid);
  expect(await x.store.locks.recover(x.result.spec_id)).toBe(true);
  expect(await x.store.locks.owner(x.result.spec_id)).toBeNull();
  const lock = await x.store.locks.acquire(x.result.spec_id); expect(lock.owner).not.toBe(before?.owner); await x.store.locks.release(lock);
});
test("remote hostname, live/reused PID, ownerless and corrupt metadata fail closed", async () => {
  const x = await setup(), lock = await x.store.locks.acquire(x.result.spec_id), owner = await x.store.locks.owner(lock.spec);
  const path = join(x.store.fs.paths.lock(lock.spec), "owner.json");
  await writeFile(path, canonicalBytes({ ...owner, hostname: "other-host.invalid" })); await code(x.store.locks.recover(lock.spec), "STORE_LOCKED");
  await writeFile(path, "{"); await code(x.store.locks.recover(lock.spec), "STORE_LOCKED");
});
test("same hostname with a foreign/unknown process table is never considered demonstrably dead", async () => {
  const x = await setup(); await launch(x.root, "lock-die", x.result.spec_id).done();
  const owner = await x.store.locks.owner(x.result.spec_id), path = join(x.store.fs.paths.lock(x.result.spec_id), "owner.json");
  for (const process_scope of [null, "different-pid-namespace"]) {
    await writeFile(path, canonicalBytes({ ...owner, process_scope }));
    await code(x.store.recoverLock(x.result.spec_id), "STORE_LOCKED");
  }
});
test("unknown lock version is a typed incompatible schema", async () => {
  const x = await setup(), lock = await x.store.locks.acquire(x.result.spec_id), owner = await x.store.locks.owner(lock.spec);
  await writeFile(join(x.store.fs.paths.lock(lock.spec), "owner.json"), canonicalBytes({ ...owner, schema: "aira.dev/store-lock/v2" }));
  await code(x.store.locks.recover(lock.spec), "STORE_SCHEMA_UNSUPPORTED");
});
test("ownerless creation and abandoned cleaner require inspection, not clock-based stealing", async () => {
  const x = await setup(); await mkdir(x.store.fs.paths.lock(x.result.spec_id));
  await code(x.store.locks.recover(x.result.spec_id), "STORE_LOCKED");
});
test("an interrupted stale-lock cleaner is conservative busy and read-only diagnostics survive", async () => {
  const x = await setup(); await launch(x.root, "lock-die", x.result.spec_id).done();
  const path = x.store.fs.paths.lock(x.result.spec_id), bytes = await readFile(join(path, "owner.json"));
  await mkdir(join(path, "recovery")); await code(x.store.locks.recover(x.result.spec_id), "STORE_LOCKED");
  expect(await readFile(join(path, "owner.json"))).toEqual(bytes);
});
