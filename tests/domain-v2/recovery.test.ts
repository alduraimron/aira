import { describe, expect, test } from "bun:test";
import { automaticRetryDecision, recoveryDeclarationSchema, reconciliationRecordSchema, retryPolicySchema, type RetryInput } from "../../src/execution/recovery";
import { claimRecordSchema, executionRunSchema } from "../../src/execution/schema";
import { fixture, profile, metadata, observed, hash } from "./fixtures";

function input(characteristic: "replay_safe" | "idempotent" | "reconcilable" | "non_replayable"): RetryInput {
  const f = fixture();
  return { attempt: f.attempt.id, operation: f.attempt.operation, outcome: "unknown", external_effects: "unknown", authority: "current", attempts_so_far: 1,
    declarations: [recoveryDeclarationSchema.parse({ characteristic, scope: "external operation", assumptions: [], guarantee: profile("recovery"),
      ...(characteristic === "idempotent" ? { idempotency_operation: f.attempt.operation } : {}),
      ...(characteristic === "reconcilable" ? { reconciliation: profile("reconcile") } : {}) })],
    policy: retryPolicySchema.parse({ schema: "aira.dev/retry-policy/v1", automatic: true, max_attempts: 3, outcomes: ["unknown", "failed", "interrupted", "cancelled", "timed_out"] }), reconciliations: [] };
}
describe("INV-EXEC-003/004: unknown side effects and conservative retry", () => {
  test("unknown + non_replayable forbids automatic replay", () => {
    expect(automaticRetryDecision(input("non_replayable"))).toEqual({ action: "human-intervention", code: "non-replayable-operation" });
  });
  test("unknown + reconcilable requires reconciliation", () => {
    expect(automaticRetryDecision(input("reconcilable"))).toEqual({ action: "reconciliation-required", code: "reconciliation-required" });
  });
  test.each(["replay_safe", "idempotent"] as const)("unknown + %s may retry only by explicit policy", (characteristic) => {
    const i = input(characteristic); expect(automaticRetryDecision(i).action).toBe("retry-allowed");
    expect(automaticRetryDecision({ ...i, policy: { ...i.policy, automatic: false } }).action).toBe("forbidden");
  });
  test("idempotency needs the stable operation identity", () => {
    const i = input("idempotent");
    expect(automaticRetryDecision({ ...i, operation: fixture().spec.created.operation })).toEqual({ action: "human-intervention", code: "idempotency-identity-mismatch" });
    expect(recoveryDeclarationSchema.safeParse({ ...i.declarations[0], idempotency_operation: undefined }).success).toBe(false);
  });
  test("reconciliation is explicit, exact-attempt and evidence-bearing", () => {
    const i = input("reconcilable");
    const reconciliation = reconciliationRecordSchema.parse({ schema: "aira.dev/reconciliation/v1", operation: "operation_reconcile", attempt: i.attempt,
      mechanism: profile("reconcile"), created: metadata, disposition: "retry-safe", evidence: [{ hash: hash(900), bytes: 10, media_type: "application/json" }] });
    expect(automaticRetryDecision({ ...i, reconciliations: [reconciliation] }).action).toBe("retry-allowed");
    expect(automaticRetryDecision({ ...i, reconciliations: [{ ...reconciliation, disposition: "unknown" }] }).action).toBe("reconciliation-required");
    expect(reconciliationRecordSchema.safeParse({ ...reconciliation, evidence: [] }).success).toBe(false);
  });
  test("non-replayable work may use an explicit safe reconciliation mechanism", () => {
    const i = input("non_replayable");
    const declaration = { ...i.declarations[0]!, reconciliation: profile("reconcile") };
    expect(automaticRetryDecision({ ...i, declarations: [declaration] }).action).toBe("reconciliation-required");
  });
  test("multiple safeguards intersect, never choose the weakest declaration", () => {
    const safe = input("replay_safe"), unsafe = input("non_replayable");
    expect(automaticRetryDecision({ ...safe, declarations: [...safe.declarations, ...unsafe.declarations] }).action).toBe("human-intervention");
    expect(automaticRetryDecision({ ...safe, declarations: [...unsafe.declarations, ...safe.declarations] }).action).toBe("human-intervention");
  });
  test("undeclared safety, lost ownership, successful outcomes, and exhausted budget do not replay", () => {
    const i = input("replay_safe");
    expect(automaticRetryDecision({ ...i, declarations: [] }).code).toBe("recovery-undeclared");
    expect(automaticRetryDecision({ ...i, authority: "fenced" }).code).toBe("attempt-fenced");
    expect(automaticRetryDecision({ ...i, outcome: "succeeded" }).code).toBe("attempt-already-succeeded");
    expect(automaticRetryDecision({ ...i, attempts_so_far: 3 }).code).toBe("retry-budget-exhausted");
    expect(automaticRetryDecision({ ...i, attempts_so_far: Number.POSITIVE_INFINITY }).code).toBe("retry-budget-exhausted");
  });
  test.each(["interrupted", "cancelled", "timed_out", "failed"] as const)("%s does not establish no external effects", (outcome) => {
    expect(automaticRetryDecision({ ...input("non_replayable"), outcome }).action).toBe("human-intervention");
  });
});

describe("INV-GEN-003/EXEC-001: future parallel ownership contracts, without a scheduler", () => {
  test("claims bind task, attempt, owner, monotonic fence, exact approved snapshot and lease", () => {
    const f = fixture();
    const record = { schema: "aira.dev/task-claim/v2", id: "claim_one", task: f.attempt.task, run: f.attempt.run, attempt: f.attempt.id,
      owner: f.attempt.fence.owner, generation: "3", fence: f.attempt.fence, snapshot: f.attempt.snapshot, lease: { issued_at: f.attempt.started_at, expires_at: observed }, status: "active" };
    expect(claimRecordSchema.safeParse(record).success).toBe(true);
    expect(claimRecordSchema.safeParse({ ...record, owner: "other-owner" }).success).toBe(false);
    expect(claimRecordSchema.safeParse({ ...record, fence: { ...f.attempt.fence, epoch: "-1" } }).success).toBe(false);
  });
  test("first run schema accepts max_parallel > 1 and rejects sequential cursor fields", () => {
    const f = fixture();
    expect(executionRunSchema.safeParse({ ...f.run, scheduling: { ...f.run.scheduling, max_parallel: 8 } }).success).toBe(true);
    expect(executionRunSchema.safeParse({ ...f.run, current_task: "T1" }).success).toBe(false);
    expect(executionRunSchema.safeParse({ ...f.run, scheduling: { ...f.run.scheduling, max_parallel: 0 } }).success).toBe(false);
  });
});
