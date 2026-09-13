import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { temporary, created, mutation, code, raw } from "./fixtures";
import { StorageError } from "../../src/storage/errors";
import { checkEvolution } from "../../src/storage/transaction";
import { commitSequenceSchema } from "../../src/spec/domain/generations";
import { stateSchema } from "../../src/storage/types";
const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });

test.each(["darwin", "win32"])("uncertified %s mutation is rejected even with an all-true primitive probe", async (platform) => {
  const x = await temporary({ capabilities: () => ({ noFollow: true, directorySync: true, atomicReplace: true, exclusiveLink: true }) }); clean.push(x.cleanup);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    await code(x.store.blobs.put(raw("no weaker semantics").bytes), "STORE_DURABILITY_UNSUPPORTED");
  } finally { Object.defineProperty(process, "platform", descriptor); }
  expect(await readdir(x.root)).toEqual([]);
});
test("incomplete capability result is not vacuously supported", async () => {
  const x = await temporary({ capabilities: () => ({} as never) }); clean.push(x.cleanup);
  await code(x.store.blobs.put(raw("required capabilities missing").bytes), "STORE_DURABILITY_UNSUPPORTED"); expect(await readdir(x.root)).toEqual([]);
});
test("unsupported nested destination capability blocks publication without changing HEAD", async () => {
  const x = await created(); clean.push(x.cleanup);
  const support = x.store.fs.mutationSupport.bind(x.store.fs), head = x.result.head;
  const spy = spyOn(x.store.fs, "mutationSupport").mockImplementation(async (path) => {
    if (path === x.store.fs.paths.commits(x.result.spec_id)) throw new StorageError("STORE_DURABILITY_UNSUPPORTED", "Synthetic unsupported destination mount");
    await support(path);
  });
  try { await code(x.store.commit(mutation(x.result)), "STORE_DURABILITY_UNSUPPORTED"); } finally { spy.mockRestore(); }
  expect(await x.store.inspectHead(x.result.spec_id)).toEqual(head);
});
test("conflicting state-version roots fail mutation closed", async () => {
  const x = await created(); clean.push(x.cleanup); await mkdir(join(x.store.fs.paths.project, ".aira/state/v3"));
  await code(x.store.commit(mutation(x.result)), "STORE_SCHEMA_UNSUPPORTED");
  expect(await x.store.inspectHead(x.result.spec_id)).toEqual(x.result.head);
});
test("SpecGeneration overflow cannot wrap or be published as unchanged", async () => {
  const x = await created(); clean.push(x.cleanup);
  const previous = stateSchema.parse(x.result.state); previous.spec.generation = "18446744073709551615" as never;
  const t = mutation(x.result); t.state.spec.generation = previous.spec.generation;
  expect(() => checkEvolution(t, previous, commitSequenceSchema.parse("2"))).toThrow("Invalid SpecGeneration");
  t.state.spec.generation = "18446744073709551616" as never; expect(stateSchema.safeParse(t.state).success).toBe(false);
});
