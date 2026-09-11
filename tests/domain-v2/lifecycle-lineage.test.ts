import { describe, expect, test } from "bun:test";
import { checkLifecycleTransition, type LifecycleStatus, type SpecMode } from "../../src/spec/domain/lifecycle";
import { evaluateLifecycleTransition, evaluateApprovalEligibility, evaluateSpecGates, lineageContext } from "../../src/spec/domain/review";
import { artifactRevisionSchema, referenceOf, validationRecordSchema } from "../../src/spec/domain/artifacts";
import { analysisSchema } from "../../src/spec/domain/analysis";
import { currentLineageValidity, deriveStaleness, artifactApplicability, downstreamAffectedArtifacts } from "../../src/spec/domain/lineage";
import { fixture, artifact, metadata } from "./fixtures";

const sequences: [SpecMode, LifecycleStatus[]][] = [
  ["requirements-first", ["draft", "drafting-requirements", "analyzing-requirements", "waiting-requirements-approval", "requirements-approved", "drafting-design", "analyzing-design", "waiting-design-approval", "design-approved", "drafting-tasks", "analyzing-tasks", "waiting-tasks-approval", "ready", "implementing", "verifying", "completed"]],
  ["design-first", ["draft", "drafting-design", "analyzing-design", "waiting-design-approval", "design-approved", "drafting-requirements", "analyzing-requirements", "waiting-requirements-approval", "requirements-approved", "validating-design", "drafting-tasks", "analyzing-tasks", "waiting-tasks-approval", "ready", "implementing", "verifying", "completed"]],
  ["quick", ["draft", "drafting-requirements", "analyzing-requirements", "drafting-design", "analyzing-design", "drafting-tasks", "analyzing-tasks", "waiting-integrated-approval", "ready", "implementing", "verifying", "completed"]],
];
describe("INV-SPEC-001/003: modes and explicit lifecycle", () => {
  test.each(sequences)("%s structural transitions", (mode, sequence) => {
    for (let i = 1; i < sequence.length; i++) expect(checkLifecycleTransition(mode, { state: sequence[i - 1]! }, { state: sequence[i]! }).ok).toBe(true);
  });
  test("quick mode also supports design-first authoring without intermediate human gates", () => {
    const sequence: LifecycleStatus[] = ["draft", "drafting-design", "analyzing-design", "drafting-requirements", "analyzing-requirements", "validating-design", "drafting-tasks"];
    for (let i = 1; i < sequence.length; i++) expect(checkLifecycleTransition("quick", { state: sequence[i - 1]! }, { state: sequence[i]! }, "design-first").ok).toBe(true);
  });
  test.each(["ready", "implementing", "verifying", "completed"] as const)("cannot skip draft into %s", (state) => {
    expect(checkLifecycleTransition("requirements-first", { state: "draft" }, { state }).ok).toBe(false);
  });
  test("mode-incompatible persisted gates cannot become a backdoor transition", () => {
    expect(checkLifecycleTransition("quick", { state: "waiting-requirements-approval" }, { state: "requirements-approved" })).toEqual({ ok: false, issues: [{ code: "invalid-lifecycle-mode" }] });
    expect(checkLifecycleTransition("requirements-first", { state: "waiting-integrated-approval" }, { state: "ready" }).ok).toBe(false);
  });
  test("blocked/interrupted records cannot bypass the suspended state", () => {
    const paused = { state: "interrupted" as const, suspended_from: "analyzing-design" as const, reason: "Human interrupted" };
    expect(checkLifecycleTransition("design-first", { state: "analyzing-design" }, paused).ok).toBe(true);
    expect(checkLifecycleTransition("design-first", paused, { state: "analyzing-design" }).ok).toBe(true);
    expect(checkLifecycleTransition("design-first", paused, { state: "ready" }).ok).toBe(false);
    expect(checkLifecycleTransition("design-first", { state: "cancelled" }, { state: "draft" }).ok).toBe(false);
  });
  test("structural transitions do not bypass approval gates", () => {
    const f = fixture(); f.spec.lifecycle = { state: "waiting-tasks-approval" }; f.spec.approval_applicability = [];
    const decision = evaluateLifecycleTransition(f.review, { state: "ready" });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.issues.map((i) => i.code)).toContain("artifact-approval-missing");
  });
  test("completion requires the dedicated full completion evaluator", () => {
    expect(evaluateLifecycleTransition(fixture().review, { state: "completed" })).toEqual({ ok: false, issues: [{ code: "completion-evaluation-required" }] });
  });
  test("quick review requires the same analysis and consistency obligations", () => {
    const f = fixture("quick"); f.review.analyses.splice(2, 1);
    const subjects = f.spec.artifacts.current.filter((s) => ["requirements", "design", "tasks"].includes(s.artifact.kind));
    expect(evaluateApprovalEligibility(f.review, subjects).map((i) => i.code)).toContain("required-analysis-missing");
  });
});

describe("INV-LINEAGE-001/002/003: immutable provenance and current applicability", () => {
  test("design-first has no circular derivation; validation is a separate record", () => {
    const f = fixture("design-first"), ctx = lineageContext(f.review);
    expect(currentLineageValidity(ctx)).toEqual([]);
    expect(deriveStaleness(ctx).stale).toEqual([]);
    expect(f.des.lineage.map((e) => e.relation)).toEqual(["generated_from_intent"]);
    expect(f.req.lineage.some((e) => e.relation === "derived_from" && e.target.revision === f.des.id)).toBe(true);
    expect(f.spec.lineage.validations[0]!.relation).toBe("validated_against");
    expect(evaluateSpecGates(f.review)).toEqual([]);
  });
  test("adding false retroactive derivation creates a rejected cycle", () => {
    const f = fixture("design-first"); f.des.lineage.push({ relation: "derived_from", target: referenceOf(f.req) });
    expect(currentLineageValidity(lineageContext(f.review)).map((i) => i.code)).toContain("derivation-cycle");
  });
  test("upstream revision change has a transitive deterministic staleness closure", () => {
    const f = fixture(), next = artifact("requirements", "r3", [referenceOf(f.intent)], 30);
    f.review.revisions.push(next); f.spec.artifacts.current.find((s) => s.artifact.kind === "requirements")!.artifact = referenceOf(next);
    const ctx = lineageContext(f.review), result = deriveStaleness(ctx);
    expect(result.stale.map((s) => s.revision)).toContain(f.des.id);
    expect(result.stale.map((s) => s.revision)).toContain(f.ts.id);
    expect(result.stale.map((s) => s.revision)).toContain(f.planRevision.id);
    expect(deriveStaleness({ ...ctx, revisions: [...ctx.revisions].reverse() })).toEqual(result);
    expect(downstreamAffectedArtifacts(ctx, [referenceOf(f.req)]).map((r) => r.revision)).toContain(f.ts.id);
  });
  test("unrelated downstream plan change does not stale requirements/design/tasks", () => {
    const f = fixture(), next = artifact("verification-plan", "p2", [referenceOf(f.ts)], 31);
    f.review.revisions.push(next); f.spec.artifacts.current.find((s) => s.artifact.kind === "verification-plan")!.artifact = referenceOf(next);
    for (const ref of [f.req, f.des, f.ts].map(referenceOf)) expect(artifactApplicability(lineageContext(f.review), ref).applicable).toBe(true);
  });
  test("design-first incompatible requirements make previously approved design inapplicable", () => {
    const f = fixture("design-first"), next = artifact("requirements", "r2", [referenceOf(f.des), referenceOf(f.intent)], 32);
    f.review.revisions.push(next); f.spec.artifacts.current.find((s) => s.artifact.kind === "requirements")!.artifact = referenceOf(next);
    expect(artifactApplicability(lineageContext(f.review), referenceOf(f.des)).applicable).toBe(false);
  });
  test("recorded exact revalidation reuses unchanged design identity, not a fabricated revision", () => {
    const f = fixture(), next = artifact("requirements", "r2", [referenceOf(f.intent)], 33);
    const result = artifact("analysis", "revalidation", [referenceOf(f.des), referenceOf(next)], 34);
    const content = analysisSchema.parse({ schema: "aira.dev/analysis/v1", spec_id: f.spec.id, revision: result.id, phase: "consistency",
      inputs: [referenceOf(f.des), referenceOf(next)], created: metadata, outcome: "consistent", findings: [] });
    f.review.revisions.push(next, result); f.review.analyses.push(content); f.spec.analyses.push(referenceOf(result));
    f.spec.artifacts.current.find((s) => s.artifact.kind === "requirements")!.artifact = referenceOf(next);
    f.spec.lineage.validations = [validationRecordSchema.parse({ schema: "aira.dev/lineage-validation/v1", relation: "validated_against", subject: referenceOf(f.des),
      against: [referenceOf(next)], analysis: referenceOf(result), outcome: "consistent", generation: "10", created: metadata })];
    expect(artifactApplicability(lineageContext(f.review), referenceOf(f.des)).applicable).toBe(true);
    expect(String(f.des.id)).toBe("rev_d1");
    expect(artifactApplicability(lineageContext(f.review), referenceOf(f.ts)).applicable).toBe(false);
  });
  test("same-kind predecessor provenance is historical, not a demand to keep it current", () => {
    const f = fixture();
    const d2 = artifactRevisionSchema.parse({ ...artifact("design", "d2", [referenceOf(f.des), referenceOf(f.req)], 35),
      lineage: [{ relation: "supersedes", target: referenceOf(f.des) }, { relation: "derived_from", target: referenceOf(f.des) }, { relation: "derived_from", target: referenceOf(f.req) }] });
    f.review.revisions.push(d2); f.spec.artifacts.current.find((s) => s.artifact.kind === "design")!.artifact = referenceOf(d2);
    f.spec.lineage.validations = [];
    expect(artifactApplicability(lineageContext(f.review), referenceOf(d2)).applicable).toBe(true);
    expect(artifactApplicability(lineageContext(f.review), referenceOf(f.ts)).applicable).toBe(false);
  });
  test("new design-first requirements do not invalidate themselves through reverse validation", () => {
    const f = fixture("design-first"), next = artifact("requirements", "r2", [referenceOf(f.intent), referenceOf(f.des)], 36);
    f.review.revisions.push(next); f.spec.artifacts.current.find((s) => s.artifact.kind === "requirements")!.artifact = referenceOf(next);
    const ctx = lineageContext(f.review);
    expect(artifactApplicability(ctx, referenceOf(next)).applicable).toBe(true);
    expect(artifactApplicability(ctx, referenceOf(f.des)).applicable).toBe(false);
    expect(artifactApplicability(ctx, referenceOf(f.ts)).applicable).toBe(false);
    // An independent invalidation still wins over the causal-origin exemption.
    f.spec.lineage.invalidations.push({ schema: "aira.dev/artifact-invalidation/v1", subject: referenceOf(next),
      generation: f.spec.generation, reason: "Independent requirement finding", created: f.spec.created });
    expect(artifactApplicability(lineageContext(f.review), referenceOf(next)).applicable).toBe(false);
  });
  test("unknown hashes and missing immutable history fail closed", () => {
    const f = fixture(); const ctx = lineageContext(f.review);
    expect(currentLineageValidity({ ...ctx, revisions: ctx.revisions.filter((r) => r.id !== f.intent.id) }).map((i) => i.code)).toContain("unknown-lineage-reference");
  });
});
