import type { Requirements } from "./requirements";
import { validateArchitecture, type SystemArchitecture } from "./architecture";
import type { Tasks } from "../../tasks/types";
import type { VerificationEvidence, VerificationPlan } from "../../verification/types";
import { evidenceApplicability, type EvidenceContext } from "../../verification/applicability";
import { compareText, stableIssues, type DomainIssue } from "./primitives";
import type { SpecCompletionPolicy } from "./types";
import { validateRequirementsProduct } from "./requirements";
import type { ProductDefinition } from "./product";
import { validateProgramDesign, type ProgramDesign } from "./program-design";
import { slicePredecessors, validateSliceReferences, validateTaskSliceConsistency, type SlicePlan } from "./slices";
import type { ArtifactReference } from "./artifacts";

export interface TraceabilityInput {
  readonly product: ProductDefinition; readonly program_design: ProgramDesign; readonly slices: SlicePlan;
  readonly artifacts: readonly ArtifactReference[];
  readonly requirements: Requirements;
  readonly architecture: SystemArchitecture;
  readonly tasks: Tasks;
  readonly plan: VerificationPlan;
  readonly evidence: readonly VerificationEvidence[];
  readonly evidence_contexts: readonly EvidenceContext[];
  readonly policy: SpecCompletionPolicy;
}
export interface TraceNode { readonly kind: "product-outcome" | "success-criterion" | "requirement" | "acceptance-criterion" | "architecture-decision" | "program-design-decision" | "slice" | "task" | "verifier" | "evidence"; readonly id: string; readonly revision: string; readonly hash?: string }
export interface TraceEdge { readonly from: TraceNode; readonly to: TraceNode }
export interface RequirementCoverage {
  readonly requirement: string;
  readonly enforced: boolean;
  readonly architecture_decisions: readonly string[];
  readonly tasks: readonly string[];
  readonly verifiers: readonly string[];
  readonly required_verifiers: readonly string[];
  readonly applicable_evidence: readonly string[];
  readonly acceptance_criteria: readonly { id: string; tasks: readonly string[]; verifiers: readonly string[]; required_verifiers: readonly string[] }[];
}
export interface ProductCoverage { readonly id: string; readonly requirements: readonly string[]; readonly evidence: readonly string[] }
export interface TraceabilityReport {
  readonly product_outcomes: readonly ProductCoverage[];
  readonly success_criteria: readonly ProductCoverage[];
  readonly edges: readonly TraceEdge[];
  readonly requirements: readonly RequirementCoverage[];
  readonly evidence: readonly { id: string; applicable: boolean; passing: boolean; reasons: readonly DomainIssue[] }[];
  readonly issues: readonly DomainIssue[];
}
/** Structured graph query, independent of Markdown and array ordering. */
export function traceReachable(report: TraceabilityReport, from: Pick<TraceNode, "kind" | "id">, targetKind: TraceNode["kind"]): TraceNode[] {
  const seen = new Map<string, TraceNode>(), todo = report.edges.filter((e) => e.from.kind === from.kind && e.from.id === from.id).map((e) => e.to);
  while (todo.length) {
    const next = todo.pop()!, key = `${next.kind}:${next.id}:${next.revision}`;
    if (seen.has(key)) continue;
    seen.set(key, next); todo.push(...report.edges.filter((e) => e.from.kind === next.kind && e.from.id === next.id && e.from.revision === next.revision).map((e) => e.to));
  }
  return [...seen.values()].filter((n) => n.kind === targetKind).sort((a, b) => compareText(a.id, b.id));
}
/** Concurrent incomparable first increments return a set, never a lexical guess. */
export function firstObservableSlices(plan: SlicePlan, requirement: string): readonly string[] {
  const candidates = plan.slices.filter((s) => s.requirements.some((r) => r === requirement));
  return candidates.filter((s) => !candidates.some((p) => slicePredecessors(plan, s.id).includes(p.id))).map((s) => s.id).sort(compareText);
}
export function buildTraceability(input: TraceabilityInput): TraceabilityReport {
  const issues: DomainIssue[] = [...validateArchitecture(input.architecture, input.requirements), ...validateRequirementsProduct(input.requirements, input.product),
    ...validateProgramDesign(input.program_design, input.architecture, input.requirements),
    ...validateSliceReferences(input.slices, input.product, input.requirements, input.architecture, input.program_design, input.plan),
    ...validateTaskSliceConsistency(input.slices, input.tasks)], edges: TraceEdge[] = [];
  const node = (kind: TraceNode["kind"], id: string, revision: string): TraceNode => {
    const hash = input.artifacts.find((a) => a.revision === revision)?.hash ??
      input.tasks.tasks.find((t) => t.identity.id === id && t.identity.revision === revision)?.identity.hash ??
      input.plan.verifiers.find((v) => v.identity.id === id && v.identity.revision === revision)?.identity.hash;
    return { kind, id, revision, ...(hash ? { hash } : {}) };
  };
  const add = (from: TraceNode, to: TraceNode): void => { edges.push({ from, to }); };
  const evidence = [...input.evidence].sort((a, b) => compareText(a.id, b.id)).map((record) => {
    const contexts = input.evidence_contexts.filter((c) => c.task.id === record.task.id && c.verifier.identity.id === record.verifier.id && c.attempt.id === record.attempt);
    const applicability = contexts.length === 1 ? evidenceApplicability(record, contexts[0]!) :
      { applicable: false, reasons: [{ code: "evidence-authority-missing", subject: record.id }] };
    add(node("verifier", record.verifier.id, record.verifier.revision), node("evidence", record.id, record.id));
    return { id: record.id, applicable: applicability.applicable, passing: applicability.applicable && record.outcome === "passed", reasons: applicability.reasons };
  });
  for (const criterion of input.product.success_criteria) for (const outcome of criterion.outcomes)
    add(node("product-outcome", outcome, input.product.revision), node("success-criterion", criterion.id, input.product.revision));
  for (const r of input.requirements.requirements) {
    for (const id of r.product_outcomes) add(node("product-outcome", id, input.product.revision), node("requirement", r.id, input.requirements.revision));
    for (const id of r.success_criteria) add(node("success-criterion", id, input.product.revision), node("requirement", r.id, input.requirements.revision));
  }
  for (const a of input.architecture.decisions) {
    const designs = input.program_design.decisions.filter((p) => p.architecture_decisions.includes(a.id));
    for (const p of designs) add(node("architecture-decision", a.id, input.architecture.revision), node("program-design-decision", p.id, input.program_design.revision));
    if (!designs.length && input.policy.planning_coverage.architecture_implementation) issues.push({ code: "architecture-program-design-missing", subject: a.id });
  }
  for (const p of input.program_design.decisions) {
    const slices = input.slices.slices.filter((s) => s.program_design_decisions.includes(p.id));
    for (const s of slices) add(node("program-design-decision", p.id, input.program_design.revision), node("slice", s.id, input.slices.revision));
    if (!input.tasks.tasks.some((t) => t.program_design_decisions.includes(p.id) && slices.some((s) => s.id === t.slice && s.tasks.includes(t.identity.id))) &&
      input.policy.planning_coverage.program_design_exercised) issues.push({ code: "program-design-task-missing", subject: p.id });
  }
  for (const task of input.tasks.tasks) {
    for (const id of task.program_design_decisions) if (!input.program_design.decisions.some((d) => d.id === id)) issues.push({ code: "unknown-task-program-design-decision", task: task.identity.id, subject: id });
    for (const id of task.architecture_decisions) if (!input.architecture.decisions.some((d) => d.id === id)) issues.push({ code: "unknown-task-architecture-decision", task: task.identity.id, subject: id });
  }
  for (const s of input.slices.slices) {
    for (const t of input.tasks.tasks.filter((t) => t.slice === s.id && s.tasks.includes(t.identity.id)))
      add(node("slice", s.id, input.slices.revision), node("task", t.identity.id, t.identity.revision));
    for (const v of input.plan.verifiers.filter((v) => v.slices.includes(s.id) && s.required_verifiers.includes(v.identity.id)))
      add(node("slice", s.id, input.slices.revision), node("verifier", v.identity.id, v.identity.revision));
  }
  for (const verifier of input.plan.verifiers) {
    for (const id of verifier.slices) if (!input.slices.slices.some((s) => s.id === id))
      issues.push({ code: "unknown-verifier-slice", verifier: verifier.identity.id, subject: id });
    for (const id of verifier.requirements) if (!input.requirements.requirements.some((r) => r.id === id))
      issues.push({ code: "unknown-verifier-requirement", verifier: verifier.identity.id, requirement: id });
    for (const ac of verifier.acceptance_criteria) if (!input.requirements.requirements.some((r) => r.acceptance_criteria.some((a) => a.id === ac)))
      issues.push({ code: "unknown-verifier-acceptance-criterion", verifier: verifier.identity.id, subject: ac });
    for (const id of verifier.tasks) if (!input.tasks.tasks.some((t) => t.identity.id === id && t.verifiers.includes(verifier.identity.id)))
      issues.push({ code: "verifier-task-link-missing", verifier: verifier.identity.id, task: id });
  }
  const requirements = [...input.requirements.requirements].sort((a, b) => compareText(a.id, b.id)).map((r): RequirementCoverage => {
    const enforced = r.priority === "must" || input.policy.traceability === "all" || (r.priority === "should" && input.policy.traceability === "must-and-should");
    const decisions = input.architecture.decisions.filter((d) => d.requirements.includes(r.id));
    const tasks = input.tasks.tasks.filter((t) => t.requirements.includes(r.id));
    const implementations = tasks.filter((t) => t.required && t.architecture_decisions.some((d) => decisions.some((decision) => decision.id === d)) &&
      t.program_design_decisions.some((id) => input.program_design.decisions.some((p) => p.id === id && p.architecture_decisions.some((a) => decisions.some((d) => d.id === a)))) &&
      input.slices.slices.some((s) => s.id === t.slice && s.tasks.includes(t.identity.id) && s.requirements.includes(r.id) &&
        s.program_design_decisions.some((p) => t.program_design_decisions.includes(p))));
    const verifiers = input.plan.verifiers.filter((v) => v.requirements.includes(r.id) && tasks.some((t) =>
      v.tasks.includes(t.identity.id) && t.verifiers.includes(v.identity.id)));
    const requiredVerifiers = verifiers.filter((v) => implementations.some((t) => v.tasks.includes(t.identity.id) && t.verifiers.includes(v.identity.id) &&
      (input.plan.required_verifiers.includes(v.identity.id) || t.completion.some((c) => c.kind === "verification" && c.verifier === v.identity.id))));
    for (const decision of decisions) for (const task of tasks.filter((t) => t.architecture_decisions.includes(decision.id)))
      add(node("architecture-decision", decision.id, input.architecture.revision), node("task", task.identity.id, task.identity.revision));
    for (const task of tasks) for (const verifier of input.plan.verifiers.filter((v) => v.tasks.includes(task.identity.id) && task.verifiers.includes(v.identity.id)))
      add(node("task", task.identity.id, task.identity.revision), node("verifier", verifier.identity.id, verifier.identity.revision));
    if (enforced && !input.slices.slices.some((s) => s.required && s.requirements.includes(r.id))) issues.push({ code: "requirement-slice-missing", requirement: r.id });
    if (enforced && !decisions.length) issues.push({ code: "requirement-architecture-missing", requirement: r.id });
    if (enforced && !implementations.length) issues.push({ code: "requirement-implementation-missing", requirement: r.id });
    if (enforced && !requiredVerifiers.length) issues.push({ code: "requirement-verification-missing", requirement: r.id });
    const acceptance = [...r.acceptance_criteria].sort((a, b) => compareText(a.id, b.id)).map((ac) => {
      add(node("requirement", r.id, input.requirements.revision), node("acceptance-criterion", ac.id, input.requirements.revision));
      // Requirement-level decisions cover its ACs unless a narrower AC mapping was declared.
      const acDecisions = decisions.filter((d) => !d.acceptance_criteria.some((a) => a.startsWith(`${r.id}.`)) || d.acceptance_criteria.includes(ac.id));
      for (const decision of acDecisions) add(node("acceptance-criterion", ac.id, input.requirements.revision), node("architecture-decision", decision.id, input.architecture.revision));
      const acTasks = implementations.filter((t) => t.acceptance_criteria.includes(ac.id) && t.architecture_decisions.some((d) => acDecisions.some((decision) => decision.id === d)));
      const acVerifiers = verifiers.filter((v) => v.acceptance_criteria.includes(ac.id) && acTasks.some((t) => t.verifiers.includes(v.identity.id) && v.tasks.includes(t.identity.id)));
      const requiredAcVerifiers = acVerifiers.filter((v) => requiredVerifiers.includes(v));
      if (enforced && !acTasks.length) issues.push({ code: "acceptance-implementation-missing", requirement: r.id, subject: ac.id });
      if (enforced && !requiredAcVerifiers.length) issues.push({ code: "acceptance-verification-missing", requirement: r.id, subject: ac.id });
      return { id: ac.id, tasks: acTasks.map((t) => t.identity.id).sort(compareText), verifiers: acVerifiers.map((v) => v.identity.id).sort(compareText),
        required_verifiers: requiredAcVerifiers.map((v) => v.identity.id).sort(compareText) };
    });
    return { requirement: r.id, enforced, architecture_decisions: decisions.map((d) => d.id).sort(compareText), tasks: tasks.map((t) => t.identity.id).sort(compareText),
      verifiers: verifiers.map((v) => v.identity.id).sort(compareText), required_verifiers: requiredVerifiers.map((v) => v.identity.id).sort(compareText), acceptance_criteria: acceptance,
      applicable_evidence: input.evidence.filter((e) => e.requirements.includes(r.id) && verifiers.some((v) => v.identity.id === e.verifier.id) &&
        evidence.some((a) => a.id === e.id && a.applicable)).map((e) => e.id).sort(compareText) };
  });
  const sortedEdges = [...new Map(edges.map((edge) => [JSON.stringify(edge), edge])).entries()].sort(([a], [b]) => compareText(a, b)).map(([, edge]) => edge);
  const productCoverage = (id: string, requirementIds: string[], kind: "outcome" | "success"): ProductCoverage => {
    const passing = input.evidence.filter((e) => evidence.some((r) => r.id === e.id && r.passing) && requirementIds.some((r) =>
      e.requirements.some((id) => id === r) && requirements.some((c) => c.requirement === r && c.acceptance_criteria.some((ac) =>
        ac.required_verifiers.includes(e.verifier.id) && e.acceptance_criteria.some((id) => id === ac.id))))).map((e) => e.id).sort(compareText);
    const enforced = kind === "outcome" ? input.policy.product_coverage.outcomes : input.policy.product_coverage.success_criteria;
    if (enforced && !requirementIds.length) issues.push({ code: kind === "outcome" ? "product-outcome-requirement-missing" : "product-success-requirement-missing", subject: id });
    if (enforced && input.policy.product_coverage.evidence && !passing.length) issues.push({ code: kind === "outcome" ? "product-outcome-evidence-missing" : "product-success-evidence-missing", subject: id });
    return { id, requirements: requirementIds.sort(compareText), evidence: passing };
  };
  const product_outcomes = input.product.outcomes.map((o) => productCoverage(o.id, input.requirements.requirements.filter((r) => r.product_outcomes.includes(o.id) ||
    r.success_criteria.some((sc) => input.product.success_criteria.some((s) => s.id === sc && s.outcomes.includes(o.id)))).map((r) => r.id), "outcome")).sort((a, b) => compareText(a.id, b.id));
  const success_criteria = input.product.success_criteria.map((s) => productCoverage(s.id, input.requirements.requirements.filter((r) => r.success_criteria.includes(s.id)).map((r) => r.id), "success"))
    .sort((a, b) => compareText(a.id, b.id));
  return { edges: sortedEdges, requirements, product_outcomes, success_criteria, evidence, issues: stableIssues(issues) };
}
