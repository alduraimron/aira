import type { Requirements } from "./requirements";
import { validateDesign, type Design } from "./design";
import type { Tasks } from "../../tasks/types";
import type { VerificationEvidence, VerificationPlan } from "../../verification/types";
import { evidenceApplicability, type EvidenceContext } from "../../verification/applicability";
import { compareText, stableIssues, type DomainIssue } from "./primitives";
import type { SpecCompletionPolicy } from "./types";

export interface TraceabilityInput {
  readonly requirements: Requirements;
  readonly design: Design;
  readonly tasks: Tasks;
  readonly plan: VerificationPlan;
  readonly evidence: readonly VerificationEvidence[];
  readonly evidence_contexts: readonly EvidenceContext[];
  readonly policy: SpecCompletionPolicy;
}
export interface TraceNode { readonly kind: "requirement" | "acceptance-criterion" | "design-decision" | "task" | "verifier" | "evidence"; readonly id: string; readonly revision: string }
export interface TraceEdge { readonly from: TraceNode; readonly to: TraceNode }
export interface RequirementCoverage {
  readonly requirement: string;
  readonly enforced: boolean;
  readonly design_decisions: readonly string[];
  readonly tasks: readonly string[];
  readonly verifiers: readonly string[];
  readonly required_verifiers: readonly string[];
  readonly applicable_evidence: readonly string[];
  readonly acceptance_criteria: readonly { id: string; tasks: readonly string[]; verifiers: readonly string[]; required_verifiers: readonly string[] }[];
}
export interface TraceabilityReport {
  readonly edges: readonly TraceEdge[];
  readonly requirements: readonly RequirementCoverage[];
  readonly evidence: readonly { id: string; applicable: boolean; passing: boolean; reasons: readonly DomainIssue[] }[];
  readonly issues: readonly DomainIssue[];
}
export function buildTraceability(input: TraceabilityInput): TraceabilityReport {
  const issues: DomainIssue[] = [...validateDesign(input.design, input.requirements)], edges: TraceEdge[] = [];
  const node = (kind: TraceNode["kind"], id: string, revision: string): TraceNode => ({ kind, id, revision });
  const add = (from: TraceNode, to: TraceNode): void => { edges.push({ from, to }); };
  const evidence = [...input.evidence].sort((a, b) => compareText(a.id, b.id)).map((record) => {
    const contexts = input.evidence_contexts.filter((c) => c.task.id === record.task.id && c.verifier.identity.id === record.verifier.id && c.attempt.id === record.attempt);
    const applicability = contexts.length === 1 ? evidenceApplicability(record, contexts[0]!) :
      { applicable: false, reasons: [{ code: "evidence-authority-missing", subject: record.id }] };
    add(node("verifier", record.verifier.id, record.verifier.revision), node("evidence", record.id, record.id));
    return { id: record.id, applicable: applicability.applicable, passing: applicability.applicable && record.outcome === "passed", reasons: applicability.reasons };
  });
  for (const verifier of input.plan.verifiers) {
    for (const id of verifier.requirements) if (!input.requirements.requirements.some((r) => r.id === id))
      issues.push({ code: "unknown-verifier-requirement", verifier: verifier.identity.id, requirement: id });
    for (const ac of verifier.acceptance_criteria) if (!input.requirements.requirements.some((r) => r.acceptance_criteria.some((a) => a.id === ac)))
      issues.push({ code: "unknown-verifier-acceptance-criterion", verifier: verifier.identity.id, subject: ac });
    for (const id of verifier.tasks) if (!input.tasks.tasks.some((t) => t.identity.id === id && t.verifiers.includes(verifier.identity.id)))
      issues.push({ code: "verifier-task-link-missing", verifier: verifier.identity.id, task: id });
  }
  const requirements = [...input.requirements.requirements].sort((a, b) => compareText(a.id, b.id)).map((r): RequirementCoverage => {
    const enforced = r.priority === "must" || input.policy.traceability === "all" || (r.priority === "should" && input.policy.traceability === "must-and-should");
    const decisions = input.design.decisions.filter((d) => d.requirements.includes(r.id));
    const tasks = input.tasks.tasks.filter((t) => t.requirements.includes(r.id));
    const implementations = tasks.filter((t) => t.required && t.design_decisions.some((d) => decisions.some((decision) => decision.id === d)));
    const verifiers = input.plan.verifiers.filter((v) => v.requirements.includes(r.id) && tasks.some((t) =>
      v.tasks.includes(t.identity.id) && t.verifiers.includes(v.identity.id)));
    const requiredVerifiers = verifiers.filter((v) => implementations.some((t) => v.tasks.includes(t.identity.id) && t.verifiers.includes(v.identity.id) &&
      (input.plan.required_verifiers.includes(v.identity.id) || t.completion.some((c) => c.kind === "verification" && c.verifier === v.identity.id))));
    for (const decision of decisions) for (const task of tasks.filter((t) => t.design_decisions.includes(decision.id)))
      add(node("design-decision", decision.id, input.design.revision), node("task", task.identity.id, task.identity.revision));
    for (const task of tasks) for (const verifier of input.plan.verifiers.filter((v) => v.tasks.includes(task.identity.id) && task.verifiers.includes(v.identity.id)))
      add(node("task", task.identity.id, task.identity.revision), node("verifier", verifier.identity.id, verifier.identity.revision));
    if (enforced && !decisions.length) issues.push({ code: "requirement-design-missing", requirement: r.id });
    if (enforced && !implementations.length) issues.push({ code: "requirement-implementation-missing", requirement: r.id });
    if (enforced && !requiredVerifiers.length) issues.push({ code: "requirement-verification-missing", requirement: r.id });
    const acceptance = [...r.acceptance_criteria].sort((a, b) => compareText(a.id, b.id)).map((ac) => {
      add(node("requirement", r.id, input.requirements.revision), node("acceptance-criterion", ac.id, input.requirements.revision));
      // Requirement-level decisions cover its ACs unless a narrower AC mapping was declared.
      const acDecisions = decisions.filter((d) => !d.acceptance_criteria.some((a) => a.startsWith(`${r.id}.`)) || d.acceptance_criteria.includes(ac.id));
      for (const decision of acDecisions) add(node("acceptance-criterion", ac.id, input.requirements.revision), node("design-decision", decision.id, input.design.revision));
      const acTasks = implementations.filter((t) => t.acceptance_criteria.includes(ac.id) && t.design_decisions.some((d) => acDecisions.some((decision) => decision.id === d)));
      const acVerifiers = verifiers.filter((v) => v.acceptance_criteria.includes(ac.id) && acTasks.some((t) => t.verifiers.includes(v.identity.id) && v.tasks.includes(t.identity.id)));
      const requiredAcVerifiers = acVerifiers.filter((v) => requiredVerifiers.includes(v));
      if (enforced && !acTasks.length) issues.push({ code: "acceptance-implementation-missing", requirement: r.id, subject: ac.id });
      if (enforced && !requiredAcVerifiers.length) issues.push({ code: "acceptance-verification-missing", requirement: r.id, subject: ac.id });
      return { id: ac.id, tasks: acTasks.map((t) => t.identity.id).sort(compareText), verifiers: acVerifiers.map((v) => v.identity.id).sort(compareText),
        required_verifiers: requiredAcVerifiers.map((v) => v.identity.id).sort(compareText) };
    });
    return { requirement: r.id, enforced, design_decisions: decisions.map((d) => d.id).sort(compareText), tasks: tasks.map((t) => t.identity.id).sort(compareText),
      verifiers: verifiers.map((v) => v.identity.id).sort(compareText), required_verifiers: requiredVerifiers.map((v) => v.identity.id).sort(compareText), acceptance_criteria: acceptance,
      applicable_evidence: input.evidence.filter((e) => e.requirements.includes(r.id) && verifiers.some((v) => v.identity.id === e.verifier.id) &&
        evidence.some((a) => a.id === e.id && a.applicable)).map((e) => e.id).sort(compareText) };
  });
  const sortedEdges = [...new Map(edges.map((edge) => [JSON.stringify(edge), edge])).entries()].sort(([a], [b]) => compareText(a, b)).map(([, edge]) => edge);
  return { edges: sortedEdges, requirements, evidence, issues: stableIssues(issues) };
}
