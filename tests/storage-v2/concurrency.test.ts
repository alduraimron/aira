import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { created, creation, mutation, code, temporary } from "./fixtures";
import { launch, requestFile } from "./processes";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
async function setup() { const x = await created(); clean.push(x.cleanup); return x; }

test.each([true, false])("fresh-store concurrent genesis, same Spec = %p", async (sameSpec) => {
  const x = await temporary(); clean.push(x.cleanup); const gate = join(x.root, "start");
  const requests = [creation("spec_one", "operation_a"), creation(sameSpec ? "spec_one" : "spec_two", "operation_b")];
  const children = await Promise.all(requests.map(async (r) => launch(x.root, "race", await requestFile(x.root, r.transaction, r.blobs), "", gate)));
  await Promise.all(children.map((c) => c.until("ready"))); await writeFile(gate, "go");
  const results = (await Promise.all(children.map((c) => c.done()))).map((r) => r.last!);
  expect(results.filter((r) => r.ok).length).toBe(sameSpec ? 1 : 2);
  if (sameSpec) expect(results.find((r) => !r.ok)?.code).toBe("STORE_ALREADY_EXISTS");
  for (const request of requests) expect((await x.store.verifySpecHistory(request.transaction.spec_id)).commits).toBe(1);
}, 30000);

test("two OS processes, same Spec/HEAD: exactly one CAS winner, no lost update", async () => {
  const x = await setup(), gate = join(x.root, "start");
  const a = launch(x.root, "race", await requestFile(x.root, mutation(x.result, "operation_a", "A")), "", gate);
  const b = launch(x.root, "race", await requestFile(x.root, mutation(x.result, "operation_b", "B")), "", gate);
  await Promise.all([a.until("ready"), b.until("ready")]); await writeFile(gate, "go");
  const results = (await Promise.all([a.done(), b.done()])).map((r) => r.last!);
  expect(results.filter((r) => r.ok).length).toBe(1); expect(results.find((r) => !r.ok)?.code).toBe("STORE_CONFLICT");
  expect((await x.store.verifySpecHistory(x.result.spec_id)).commits).toBe(2);
}, 30000);
test("concurrent identical OperationId/intent converges to one commit and one replay", async () => {
  const x = await setup(), gate = join(x.root, "start"), path = await requestFile(x.root, mutation(x.result));
  const children = [launch(x.root, "race", path, "", gate), launch(x.root, "race", path, "", gate)];
  await Promise.all(children.map((c) => c.until("ready"))); await writeFile(gate, "go");
  const results = (await Promise.all(children.map((c) => c.done()))).map((r) => r.last!);
  expect(results.every((r) => r.ok)).toBe(true);
  const commits = results.map((r) => r.result as { commit_id: string; replayed: boolean });
  expect(commits[0]!.commit_id).toBe(commits[1]!.commit_id); expect(commits.map((r) => r.replayed).sort()).toEqual([false, true]);
  expect((await x.store.verifySpecHistory(x.result.spec_id)).commits).toBe(2);
}, 30000);
test("concurrent reused OperationId with different payload is rejected", async () => {
  const x = await setup(), gate = join(x.root, "start");
  const children = await Promise.all(["A", "B"].map(async (title) => launch(x.root, "race", await requestFile(x.root, mutation(x.result, "operation_same", title)), "", gate)));
  await Promise.all(children.map((c) => c.until("ready"))); await writeFile(gate, "go");
  const results = (await Promise.all(children.map((c) => c.done()))).map((r) => r.last!);
  expect(results.filter((r) => r.ok).length).toBe(1); expect(results.find((r) => !r.ok)?.code).toBe("STORE_OPERATION_REUSE");
}, 30000);
test("different Specs proceed while another process holds its Spec lock", async () => {
  const x = await setup(), gate = join(x.root, "release"), other = creation("spec_other");
  const second = await x.store.createSpec(other.transaction, other.blobs);
  const held = launch(x.root, "commit", await requestFile(x.root, mutation(x.result)), "hold", gate);
  try {
    await held.until("held");
    const different = await launch(x.root, "commit", await requestFile(x.root, mutation(second, "operation_other"))).done();
    expect(different.last?.ok).toBe(true); expect(held.process.exitCode).toBeNull();
    await code(x.store.locks.recover(x.result.spec_id), "STORE_LOCKED");
  } finally { await writeFile(gate, "go"); await held.done(); }
}, 30000);
test("competing stale-lock cleaners cannot both recover ownership", async () => {
  const x = await setup(); await launch(x.root, "lock-die", x.result.spec_id).done();
  const results = await Promise.all([launch(x.root, "recover", x.result.spec_id).done(), launch(x.root, "recover", x.result.spec_id).done()]);
  expect(results.filter((r) => r.last?.recovered === true).length).toBe(1);
  const a = await x.store.locks.acquire(x.result.spec_id); await x.store.locks.release(a);
}, 30000);
