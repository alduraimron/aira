import { describe, expect, test } from "bun:test";
import { evidenceApplicability, evidencePasses } from "../../src/verification/applicability";
import { verificationEvidenceSchema, verifierDefinitionSchema } from "../../src/verification/schema";
import { buildTraceability } from "../../src/spec/domain/traceability";
import { requirementSchema } from "../../src/spec/domain/requirements";
import { artifactRevisionIdSchema, evidenceIdSchema } from "../../src/spec/domain/ids";
import { fixture, hash } from "./fixtures";

const trace = (f: ReturnType<typeof fixture>) => buildTraceability({ product: f.product, program_design: f.program_design, slices: f.slices,
  artifacts: f.spec.artifacts.current.map((s) => s.artifact), requirements: f.requirements, architecture: f.architecture, tasks: f.tasks, plan: f.plan,
  evidence: f.evidence, evidence_contexts: [f.evidenceContext], policy: f.spec.completion_policy });

describe("INV-EVIDENCE-001/002/003: immutable observations with current applicability", () => {
  test("exact workspace and all current bindings pass", () => {
    const f = fixture(); expect(evidenceApplicability(f.record, f.evidenceContext)).toEqual({ applicable: true, reasons: [] });
    expect(evidencePasses(f.record, f.evidenceContext)).toBe(true);
  });
  test("historical evidence is still representable after drift", () => {
    const f = fixture(), before = JSON.stringify(f.record);
    const result = evidenceApplicability(f.record, { ...f.evidenceContext, workspace: { ...f.workspace.fingerprint, digest: hash(800) } });
    expect(result.applicable).toBe(false); expect(result.reasons.map((i) => i.code)).toContain("evidence-workspace-mismatch");
    expect(verificationEvidenceSchema.parse(f.record)).toEqual(f.record); expect(JSON.stringify(f.record)).toBe(before);
  });
  test.each(["verifier", "profile", "policy"] as const)("changed %s identity prevents reuse", (field) => {
    const f = fixture(); f.record[field].hash = hash(801);
    expect(evidenceApplicability(f.record, f.evidenceContext).applicable).toBe(false);
  });
  test("revision-stable task IDs do not imply unchanged task definitions", () => {
    const f = fixture(); f.record.task.revision = artifactRevisionIdSchema.parse("rev_older");
    expect(evidenceApplicability(f.record, f.evidenceContext).reasons.map((i) => i.code)).toContain("evidence-task-mismatch");
  });
  test("workspace mutation across evidence interval cannot assert stable state", () => {
    const f = fixture(); f.record.workspace_after.digest = hash(802);
    expect(evidenceApplicability(f.record, f.evidenceContext).reasons.map((i) => i.code)).toContain("evidence-observation-unstable");
  });
  test("matching workspace alone cannot bypass backend or attempt fence", () => {
    const f = fixture(); f.record.backend.identity.configuration_hash = hash(803);
    expect(evidenceApplicability(f.record, f.evidenceContext).reasons.map((i) => i.code)).toContain("evidence-backend-mismatch");
    const ctx = { ...f.evidenceContext, authority: { ...f.evidenceContext.authority, status: "fenced" as const } };
    expect(evidenceApplicability(f.record, ctx).reasons.map((i) => i.code)).toContain("evidence-attempt-fenced");
  });
  test("failed evidence can be applicable but cannot be passing", () => {
    const f = fixture(); f.record.outcome = "failed";
    expect(evidenceApplicability(f.record, f.evidenceContext).applicable).toBe(true);
    expect(evidencePasses(f.record, f.evidenceContext)).toBe(false);
  });
  test("superseded selection is historical even at the same fingerprint", () => {
    const f = fixture();
    expect(evidenceApplicability(f.record, { ...f.evidenceContext, selected_evidence: evidenceIdSchema.parse("evidence_new") }).reasons.map((i) => i.code)).toContain("evidence-not-selected");
  });
  test("unsupported future scope contract fails closed rather than broadening history", () => {
    const f = fixture();
    expect(verificationEvidenceSchema.safeParse({ ...f.record, applicability: { schema: "aira.dev/evidence-applicability/scoped/v1", paths: ["src/*"] } }).success).toBe(false);
    const unsafe = { ...f.record, applicability: { schema: "aira.dev/evidence-applicability/scoped/v1" } } as unknown as typeof f.record;
    expect(evidenceApplicability(unsafe, f.evidenceContext).reasons.map((i) => i.code)).toContain("unsupported-evidence-applicability");
  });
  test("human/agent review obligations check actor kind and policy", () => {
    const f = fixture();
    const humanVerifier = verifierDefinitionSchema.parse({ ...f.plan.verifiers[0]!, definition: { kind: "human-review", rubric: "Confirm export", actor_kind: "human" } });
    const ctx = { ...f.evidenceContext, verifier: humanVerifier };
    expect(evidencePasses(f.record, ctx)).toBe(false);
    f.record.review_actor = { kind: "human", id: "local" };
    expect(evidencePasses(f.record, ctx)).toBe(true);
  });
  test("all future verifier forms have structured strict definitions", () => {
    const common = fixture().plan.verifiers[0]!;
    const definitions = [
      { kind: "file-state", checks: [{ path: "src/export.ts", state: "present", hash: hash(804) }] },
      { kind: "repository-state", checks: [{ predicate: "no-conflicts", expected: "true" }] },
      { kind: "static-analysis", analyzer: fixture().plan.profile, rules: ["no-unsafe-auth"] },
      { kind: "agent-review", rubric: "Inspect race cases", review_profile: fixture().plan.profile },
      { kind: "external", provider: fixture().plan.profile, contract: "test-server-report" },
      { kind: "custom", contract: fixture().plan.profile, configuration: { rubric: "domain-specific" } },
    ];
    for (const definition of definitions) {
      expect(verifierDefinitionSchema.safeParse({ ...common, definition }).success).toBe(true);
      expect(verifierDefinitionSchema.safeParse({ ...common, definition: { ...definition, surprise: true } }).success).toBe(false);
    }
  });
});

describe("INV-TRACE-001: structured revision-bound coverage, not Markdown", () => {
  test("complete chain and requirement queries", () => {
    const f = fixture(), report = trace(f);
    expect(report.issues).toEqual([]);
    expect(report.requirements[0]).toMatchObject({ requirement: "R1", architecture_decisions: ["A1"], tasks: ["T1"], verifiers: ["V1"], applicable_evidence: ["evidence_one"],
      acceptance_criteria: [{ id: "R1.AC1", tasks: ["T1"], verifiers: ["V1"] }] });
    const edges = report.edges.map((e) => `${e.from.kind}:${e.to.kind}`);
    for (const edge of ["requirement:acceptance-criterion", "acceptance-criterion:architecture-decision", "architecture-decision:task", "task:verifier", "verifier:evidence"]) expect(edges).toContain(edge);
    expect(report.edges.every((e) => e.from.revision.length > 0 && e.to.revision.length > 0)).toBe(true);
  });
  test("uncovered MUST implementation/architecture/verification obligations", () => {
    const f = fixture(); f.requirements.requirements.push(requirementSchema.parse({ ...f.requirements.requirements[0]!, id: "R2",
      acceptance_criteria: [{ id: "R2.AC1", form: "ubiquitous", expected_behavior: "Encrypt exports" }] }));
    const codes = trace(f).issues.filter((i) => i.requirement === "R2").map((i) => i.code);
    for (const code of ["requirement-architecture-missing", "requirement-implementation-missing", "requirement-verification-missing", "acceptance-implementation-missing", "acceptance-verification-missing"]) expect(codes).toContain(code);
  });
  test("MUST missing required verifier is not covered by an optional unrelated check", () => {
    const f = fixture(); f.plan.required_verifiers = []; f.tasks.tasks[0]!.completion = [{ kind: "artifact-published", artifact: f.spec.artifacts.current[1]!.artifact }];
    expect(trace(f).issues.map((i) => i.code)).toContain("requirement-verification-missing");
  });
  test("must/should/could enforcement follows explicit completion policy", () => {
    const f = fixture(); f.architecture.decisions = []; f.tasks.tasks = []; f.plan.verifiers = [];
    // Isolate Requirement priority policy from independent Product and planning coverage policies.
    f.spec.completion_policy.product_coverage = { outcomes: false, success_criteria: false, evidence: false };
    f.spec.completion_policy.planning_coverage = { architecture_implementation: false, program_design_exercised: false };
    f.requirements.requirements[0]!.priority = "should";
    expect(trace(f).issues.filter((i) => i.requirement === "R1" && i.code.endsWith("-missing"))).toEqual([]);
    f.spec.completion_policy.traceability = "must-and-should";
    expect(trace(f).issues.map((i) => i.code)).toContain("requirement-implementation-missing");
    f.requirements.requirements[0]!.priority = "could";
    expect(trace(f).issues.filter((i) => i.requirement === "R1" && i.code.endsWith("-missing"))).toEqual([]);
    f.spec.completion_policy.traceability = "all";
    expect(trace(f).issues.map((i) => i.code)).toContain("requirement-implementation-missing");
  });
  test("applicable evidence query drops workspace-stale observations", () => {
    const f = fixture(); f.evidenceContext.workspace.digest = hash(805);
    expect(trace(f).requirements[0]!.applicable_evidence).toEqual([]);
    expect(trace(f).evidence[0]!.applicable).toBe(false);
  });
});
