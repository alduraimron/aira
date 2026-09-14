import { describe, expect, test } from "bun:test";
import * as ids from "../../src/spec/domain/ids";
import { productDefinitionSchema, validateProduct } from "../../src/spec/domain/product";
import { requirementsSchema, validateRequirementsProduct } from "../../src/spec/domain/requirements";
import { architectureSchema, validateArchitecture } from "../../src/spec/domain/architecture";
import { programDesignSchema, validateProgramDesign } from "../../src/spec/domain/program-design";
import { planningEntities, validateFindingTargets } from "../../src/spec/domain/planning-integrity";
import { analysisFindingSchema, analysisSchema, productFindingCategories, architectureFindingCategories, programDesignFindingCategories, sliceFindingCategories } from "../../src/spec/domain/analysis";
import { blockingFindingIssues, evaluateApprovalEligibility } from "../../src/spec/domain/review";
import { referenceOf } from "../../src/spec/domain/artifacts";
import { fixture, metadata } from "../domain-v2/fixtures";

const formats = [
  ["O", ids.productOutcomeIdSchema], ["SC", ids.successCriterionIdSchema], ["A", ids.architectureDecisionIdSchema],
  ["PD", ids.programDesignDecisionIdSchema], ["S", ids.sliceIdSchema],
] as const;
describe("INV-PRODUCT-001 / INV-PROGDESIGN-001: identity and structured contracts", () => {
  for (const [prefix, schema] of formats) {
    test(`${prefix} identity grammar, no array-derived identity`, () => {
      expect(String(schema.parse(`${prefix}999`))).toBe(`${prefix}999`);
      for (const value of [`${prefix}0`, `${prefix}01`, `${prefix.toLowerCase()}1`, `${prefix}1.0`, ` ${prefix}1`, `${prefix}-1`]) expect(schema.safeParse(value).success).toBe(false);
    });
    test(`${prefix} removal requires a tombstone and retirement prohibits reuse`, () => {
      const previous = ids.identityRegistrySchema.parse({ schema: "aira.dev/identity-registry/v2", entries: [{ id: `${prefix}1`, introduced_in: "rev_first" }] });
      const active = [previous.entries[0]!.id];
      expect(ids.validateIdentityChange(previous, previous, active, []).map((i) => i.code)).toContain("identity-retirement-missing");
      const retired = ids.identityRegistrySchema.parse({ ...previous, entries: [{ ...previous.entries[0], retired_in: "rev_second" }] });
      expect(ids.validateIdentityChange(previous, retired, active, [])).toEqual([]);
      expect(ids.validateIdentityChange(retired, retired, [], active).map((i) => i.code)).toContain("identity-reused");
    });
  }
  test("product is structured, strict and distinct from Requirements", () => {
    const f = fixture(); expect(validateProduct(f.product)).toEqual([]);
    expect(requirementsSchema.safeParse(f.product).success).toBe(false);
    expect(productDefinitionSchema.safeParse({ ...f.product, requirements: [] }).success).toBe(false);
  });
  test.each(["problem", "current_pain_or_opportunity"] as const)("Product rejects blank %s", (field) => {
    expect(validateProduct({ ...fixture().product, [field]: " \n" }).length).toBeGreaterThan(0);
  });
  test.each(["outcomes", "success_criteria", "stakeholders"] as const)("Product requires meaningful %s", (field) => {
    expect(validateProduct({ ...fixture().product, [field]: [] }).length).toBeGreaterThan(0);
  });
  test("duplicate outcomes/success and unknown success-to-outcome references fail", () => {
    const p = fixture().product;
    expect(validateProduct({ ...p, outcomes: [p.outcomes[0], p.outcomes[0]] }).length).toBeGreaterThan(0);
    expect(validateProduct({ ...p, success_criteria: [p.success_criteria[0], p.success_criteria[0]] }).length).toBeGreaterThan(0);
    expect(validateProduct({ ...p, success_criteria: [{ ...p.success_criteria[0], outcomes: ["O9"] }] }).length).toBeGreaterThan(0);
  });
  test("Product reorder preserves identities, criterion mapping, and entity lookup", () => {
    const p = productDefinitionSchema.parse({ ...fixture().product, outcomes: [{ id: "O2", statement: "Second outcome" }, ...fixture().product.outcomes],
      success_criteria: [...fixture().product.success_criteria, { id: "SC2", outcomes: ["O2"], statement: "Second criterion" }] });
    const next = productDefinitionSchema.parse({ ...p, outcomes: [...p.outcomes].reverse(), success_criteria: [...p.success_criteria].reverse() });
    expect(planningEntities(p).find((e) => e.id === "O1")).toEqual(planningEntities(next).find((e) => e.id === "O1"));
    expect(next.success_criteria.find((s) => s.id === "SC2")!.outcomes.map(String)).toEqual(["O2"]);
  });
  test("Requirement mapping permits technical constraints without invented intent", () => {
    const f = fixture(); const technical = requirementsSchema.parse({ ...f.requirements, requirements: [{ ...f.requirements.requirements[0], type: "constraint", product_outcomes: [], success_criteria: [] }] });
    expect(validateRequirementsProduct(technical, f.product)).toEqual([]);
    expect(validateRequirementsProduct(f.requirements, f.product)).toEqual([]);
  });
  test("MUST functional behavior requires Product traceability; SC alone is a valid mapping", () => {
    const f = fixture(); f.requirements.requirements[0]!.product_outcomes = [];
    expect(validateRequirementsProduct(f.requirements, f.product)).toEqual([]);
    f.requirements.requirements[0]!.success_criteria = [];
    expect(validateRequirementsProduct(f.requirements, f.product)).toContainEqual({ code: "requirement-product-coverage-missing", requirement: "R1" });
  });
  test("Requirement Product/SC references reject unknown identities", () => {
    const f = fixture(); f.requirements.requirements[0]!.product_outcomes = [ids.productOutcomeIdSchema.parse("O9")];
    f.requirements.requirements[0]!.success_criteria = [ids.successCriterionIdSchema.parse("SC9")];
    expect(validateRequirementsProduct(f.requirements, f.product).map((i) => i.code)).toEqual(["unknown-requirement-product-outcome", "unknown-requirement-success-criterion"]);
  });
  test("Architecture validates exact Requirement/AC catalog and AC ownership", () => {
    const f = fixture(); expect(validateArchitecture(f.architecture, f.requirements)).toEqual([]);
    const a = architectureSchema.parse({ ...f.architecture, decisions: [{ ...f.architecture.decisions[0], requirements: ["R9"], acceptance_criteria: ["R1.AC9"] }] });
    const codes = validateArchitecture(a, f.requirements).map((i) => i.code);
    for (const code of ["unknown-architecture-requirement", "unknown-architecture-acceptance-criterion", "architecture-acceptance-parent-missing"]) expect(codes).toContain(code);
    expect(architectureSchema.safeParse({ ...a, decisions: [{ ...a.decisions[0], acceptance_criteria: ["AC1"] }] }).success).toBe(false);
  });
  test("architecture-first proposal can exist before Requirements without invented R IDs", () => {
    const a = architectureSchema.parse({ ...fixture().architecture, decisions: [{ ...fixture().architecture.decisions[0], requirements: [], acceptance_criteria: [] }] });
    expect(validateArchitecture(a)).toEqual([]);
    expect(validateArchitecture(fixture().architecture).map((i) => i.code)).toContain("architecture-requirements-unavailable");
  });
  test("Architecture dependency endpoints must name affected components", () => {
    const f = fixture(), a = architectureSchema.parse({ ...f.architecture, sections: { dependencies: [{ from: "API", to: "Store", rationale: "Persist" }] } });
    expect(validateArchitecture(a, f.requirements).map((i) => i.code)).toEqual(["unknown-architecture-component", "unknown-architecture-component"]);
  });
  test("Architecture and Program Design cannot share schema semantics", () => {
    const f = fixture(); expect(programDesignSchema.safeParse(f.architecture).success).toBe(false);
    expect(architectureSchema.safeParse(f.program_design).success).toBe(false);
    expect(architectureSchema.safeParse({ ...f.architecture, schema: "aira.dev/design/v1" }).success).toBe(false);
  });
  test("Program Design records files, signatures, call/error paths, transitions and tests", () => {
    const f = fixture(); expect(validateProgramDesign(f.program_design, f.architecture, f.requirements)).toEqual([]);
    expect(f.program_design.symbols[0]!.signature).toContain("AsyncIterable");
    expect(f.program_design.call_paths[0]!.symbols).toEqual(["exportRecords"]);
    expect(f.program_design.error_flows[0]!.visible_result).toBe("Retryable error");
    expect(f.program_design.transformations[0]!.preserved_invariants).toEqual(["Read-only"]);
  });
  test.each(["architecture", "file", "symbol", "call-path", "test-symbol"] as const)("Program Design rejects unknown %s reference", (kind) => {
    const f = fixture(), p = f.program_design;
    if (kind === "architecture") p.decisions[0]!.architecture_decisions = [ids.architectureDecisionIdSchema.parse("A9")];
    if (kind === "file") p.symbols[0]!.file = "src/unknown.ts";
    if (kind === "symbol") p.decisions[0]!.symbols = ["unknown"];
    if (kind === "call-path") p.call_paths[0]!.symbols = ["unknown"];
    if (kind === "test-symbol") p.tests[0]!.symbols = ["unknown"];
    expect(validateProgramDesign(p, f.architecture, f.requirements).length).toBeGreaterThan(0);
  });
  test("A and PD decisions preserve IDs under reorder and reject duplicate IDs", () => {
    const f = fixture(), a = architectureSchema.parse({ ...f.architecture, decisions: [f.architecture.decisions[0], { ...f.architecture.decisions[0], id: "A2" }] });
    expect(architectureSchema.parse({ ...a, decisions: [...a.decisions].reverse() }).decisions.find((d) => d.id === "A1")).toEqual(a.decisions[0]!);
    expect(architectureSchema.safeParse({ ...a, decisions: [a.decisions[0], a.decisions[0]] }).success).toBe(false);
    const p = programDesignSchema.parse({ ...f.program_design, decisions: [f.program_design.decisions[0], { ...f.program_design.decisions[0], id: "PD2" }] });
    expect(programDesignSchema.parse({ ...p, decisions: [...p.decisions].reverse() }).decisions.find((d) => d.id === "PD1")).toEqual(p.decisions[0]!);
    expect(programDesignSchema.safeParse({ ...p, decisions: [p.decisions[0], p.decisions[0]] }).success).toBe(false);
  });
  test("Program Design uncertainty can require human clarification", () => {
    const p = fixture().program_design; p.decisions[0]!.uncertainty = { status: "human-clarification-required", confidence: "low", risk: "Unknown ownership", open_alternatives: ["Stream", "Batch"], questions: ["Which owner?"] };
    expect(programDesignSchema.safeParse(p).success).toBe(true);
    p.decisions[0]!.uncertainty.questions = [];
    expect(programDesignSchema.safeParse(p).success).toBe(false);
  });
});

for (const [phase, categories, kind] of [["product", productFindingCategories, "product"], ["architecture", architectureFindingCategories, "architecture"],
  ["program-design", programDesignFindingCategories, "program-design"], ["slice-plan", sliceFindingCategories, "slice-plan"]] as const) {
  test.each([...categories])(`${phase} analysis category %s uses common blockers/disposition policy`, (category) => {
    const f = fixture(), subject = f.spec.artifacts.current.find((s) => s.artifact.kind === kind)!;
    const finding = analysisFindingSchema.parse({ id: "finding_planning", category, severity: "blocker", title: "Review concern", description: "Requires a decision",
      subjects: [subject.artifact], targets: [{ kind: "artifact", artifact: subject.artifact }], disposition: { state: "unresolved" } });
    f.review.analyses.find((a) => a.phase === phase)!.findings = [finding];
    expect(blockingFindingIssues(f.review).map((i) => i.code)).toContain("unresolved-blocker");
    expect(evaluateApprovalEligibility(f.review, [subject]).map((i) => i.code)).toContain("unresolved-blocker");
    finding.disposition = { state: "dismissed", rationale: "Human accepted context", actor: { kind: "human", id: "local" }, at: metadata.at };
    expect(blockingFindingIssues(f.review)).toEqual([]);
  });
}
test("cross-artifact contradiction binds A and PD without rewriting Architecture", () => {
  const f = fixture(), before = JSON.stringify(f.architecture);
  const references = [{ kind: "architecture-decision", artifact: referenceOf(f.des), id: "A1" }, { kind: "program-design-decision", artifact: referenceOf(f.pd), id: "PD1" }];
  const finding = analysisFindingSchema.parse({ id: "finding_contradiction", category: "architecture-contradiction", severity: "blocker", title: "Wrong ownership", description: "PD crosses A boundary",
    subjects: [referenceOf(f.des), referenceOf(f.pd)], targets: [{ kind: "relationship", references, description: "Implements" }], disposition: { state: "unresolved" } });
  const a = analysisSchema.parse({ schema: "aira.dev/analysis/v2", spec_id: f.spec.id, revision: "rev_contradiction", phase: "program-design", inputs: finding.subjects, created: metadata, outcome: "inconsistent", findings: [finding] });
  expect(validateFindingTargets([a], [f.architecture, f.program_design])).toEqual([]);
  expect(validateFindingTargets([a], [f.architecture]).map((i) => i.code)).toContain("unknown-finding-entity");
  expect(JSON.stringify(f.architecture)).toBe(before);
});
