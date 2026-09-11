import { describe, expect, test } from "bun:test";
import { analysisFindingSchema, analysisSchema, hasBlockingFindings } from "../../src/spec/domain/analysis";
import { approvalApplicability, integratedApprovalApplicability, canCarryApproval } from "../../src/approval/spec-policy";
import { specApprovalRecordSchema, humanWaiverSchema, waiverApplicabilitySchema } from "../../src/approval/spec-records";
import { blockingFindingIssues, decisionContext, evaluateApprovalEligibility } from "../../src/spec/domain/review";
import { revisionRequestSchema, revisionResolutionSchema } from "../../src/revision/schema";
import { validateRevisionResolution } from "../../src/revision/policy";
import { artifactRevisionSchema, referenceOf, validationRecordSchema } from "../../src/spec/domain/artifacts";
import { specGenerationSchema, runGenerationSchema } from "../../src/spec/domain/generations";
import { fixture, at, observed, human, metadata, hash, artifact } from "./fixtures";

function finding(severity: "info" | "warning" | "blocker" = "blocker") {
  return analysisFindingSchema.parse({ id: "finding_one", category: "security", severity, title: "Auth", description: "Missing access check",
    subjects: [referenceOf(fixture().req)], disposition: { state: "unresolved" } });
}
describe("findings, human waivers and analysis eligibility", () => {
  test("unresolved blocker prevents eligibility; warnings do not", () => {
    const f = fixture();
    f.review.analyses[0]!.findings = [finding()];
    expect(hasBlockingFindings(f.review.analyses[0]!.findings)).toBe(true);
    expect(evaluateApprovalEligibility(f.review, [f.spec.artifacts.current.find((s) => s.artifact.kind === "requirements")!]).map((i) => i.code)).toContain("unresolved-blocker");
    f.review.analyses[0]!.findings = [finding("warning")];
    expect(hasBlockingFindings(f.review.analyses[0]!.findings)).toBe(false);
    expect(blockingFindingIssues(f.review)).toEqual([]);
  });
  test("dismissal requires durable nonblank human rationale", () => {
    expect(analysisFindingSchema.safeParse({ ...finding(), disposition: { state: "dismissed", actor: human, at } }).success).toBe(false);
    expect(analysisFindingSchema.safeParse({ ...finding(), disposition: { state: "dismissed", actor: human, at, rationale: "   " } }).success).toBe(false);
    const dismissed = analysisFindingSchema.parse({ ...finding(), disposition: { state: "dismissed", actor: human, at, rationale: "Not exposed outside localhost" } });
    expect(hasBlockingFindings([dismissed])).toBe(false);
  });
  test("resolution binds an artifact revision or exact human answer", () => {
    expect(analysisFindingSchema.safeParse({ ...finding(), disposition: { state: "resolved", at, rationale: "Done" } }).success).toBe(false);
    expect(analysisFindingSchema.safeParse({ ...finding(), disposition: { state: "resolved", at, rationale: "Answered", human_answer: { actor: human, answer: "  Local only\r\n" } } }).success).toBe(true);
  });
  test("only exact scope, policy-authorized human waiver satisfies blocker (INV-LINEAGE-003)", () => {
    const f = fixture(); f.review.analyses[0]!.findings = [finding()];
    const waiver = humanWaiverSchema.parse({ schema: "aira.dev/human-waiver/v1", id: "waiver_one", spec_id: f.spec.id,
      actor: human, channel: "pi", operation: "operation_waive", policy: f.spec.decision_policy.identity,
      scope: { code: "unresolved-blocker", subject: "finding_one" }, subjects: [f.spec.artifacts.current.find((s) => s.artifact.kind === "requirements")!],
      observed_generation: "9", committed_generation: "10", rationale: "Local development only, accepted risk", at });
    f.review.waivers.push(waiver); f.spec.waivers.push(waiver.id);
    f.spec.waiver_applicability.push(waiverApplicabilitySchema.parse({ schema: "aira.dev/waiver-applicability/v1", waiver: waiver.id,
      spec_id: f.spec.id, generation: "10", status: "active", reason: "Human waiver committed", created: metadata }));
    expect(blockingFindingIssues(f.review)).toHaveLength(1);
    f.spec.decision_policy.waivable = ["unresolved-blocker"];
    expect(blockingFindingIssues(f.review)).toEqual([]);
    f.spec.waiver_applicability[0]!.status = "revoked";
    expect(blockingFindingIssues(f.review)).toHaveLength(1);
  });
});

describe("INV-APPROVAL-001/002/003: exact human decisions", () => {
  test("applicable exact subject with explicit carry-forward", () => {
    const f = fixture(), record = f.review.approvals[0]!;
    expect(approvalApplicability(record, record.subjects[0]!, decisionContext(f.review))).toEqual([]);
  });
  test("approval does not invalidate itself when its transaction advances Spec generation", () => {
    const f = fixture(), record = f.review.approvals[0]!, subject = record.subjects[0]!;
    const ctx = decisionContext(f.review);
    const binding = { ...ctx.applicability[0]!, generation: record.committed_generation, carried_from: undefined };
    expect(approvalApplicability(record, subject, { ...ctx, generation: record.committed_generation, applicability: [binding] })).toEqual([]);
  });
  test("run-only generation changes do not invalidate human approval", () => {
    const f = fixture(); f.run.generation = runGenerationSchema.parse("6");
    const record = f.review.approvals[0]!;
    expect(approvalApplicability(record, record.subjects[0]!, decisionContext(f.review))).toEqual([]);
  });
  test("unrecorded generation change fails closed", () => {
    const f = fixture(), record = f.review.approvals[0]!;
    expect(approvalApplicability(record, record.subjects[0]!, { ...decisionContext(f.review), generation: specGenerationSchema.parse("11") }).map((i) => i.code)).toContain("approval-generation-inapplicable");
  });
  test.each(["hash", "lineage_hash"] as const)("changed %s makes an approval inapplicable", (field) => {
    const f = fixture(), record = f.review.approvals[0]!, subject = f.spec.artifacts.current.find((s) => s.artifact.kind === "requirements")!;
    if (field === "hash") subject.artifact.hash = hash(301); else subject.lineage_hash = hash(302);
    expect(approvalApplicability(record, record.subjects[0]!, decisionContext(f.review)).length).toBeGreaterThan(0);
  });
  test("changed revision and explicit staleness invalidate approval", () => {
    const f = fixture(), record = f.review.approvals[0]!;
    f.spec.lineage.invalidations.push({ schema: "aira.dev/artifact-invalidation/v1", subject: record.subjects[0]!.artifact, generation: f.spec.generation,
      reason: "Relevant new finding", created: f.spec.created });
    expect(approvalApplicability(record, record.subjects[0]!, decisionContext(f.review)).map((i) => i.code)).toContain("artifact-stale");
  });
  test("revoked approval cannot satisfy current state", () => {
    const f = fixture(), record = f.review.approvals[0]!; f.spec.approval_applicability[0]!.status = "revoked";
    expect(approvalApplicability(record, record.subjects[0]!, decisionContext(f.review)).map((i) => i.code)).toContain("approval-revoked");
  });
  test.each(["model", "worker", "system"])("%s actor cannot satisfy human schema", (kind) => {
    expect(specApprovalRecordSchema.safeParse({ ...fixture().review.approvals[0]!, actor: { kind, id: "local" } }).success).toBe(false);
  });
  test("quick integrated operation binds all three exact subjects and their applicability", () => {
    const f = fixture("quick"), record = f.review.approvals[0]!;
    expect(integratedApprovalApplicability(record, decisionContext(f.review))).toEqual([]);
    expect(specApprovalRecordSchema.safeParse({ ...record, subjects: record.subjects.slice(0, 2) }).success).toBe(false);
    f.spec.approval_applicability[2]!.status = "revoked";
    expect(integratedApprovalApplicability(record, decisionContext(f.review)).length).toBeGreaterThan(0);
  });
  test("unchanged design-first content can carry approval after exact revalidation, without another human content decision", () => {
    const f = fixture("design-first"), record = f.review.approvals.find((a) => a.subjects[0]!.artifact.kind === "design")!;
    const from = decisionContext(structuredClone(f.review));
    const next = artifact("requirements", "r2", [referenceOf(f.intent), referenceOf(f.des)], 451);
    const proof = artifact("analysis", "new_consistency", [referenceOf(f.des), referenceOf(next)], 452);
    f.review.revisions.push(next, proof);
    f.review.analyses.push(analysisSchema.parse({ schema: "aira.dev/analysis/v1", spec_id: f.spec.id, revision: proof.id,
      phase: "consistency", inputs: [referenceOf(f.des), referenceOf(next)], created: metadata, outcome: "consistent", findings: [] }));
    f.spec.artifacts.current.find((s) => s.artifact.kind === "requirements")!.artifact = referenceOf(next);
    f.spec.analyses.push(referenceOf(proof)); f.spec.generation = specGenerationSchema.parse("11");
    f.spec.lineage.validations = [validationRecordSchema.parse({ schema: "aira.dev/lineage-validation/v1", relation: "validated_against", subject: referenceOf(f.des),
      against: [referenceOf(next)], analysis: referenceOf(proof), outcome: "consistent", generation: "11", created: metadata })];
    expect(canCarryApproval(record, from, decisionContext(f.review))).toEqual([]);
    for (const binding of f.spec.approval_applicability) { binding.generation = f.spec.generation; binding.carried_from = from.generation; }
    expect(approvalApplicability(record, record.subjects[0]!, decisionContext(f.review))).toEqual([]);
    expect(f.review.approvals).toHaveLength(3); expect(String(f.des.id)).toBe("rev_d1");
  });
  test("carry-forward requires previously applicable exact subjects, never a wildcard", () => {
    const f = fixture(), record = f.review.approvals[0]!, from = decisionContext(f.review);
    expect(canCarryApproval(record, from, { ...from, generation: specGenerationSchema.parse("11") })).toEqual([]);
    expect(canCarryApproval(record, from, { ...from, generation: specGenerationSchema.parse("11"), subjects: [] }).map((i) => i.code)).toContain("approval-subject-mismatch");
  });
});
describe("lineage-based revision requests", () => {
  const f = fixture();
  const feedback = " \tKeep café export.\r\nDo not trim this feedback.\n\n ";
  const request = revisionRequestSchema.parse({ schema: "aira.dev/revision-request/v1", id: "revision_one", spec_id: f.spec.id,
    previous_artifact: referenceOf(f.req), feedback, actor: human, channel: "cli", requested_at: at, operation: "operation_revise", status: "pending" });
  test("exact feedback and exact previous revision/hash survive validation", () => {
    expect(request.feedback).toBe(feedback); expect(request.previous_artifact).toEqual(referenceOf(f.req));
    expect(revisionRequestSchema.safeParse({ ...request, feedback: " \r\n\t" }).success).toBe(false);
  });
  test("resolution supersedes the exact predecessor, never a positional replay", () => {
    const next = artifactRevisionSchema.parse({ ...artifact("requirements", "r2", [], 401), lineage: [{ relation: "supersedes", target: referenceOf(f.req) }] });
    const resolution = revisionResolutionSchema.parse({ resulting_artifact: referenceOf(next), at: observed, operation: "operation_resolve", attempt: "attempt_revision" });
    expect(validateRevisionResolution(request, resolution, next)).toEqual([]);
    expect(revisionRequestSchema.safeParse({ ...request, status: "resolved", resolution }).success).toBe(true);
    const wrong = { ...next, lineage: [] };
    expect(validateRevisionResolution(request, resolution, wrong).map((i) => i.code)).toContain("revision-predecessor-mismatch");
    expect(validateRevisionResolution({ ...request, status: "resolved", resolution }, resolution, next).map((i) => i.code)).toContain("revision-not-pending");
  });
  test("pending records cannot claim a resolution and versions fail closed", () => {
    expect(revisionRequestSchema.safeParse({ ...request, resolution: {} }).success).toBe(false);
    expect(revisionRequestSchema.safeParse({ ...request, schema: "aira.dev/revision-request/v2" }).success).toBe(false);
  });
});
