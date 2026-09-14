import { afterEach, expect, test } from "bun:test";
import { created, mutation, code, at } from "./fixtures";
import { withRun } from "./run-fixture";
import { transactionSchema } from "../../src/storage/types";
import { executionRunSchema } from "../../src/execution/schema";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0)) await f(); });
async function claimedFixture() {
  const x = await created(); clean.push(x.cleanup); const request = withRun(x.result);
  const bound = await x.store.commit(request.transaction, request.blobs);
  const t = mutation(bound, "operation_synthetic_claim", "unused", true), base = t.state.runs[0]!;
  const tasks = request.records.find((r) => r.schema === "aira.dev/tasks/v2");
  if (!tasks || tasks.schema !== "aira.dev/tasks/v2") throw Error("fixture tasks");
  const definition = tasks.tasks[0]!.identity;
  const fence = { run: base.id, claim: "claim_one", attempt: "attempt_pending", owner: "test-owner", epoch: "1" };
  t.mutation = { kind: "run", spec: false, runs: [base.id], reason: "Persist synthetic future claim contract, not a scheduler" };
  t.state.runs[0] = executionRunSchema.parse({ ...base, commit_sequence: "3", generation: "1",
    tasks: [{ schema: "aira.dev/task-state/v1", task: definition, run: base.id, run_generation: "1", status: "claimed",
      current_attempt: fence.attempt, claim: fence.claim, updated_at: at }],
    claims: [{ schema: "aira.dev/task-claim/v2", id: fence.claim, task: definition, run: base.id, attempt: fence.attempt,
      owner: fence.owner, generation: "1", fence, snapshot: base.snapshot, status: "active",
      lease: { issued_at: at, expires_at: "2026-08-26T13:00:00.000Z" } }] });
  const current = await x.store.commit(t), next = mutation(current, "operation_check", "unused", true);
  next.expected!.execution = [{ run: base.id, task: definition, status: "claimed", attempt: fence.attempt as never,
    claim: fence.claim as never, fence: t.state.runs[0]!.claims[0]!.fence }];
  return { ...x, current, next };
}
test("transaction supports exact task, attempt, claim and fence preconditions without a scheduler", async () => {
  const x = await claimedFixture(); expect((await x.store.commit(x.next)).replayed).toBe(false);
});
test.each(["task", "status", "attempt", "claim", "owner", "epoch"])("stale execution precondition %s rejects publication", async (field) => {
  const x = await claimedFixture(), e = x.next.expected!.execution[0]!;
  if (field === "task") e.task.hash = x.result.commit_id;
  if (field === "status") e.status = "running";
  if (field === "attempt") e.attempt = "attempt_other" as never;
  if (field === "claim") e.claim = "claim_other" as never;
  if (field === "owner") e.fence!.owner = "not-owner";
  if (field === "epoch") e.fence!.epoch = "2" as never;
  await code(x.store.commit(transactionSchema.parse(x.next)), "STORE_CONFLICT");
});
test("declared run supersession and authority revocation share HEAD", async () => {
  const x = await claimedFixture(), t = mutation(x.current, "operation_fence");
  t.state.spec.run_binding!.status = "fenced";
  await code(x.store.commit(t), "STORE_CONFLICT");
  t.mutation.kind = "spec-and-run"; t.mutation.runs = [t.state.runs[0]!.id];
  t.state.runs[0]!.generation = "2" as never; t.state.runs[0]!.commit_sequence = "4" as never;
  t.state.runs[0]!.claims[0]!.status = "fenced";
  const saved = await x.store.commit(t);
  expect(saved.state.spec.run_binding!.status).toBe("fenced"); expect(saved.state.runs[0]!.claims[0]!.status).toBe("fenced");
});
