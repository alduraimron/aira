import { describe, expect, test } from "bun:test";
import { fixture, artifact, hash } from "../domain-v2/fixtures";
import { referenceOf, approvedSpecSnapshotSchema, artifactRevisionSchema } from "../../src/spec/domain/artifacts";
import { buildTraceability, firstObservableSlices, traceReachable } from "../../src/spec/domain/traceability";
import { evaluateSpecCompletion } from "../../src/spec/domain/completion";
import { evaluateSpecGates, evaluateLifecycleTransition, lineageContext, decisionContext } from "../../src/spec/domain/review";
import { artifactApplicability, deriveStaleness } from "../../src/spec/domain/lineage";
import { approvalApplicability, integratedApprovalApplicability } from "../../src/approval/spec-policy";
import { specApprovalRecordSchema, waiverScopeSchema } from "../../src/approval/spec-records";
import { planningKinds } from "../../src/spec/domain/planning-kinds";
import { specModeSchema } from "../../src/spec/domain/lifecycle";
import { specSchema } from "../../src/spec/domain/schema";
import { productDefinitionSchema } from "../../src/spec/domain/product";
import { slicePlanSchema } from "../../src/spec/domain/slices";
import { productOutcomeIdSchema } from "../../src/spec/domain/ids";
import type { TraceabilityInput } from "../../src/spec/domain/traceability";
const traceInput = (f: ReturnType<typeof fixture>): TraceabilityInput => ({ ...f, artifacts: f.spec.artifacts.current.map((s) => s.artifact),
  evidence_contexts: [f.evidenceContext], policy: f.spec.completion_policy });

describe("INV-TRACE-002: Product intent through planning and current evidence", () => {
  test("complete O -> SC -> R -> AC -> A -> PD -> S -> T -> V -> Evidence graph", () => {
    const f = fixture(), report = buildTraceability(traceInput(f)); expect(report.issues).toEqual([]);
    const chain = ["O1", "SC1", "R1", "R1.AC1", "A1", "PD1", "S1", "T1", "V1", "evidence_one"];
    for (let i = 1; i < chain.length; i++) expect(report.edges.some((e) => e.from.id === chain[i - 1] && e.to.id === chain[i])).toBe(true);
    expect(report.edges.filter((e) => e.to.kind !== "evidence").every((e) => e.from.hash && e.to.hash)).toBe(true);
    expect(report.product_outcomes).toEqual([{ id: "O1", requirements: ["R1"], evidence: ["evidence_one"] }]);
    expect(report.success_criteria).toEqual([{ id: "SC1", requirements: ["R1"], evidence: ["evidence_one"] }]);
    expect(traceReachable(report, { kind: "architecture-decision", id: "A1" }, "program-design-decision").map((n) => n.id)).toEqual(["PD1"]);
    expect(traceReachable(report, { kind: "slice", id: "S1" }, "task").map((n) => n.id)).toEqual(["T1"]);
    expect(traceReachable(report, { kind: "slice", id: "S1" }, "verifier").map((n) => n.id)).toEqual(["V1"]);
  });
  test("first observable Slice is a partial-order frontier, not a lexical minimum", () => {
    const s = fixture().slices, base = s.slices[0]!;
    const plan = slicePlanSchema.parse({ ...s, slices: [{ ...base, id: "S10" }, { ...base, id: "S2", dependencies: ["S10"] }, { ...base, id: "S3" }] });
    expect(firstObservableSlices(plan, "R1")).toEqual(["S10", "S3"]);
  });
  test.each(["product-outcome", "success", "architecture", "program-design", "slice", "task", "verifier"] as const)("missing %s link reports structured gaps", (kind) => {
    const f = fixture();
    if (kind === "product-outcome") f.product.outcomes.push({ id: productOutcomeIdSchema.parse("O2"), statement: "Unrealized outcome" });
    if (kind === "success") f.requirements.requirements[0]!.success_criteria = [];
    if (kind === "architecture") f.architecture.decisions = [];
    if (kind === "program-design") f.program_design.decisions[0]!.architecture_decisions = [];
    if (kind === "slice") f.slices.slices[0]!.requirements = [];
    if (kind === "task") f.tasks.tasks[0]!.program_design_decisions = [];
    if (kind === "verifier") f.plan.required_verifiers = [], f.tasks.tasks[0]!.completion = [{ kind: "artifact-published", artifact: referenceOf(f.req) }];
    const expected = { "product-outcome": "product-outcome-requirement-missing", success: "product-success-requirement-missing", architecture: "requirement-architecture-missing",
      "program-design": "architecture-program-design-missing", slice: "requirement-slice-missing", task: "program-design-task-missing", verifier: "requirement-verification-missing" };
    expect(buildTraceability(traceInput(f)).issues.map((i) => i.code)).toContain(expected[kind]);
  });
  test("failed, superseded or workspace-stale observations do not support Product success", () => {
    for (const kind of ["failed", "stale", "superseded"] as const) {
      const f = fixture();
      if (kind === "failed") f.record.outcome = "failed";
      if (kind === "stale") f.evidenceContext.workspace.digest = hash(991);
      if (kind === "superseded") f.evidenceContext.selected_evidence = "evidence_other" as never;
      const report = buildTraceability(traceInput(f));
      expect(report.success_criteria[0]!.evidence).toEqual([]);
      expect(report.issues.map((i) => i.code)).toContain("product-success-evidence-missing");
    }
  });
  test("Requirement-tagged evidence without AC proof cannot support Product success", () => {
    const f = fixture(); f.record.acceptance_criteria = [];
    const report = buildTraceability(traceInput(f));
    expect(report.success_criteria[0]!.evidence).toEqual([]);
    expect(report.issues.map((i) => i.code)).toContain("product-success-evidence-missing");
  });
  test("reordering entities preserves graph and structured diagnostics", () => {
    const f = fixture(), before = buildTraceability(traceInput(f));
    f.product.outcomes.reverse(); f.program_design.decisions.reverse(); f.slices.slices.reverse(); f.tasks.tasks.reverse(); f.plan.verifiers.reverse();
    expect(buildTraceability(traceInput(f))).toEqual(before);
  });
});
describe("INV-LINEAGE-003: causal expanded staleness", () => {
  const pairs = [["product", "requirements"], ["requirements", "architecture"], ["architecture", "program-design"], ["program-design", "slice-plan"], ["slice-plan", "tasks"]] as const;
  test.each(pairs)("%s revision stales dependent %s, not its predecessors", (kind, downstream) => {
    const f = fixture(), original = f.review.revisions.find((r) => r.kind === kind)!;
    const next = artifact(kind, `changed_${kind}`, original.lineage.map((e) => e.target), 990);
    f.review.revisions.push(next); f.spec.artifacts.current.find((s) => s.artifact.kind === kind)!.artifact = referenceOf(next);
    const ctx = lineageContext(f.review), report = deriveStaleness(ctx);
    expect(report.valid).toBe(true);
    expect(artifactApplicability(ctx, f.spec.artifacts.current.find((s) => s.artifact.kind === downstream)!.artifact).applicable).toBe(false);
    for (const upstream of planningKinds.slice(0, planningKinds.indexOf(kind))) expect(artifactApplicability(ctx, f.spec.artifacts.current.find((s) => s.artifact.kind === upstream)!.artifact).applicable).toBe(true);
    expect(deriveStaleness({ ...ctx, revisions: [...ctx.revisions].reverse() })).toEqual(report);
  });
  test("Task revision never stales upstream planning", () => {
    const f = fixture(), next = artifact("tasks", "tasks_next", f.ts.lineage.map((e) => e.target), 989);
    f.review.revisions.push(next); f.spec.artifacts.current.find((s) => s.artifact.kind === "tasks")!.artifact = referenceOf(next);
    for (const kind of planningKinds.slice(0, -1)) expect(artifactApplicability(lineageContext(f.review), f.spec.artifacts.current.find((s) => s.artifact.kind === kind)!.artifact).applicable).toBe(true);
  });
  test("unrelated fine-grained Product change does not stale Requirements or downstream", () => {
    const f = fixture(), next = artifact("product", "product_next", [referenceOf(f.intent)], 989), scope = [{ id: productOutcomeIdSchema.parse("O1"), hash: hash(880) }];
    const edge = f.req.lineage.find((e) => e.target.kind === "product")!;
    f.req.lineage = f.req.lineage.map((e) => e === edge ? { relation: "derived_from", target: e.target, scope } : e);
    f.review.revisions.push(next); f.spec.artifacts.current.find((s) => s.artifact.kind === "product")!.artifact = referenceOf(next);
    const ctx = { ...lineageContext(f.review), entities: [
      { artifact: referenceOf(f.prod), entities: [...scope, { id: "O2", hash: hash(881) }] },
      { artifact: referenceOf(next), entities: [...scope, { id: "O2", hash: hash(882) }] },
    ] };
    expect(artifactApplicability(ctx, referenceOf(f.req)).applicable).toBe(true);
    expect(artifactApplicability(ctx, referenceOf(f.ts)).applicable).toBe(true);
    expect(artifactApplicability({ ...ctx, entities: [] }, referenceOf(f.req)).applicable).toBe(false);
    ctx.entities[1]!.entities[0] = { ...scope[0]!, hash: hash(883) };
    expect(artifactApplicability(ctx, referenceOf(f.req)).applicable).toBe(false);
  });
  test("fine-grained Slice ownership change affects only dependent task artifact", () => {
    const f = fixture(), next = artifact("slice-plan", "slices_next", [referenceOf(f.pd)], 983);
    const scope = [{ id: f.slices.slices[0]!.id, hash: hash(884) }];
    f.ts.lineage = f.ts.lineage.map((e) => e.target.kind === "slice-plan" ? { relation: "derived_from", target: e.target, scope } : e);
    f.review.revisions.push(next); f.spec.artifacts.current.find((s) => s.artifact.kind === "slice-plan")!.artifact = referenceOf(next);
    const ctx = { ...lineageContext(f.review), entities: [{ artifact: referenceOf(f.sl), entities: scope }, { artifact: referenceOf(next), entities: [...scope, { id: "S2", hash: hash(885) }] }] };
    expect(artifactApplicability(ctx, referenceOf(f.ts)).applicable).toBe(true);
    ctx.entities[1]!.entities[0] = { ...scope[0]!, hash: hash(886) };
    expect(artifactApplicability(ctx, referenceOf(f.ts)).applicable).toBe(false);
  });
});
describe("INV-SPEC-003 / INV-APPROVAL-003 / INV-COMPLETE-001", () => {
  test.each([
    ["requirement-product-coverage-missing", "R1"], ["requirement-slice-missing", "R1"],
    ["architecture-program-design-missing", "A1"], ["program-design-task-missing", "PD1"],
    ["product-outcome-requirement-missing", "O1"], ["product-success-requirement-missing", "SC1"],
  ])("coverage waiver %s validates the appropriate stable subject identity", (code, subject) => {
    expect(waiverScopeSchema.safeParse({ code, subject }).success).toBe(true);
    expect(waiverScopeSchema.safeParse({ code, subject: "T1" }).success).toBe(false);
  });
  test("Product evidence obligations cannot be waived into fabricated proof", () => {
    expect(waiverScopeSchema.safeParse({ code: "product-success-evidence-missing", subject: "SC1" }).success).toBe(false);
  });
  test("retired generic Design and design-first are not canonical inputs", () => {
    const f = fixture();
    expect(specModeSchema.safeParse("design-first").success).toBe(false);
    expect(artifactRevisionSchema.safeParse({ ...f.des, kind: "design", schema: "aira.dev/artifact-revision/v1" }).success).toBe(false);
    expect(specSchema.safeParse({ ...f.spec, schema: "aira.dev/spec/v1" }).success).toBe(false);
  });
  test.each([...planningKinds])("exact %s approval is invalidated by a changed hash", (kind) => {
    const f = fixture(), record = f.review.approvals.find((a) => a.subjects[0]!.artifact.kind === kind)!;
    expect(approvalApplicability(record, record.subjects[0]!, decisionContext(f.review))).toEqual([]);
    f.spec.artifacts.current.find((s) => s.artifact.kind === kind)!.artifact.hash = hash(987);
    expect(approvalApplicability(record, record.subjects[0]!, decisionContext(f.review)).length).toBeGreaterThan(0);
  });
  test.each([...planningKinds])("quick cannot omit %s from its exact integrated approval/snapshot", (kind) => {
    const f = fixture("quick"), approval = f.review.approvals[0]!, subjects = approval.subjects.filter((s) => s.artifact.kind !== kind);
    expect(specApprovalRecordSchema.safeParse({ ...approval, subjects }).success).toBe(false);
    expect(approvedSpecSnapshotSchema.safeParse({ ...f.run.snapshot, artifacts: f.run.snapshot.artifacts.filter((s) => s.artifact.kind !== kind) }).success).toBe(false);
    expect(integratedApprovalApplicability(approval, decisionContext(f.review))).toEqual([]);
  });
  test.each([...planningKinds])("missing %s canonical artifact blocks completion with a stable layer code", (kind) => {
    const f = fixture(); f.spec.artifacts.current = f.spec.artifacts.current.filter((s) => s.artifact.kind !== kind);
    expect(evaluateSpecCompletion(f).blockers.map((i) => i.code)).toContain(`${kind}-missing`);
  });
  test.each(["product", "architecture", "program-design", "slice-plan"] as const)("stale %s blocks completion explicitly", (kind) => {
    const f = fixture(); f.spec.lineage.invalidations.push({ schema: "aira.dev/artifact-invalidation/v2", subject: f.spec.artifacts.current.find((s) => s.artifact.kind === kind)!.artifact,
      generation: f.spec.generation, reason: "Relevant revision", created: f.spec.created });
    expect(evaluateSpecCompletion(f).blockers.map((i) => i.code)).toContain(`${kind}-stale`);
  });
  test("Slice and Product evidence obligations are completion gates, not worker assertions", () => {
    const f = fixture(); f.run.slices[0]!.status = "pending";
    expect(evaluateSpecCompletion(f).blockers.map((i) => i.code)).toContain("slice-not-completed");
    f.run.slices[0]!.status = "completed"; f.run.slices[0]!.current_evidence = [];
    expect(evaluateSpecCompletion(f).blockers.map((i) => i.code)).toContain("slice-verification-missing");
    f.requirements.requirements[0]!.success_criteria = [];
    expect(evaluateSpecCompletion(f).blockers.map((i) => i.code)).toContain("product-success-evidence-missing");
  });
  test("architecture-first validates unchanged content before Program Design", () => {
    const f = fixture("architecture-first"), before = JSON.stringify(f.des);
    f.spec.lifecycle = { state: "validating-architecture" };
    expect(evaluateLifecycleTransition(f.review, { state: "drafting-program-design" }).ok).toBe(true);
    f.spec.lineage.validations = [];
    expect(evaluateLifecycleTransition(f.review, { state: "drafting-program-design" }).ok).toBe(false);
    expect(JSON.stringify(f.des)).toBe(before);
  });
  test("architecture-first Requirements cannot omit their Architecture authoring input", () => {
    const f = fixture("architecture-first"); f.req.lineage = f.req.lineage.filter((e) => e.target.kind !== "architecture");
    expect(evaluateSpecGates(f.review)).toContainEqual({ code: "planning-lineage-incomplete", subject: "requirements", related: ["architecture"] });
  });
  test.each(["requirements-first", "architecture-first", "quick"] as const)("%s requires all planning analyses", (mode) => {
    const f = fixture(mode); expect(evaluateSpecGates(f.review)).toEqual([]);
    for (const kind of planningKinds) {
      const review = { ...f.review, analyses: f.review.analyses.filter((a) => a.phase !== kind) };
      expect(evaluateSpecGates(review).map((i) => i.code)).toContain("required-analysis-missing");
    }
    expect(evaluateSpecCompletion(f).complete).toBe(true);
  });
});
