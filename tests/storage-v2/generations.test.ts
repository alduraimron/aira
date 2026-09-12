import { afterEach, expect, test } from "bun:test";
import { created, mutation, code } from "./fixtures";
import { withRun } from "./run-fixture";
import { transactionSchema, positiveSequenceSchema, headSchema } from "../../src/storage/types";
import { nextSequence } from "../../src/storage/transaction";
import { commitSequenceSchema } from "../../src/spec/domain/generations";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
async function setup() { const x = await created(); clean.push(x.cleanup); const request = withRun(x.result); const running = await x.store.commit(request.transaction, request.blobs); return { ...x, request, running }; }

test("complete approved snapshot, exact behavioral pins and parallel-ready run round-trip", async () => {
  const { store, running, request } = await setup();
  expect(running.state).toEqual(request.transaction.state); expect(running.records).toEqual(request.records);
  expect(running.state.runs[0]!.snapshot.behavioral_assets).toEqual(request.run.snapshot.behavioral_assets);
  expect(String(running.sequence)).toBe("2"); expect(String(running.spec_generation)).toBe("1"); expect(String(running.run_generation)).toBe("0");
  await store.verifySpecHistory(running.spec_id);
});
test("run-only CAS advances RunGeneration and CommitSequence, not Spec or human review", async () => {
  const { store, running } = await setup();
  const t = mutation(running, "operation_run", "unused", true);
  t.mutation = { kind: "run", spec: false, runs: [running.state.runs[0]!.id], reason: "Run progress" };
  t.state.runs[0]!.generation = "1" as never; t.state.runs[0]!.commit_sequence = "3" as never; t.state.runs[0]!.status = "running";
  const next = await store.commit(t);
  expect(String(next.sequence)).toBe("3"); expect(String(next.run_generation)).toBe("1"); expect(next.spec_generation).toBe(running.spec_generation);
  expect(next.state.spec).toEqual(running.state.spec);
  await store.verifySpecHistory(running.spec_id);
});
test("human semantic mutation does not advance unrelated run", async () => {
  const { store, running } = await setup(); const t = mutation(running, "operation_title");
  const next = await store.commit(t); expect(next.state.runs).toEqual(running.state.runs); expect(String(next.run_generation)).toBe("0");
});
test("combined mutations advance both domains once", async () => {
  const { store, running } = await setup(); const t = mutation(running, "operation_both");
  t.mutation.kind = "spec-and-run"; t.mutation.runs = [running.state.runs[0]!.id];
  t.state.runs[0]!.generation = "1" as never; t.state.runs[0]!.commit_sequence = "3" as never;
  const next = await store.commit(t); expect(String(next.spec_generation)).toBe("2"); expect(String(next.run_generation)).toBe("1");
});
test.each(["same", "jump", "scope", "stale"])("reject invalid RunGeneration %s", async (variant) => {
  const { store, running } = await setup(), t = mutation(running, "operation_bad", "unused", true);
  t.mutation = { kind: "run", spec: false, runs: [running.state.runs[0]!.id], reason: "Run progress" };
  t.state.runs[0]!.commit_sequence = "3" as never;
  t.state.runs[0]!.generation = (variant === "same" ? "0" : variant === "jump" ? "2" : "1") as never;
  if (variant === "scope") t.mutation = { kind: "audit", spec: false, runs: [], reason: "Wrong scope" };
  if (variant === "stale") { t.expected!.head.run_generation = "9" as never; t.expected!.head.run_generations[0]!.generation = "9" as never; }
  await code(store.commit(t), "STORE_CONFLICT");
});
test("run generations are per-run, never a Spec-global execution alias", async () => {
  const { store, running } = await setup(), t = mutation(running, "operation_new_run");
  const run = { ...t.state.runs[0]!, id: "run_two" as never, generation: "0" as never, commit_sequence: "3" as never };
  t.state.runs.push(run); t.mutation.kind = "spec-and-run"; t.mutation.runs = [run.id];
  t.state.spec.run_binding!.run = run.id;
  const result = await store.commit(transactionSchema.parse(t));
  expect(result.run_generations.map((r) => String(r.run))).toEqual(["run_one", "run_two"]);
  await store.verifySpecHistory(result.spec_id);
});
test.each(["0", "-1", "1.5", "01", "18446744073709551616", 1, Number.MAX_SAFE_INTEGER + 1])("invalid storage sequence %p", (value) => {
  expect(positiveSequenceSchema.safeParse(value).success).toBe(false);
});
test("u64 successor is exact beyond JS safe integer and fails at maximum", () => {
  expect(String(nextSequence(commitSequenceSchema.parse("9007199254740992")))).toBe("9007199254740993");
  expect(() => nextSequence(commitSequenceSchema.parse("18446744073709551615"))).toThrow();
});
