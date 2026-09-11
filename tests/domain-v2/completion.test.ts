import { describe, expect, test } from "bun:test";
import { evaluateCompletionTransition, evaluateSpecCompletion, evaluateTaskCompletion } from "../../src/spec/domain/completion";
import { analysisFindingSchema } from "../../src/spec/domain/analysis";
import { referenceOf } from "../../src/spec/domain/artifacts";
import { artifactRevisionIdSchema, claimIdSchema, evidenceIdSchema } from "../../src/spec/domain/ids";
import { fixture, hash, artifact } from "./fixtures";

const codes = (f: ReturnType<typeof fixture>) => evaluateSpecCompletion(f).blockers.map((b) => b.code);

describe("INV-COMPLETE-001: deterministic completion", () => {
  test.each(["requirements-first", "design-first", "quick"] as const)("complete exact current Spec in %s mode", (mode) => {
    const f = fixture(mode);
    const result = evaluateSpecCompletion(f);
    expect(result.blockers).toEqual([]);
    expect(result.complete).toBe(true);
    expect(evaluateCompletionTransition(f)).toMatchObject({ allowed: true, lifecycle: { state: "completed" } });
  });
  test("quick integrated approval also completes design-first provenance", () => {
    expect(evaluateSpecCompletion(fixture("quick", "design-first")).blockers).toEqual([]);
  });
  test("stable report under reordered historical records and no caller mutation", () => {
    const f = fixture(), before = JSON.stringify(f);
    const result = evaluateSpecCompletion(f);
    expect(JSON.stringify(f)).toBe(before);
    expect(evaluateSpecCompletion({ ...f, review: { ...f.review, revisions: [...f.review.revisions].reverse(), analyses: [...f.review.analyses].reverse(), approvals: [...f.review.approvals].reverse() } })).toEqual(result);
  });
  test("missing approval", () => {
    const f = fixture(); f.spec.approval_applicability = [];
    expect(codes(f)).toContain("artifact-approval-missing");
  });
  test("upstream change stales design and tasks transitively", () => {
    const f = fixture(); const r2 = artifact("requirements", "r2", [referenceOf(f.intent)], 22);
    f.review.revisions.push(r2); f.spec.artifacts.current.find((s) => s.artifact.kind === "requirements")!.artifact = referenceOf(r2);
    expect(codes(f)).toContain("artifact-stale");
    expect(codes(f)).toContain("run-snapshot-inapplicable");
  });
  test("unresolved blocker", () => {
    const f = fixture(); f.review.analyses[0]!.findings.push(analysisFindingSchema.parse({ id: "finding_one", category: "security", severity: "blocker", title: "Authorization", description: "Missing authorization",
      subjects: [referenceOf(f.req)], disposition: { state: "unresolved" } }));
    expect(codes(f)).toContain("unresolved-blocker");
  });
  test.each(["pending", "ready", "failed", "interrupted", "skipped", "cancelled", "unknown"] as const)("required task %s cannot complete", (status) => {
    const f = fixture(); f.run.tasks[0]!.status = status;
    expect(codes(f)).toContain("task-not-completed");
  });
  test("worker success is not domain task completion (INV-TASK-002)", () => {
    const f = fixture();
    expect(evaluateTaskCompletion({ task: f.tasks.tasks[0]!, state: f.state, evidence: [], evidence_contexts: [], applicable_artifacts: [] }))
      .toEqual([{ code: "task-verification-missing", task: "T1", verifier: "V1" }]);
  });
  test("missing evidence", () => {
    const f = fixture(); f.evidence = [];
    expect(codes(f)).toContain("required-verification-missing");
    expect(codes(f)).toContain("acceptance-evidence-missing");
  });
  test.each(["failed", "interrupted", "cancelled", "timed_out", "unknown", "skipped"] as const)("%s evidence cannot satisfy completion", (outcome) => {
    const f = fixture(); f.record.outcome = outcome;
    expect(codes(f)).toContain("required-verification-missing");
  });
  test("workspace drift invalidates passing evidence (INV-EVIDENCE-001)", () => {
    const f = fixture(); f.workspace.fingerprint.digest = hash(400);
    expect(codes(f)).toContain("evidence-workspace-mismatch");
  });
  test("unknown observation cannot assert completion", () => {
    const f = fixture(); f.workspace.consistency = "unknown";
    expect(codes(f)).toContain("workspace-observation-unknown");
  });
  test("fenced attempt and snapshot cannot publish success (INV-EXEC-001/002)", () => {
    const f = fixture(); f.run.authorities[0]!.status = "fenced";
    expect(codes(f)).toContain("task-attempt-inapplicable");
    expect(codes(f)).toContain("evidence-attempt-fenced");
  });
  test("active execution makes completion unsafe", () => {
    const f = fixture(); f.run.authorities[0]!.status = "active"; f.run.tasks[0]!.status = "running";
    f.run.tasks[0]!.claim = claimIdSchema.parse("claim_one");
    expect(codes(f)).toContain("active-execution"); expect(codes(f)).toContain("unsafe-task-state");
  });
  test("final consistency review is a configured obligation", () => {
    const f = fixture(); f.spec.completion_policy.final_consistency_review_required = true;
    expect(codes(f)).toContain("final-consistency-review-missing");
  });
  test("configured final human consistency review can satisfy completion", () => {
    const f = fixture(); f.spec.completion_policy.final_consistency_review_required = true;
    f.plan.final_consistency_review = f.plan.verifiers[0]!.identity.id;
    f.plan.verifiers[0]!.definition = { kind: "human-review", actor_kind: "human", rubric: "Final consistency" };
    f.record.review_actor = { kind: "human", id: "local" };
    expect(evaluateSpecCompletion(f).blockers).toEqual([]);
  });
  test("unknown schema versions and malformed canonical structures cannot complete", () => {
    const f = fixture(); const invalid = { ...f, requirements: { ...f.requirements, schema: "aira.dev/requirements/v99" } };
    expect(evaluateSpecCompletion(invalid as unknown as typeof f).blockers).toContainEqual({ code: "invalid-domain-contract", subject: "requirements" });
    f.requirements.requirements.push(structuredClone(f.requirements.requirements[0]!));
    expect(codes(f)).toContain("invalid-domain-contract");
  });
  test("retired identity does not silently regain authority", () => {
    const f = fixture(); f.spec.identities.entries[0]!.retired_in = artifactRevisionIdSchema.parse("rev_retired");
    expect(codes(f)).toContain("identity-unregistered-or-retired");
  });
  test("definition revision binding is exact", () => {
    const f = fixture(); f.run.tasks[0]!.task.hash = hash(401);
    expect(codes(f)).toContain("task-state-definition-mismatch");
  });
  test("policy change invalidates snapshot even without content changes", () => {
    const f = fixture(); f.spec.completion_policy.identity.hash = hash(402);
    expect(codes(f)).toContain("run-snapshot-inapplicable");
  });
  test("a selected failure cannot reuse another historical passing observation", () => {
    const f = fixture(), failedId = evidenceIdSchema.parse("evidence_failure");
    f.evidence.push({ ...f.record, id: failedId, outcome: "failed" });
    f.run.current_evidence[0]!.evidence = failedId;
    expect(codes(f)).toContain("required-verification-missing");
    expect(codes(f)).toContain("task-verification-missing");
  });
  test("duplicate immutable evidence identity fails closed", () => {
    const f = fixture(); f.evidence.push({ ...f.record, outcome: "failed" });
    expect(codes(f)).toContain("duplicate-evidence");
  });
});
