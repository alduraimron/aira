import type { Spec } from "./types";
import { sameArtifact, approvalArtifactKindSchema, type ArtifactKind, type ArtifactRevision, type ArtifactSubject } from "./artifacts";
import { analysisSchema, type Analysis } from "./analysis";
import { artifactApplicability, hasApplicableDependency, hasConsistencyBinding, type LineageContext } from "./lineage";
import { approvalApplicability, integratedApprovalApplicability, waiverApplies, type DecisionContext } from "../../approval/spec-policy";
import { humanWaiverSchema, specApprovalRecordSchema, type HumanWaiver, type SpecApprovalRecord } from "../../approval/spec-records";
import { stableIssues, unique, type DomainIssue, type DomainResult } from "./primitives";
import { checkLifecycleTransition, type SpecLifecycle } from "./lifecycle";
import { planningKinds } from "./planning-kinds";

export interface SpecReviewContext {
  readonly spec: Spec;
  readonly revisions: readonly ArtifactRevision[];
  readonly analyses: readonly Analysis[];
  readonly approvals: readonly SpecApprovalRecord[];
  readonly waivers: readonly HumanWaiver[];
  readonly entities?: LineageContext["entities"];
}
export function lineageContext(context: SpecReviewContext): LineageContext {
  return { revisions: context.revisions, current: [...context.spec.artifacts.current.map((s) => s.artifact), ...context.spec.analyses],
    entities: context.entities, proposed: context.spec.artifacts.proposed, validations: context.spec.lineage.validations, invalidations: context.spec.lineage.invalidations,
    analyses: context.analyses.filter((a) => context.spec.analyses.some((r) => r.revision === a.revision)), generation: context.spec.generation };
}
export function decisionContext(context: SpecReviewContext): DecisionContext {
  return { spec_id: context.spec.id, generation: context.spec.generation, subjects: context.spec.artifacts.current,
    lineage: lineageContext(context), applicability: context.spec.approval_applicability, waiver_applicability: context.spec.waiver_applicability };
}
export function obligationWaived(context: SpecReviewContext, code: string, subject: string, required: readonly ArtifactSubject[] = context.spec.artifacts.current): boolean {
  return context.waivers.some((waiver) => context.spec.waivers.includes(waiver.id) &&
    required.every((r) => waiver.subjects.some((s) => sameArtifact(r.artifact, s.artifact) && r.lineage_hash === s.lineage_hash)) &&
    waiverApplies(waiver, { code, subject }, context.spec.decision_policy, decisionContext(context)));
}
export function blockingFindingIssues(context: SpecReviewContext): DomainIssue[] {
  const lineage = lineageContext(context), issues: DomainIssue[] = [];
  for (const analysis of lineage.analyses) {
    if (!analysis.inputs.every((r) => lineage.current.some((c) => sameArtifact(c, r)))) continue;
    for (const finding of analysis.findings) {
      if (finding.severity !== "blocker" || finding.disposition.state !== "unresolved") continue;
      const subjects = context.spec.artifacts.current.filter((s) => finding.subjects.some((r) => sameArtifact(r, s.artifact)));
      if (!obligationWaived(context, "unresolved-blocker", finding.id, subjects)) issues.push({ code: "unresolved-blocker", subject: finding.id });
    }
  }
  return stableIssues(issues);
}
export function evaluateSpecGates(context: SpecReviewContext, kinds: readonly ArtifactKind[] = planningKinds, requireApproval = true): DomainIssue[] {
  const malformed = [
    ...context.analyses.filter((a) => !analysisSchema.safeParse(a).success).map((a) => ({ code: "invalid-domain-contract", subject: a.revision })),
    ...context.approvals.filter((a) => !specApprovalRecordSchema.safeParse(a).success).map((a) => ({ code: "invalid-domain-contract", subject: a.id })),
    ...context.waivers.filter((w) => !humanWaiverSchema.safeParse(w).success).map((w) => ({ code: "invalid-domain-contract", subject: w.id })),
  ];
  if (malformed.length) return stableIssues(malformed);
  const issues: DomainIssue[] = [], lineage = lineageContext(context), decisions = decisionContext(context);
  for (const kind of kinds) {
    const subject = context.spec.artifacts.current.find((s) => s.artifact.kind === kind);
    if (!subject) { issues.push({ code: "required-artifact-missing", subject: kind }); continue; }
    issues.push(...artifactApplicability(lineage, subject.artifact).reasons);
    if (requireApproval && !context.approvals.some((a) => context.spec.approvals.includes(a.id) && approvalApplicability(a, subject, decisions).length === 0))
      issues.push({ code: "artifact-approval-missing", subject: kind });
    if (planningKinds.some((k) => k === kind)) {
      const analyses = lineage.analyses.filter((a) => a.spec_id === context.spec.id && a.phase === kind &&
        a.inputs.some((i) => sameArtifact(i, subject.artifact)) &&
        a.inputs.every((i) => lineage.current.some((r) => sameArtifact(r, i))));
      if (analyses.length !== 1 || analyses[0]!.outcome !== "consistent") issues.push({ code: "required-analysis-missing", subject: kind });
      else {
        const ref = context.spec.analyses.find((r) => r.revision === analyses[0]!.revision)!;
        issues.push(...artifactApplicability(lineage, ref).reasons);
      }
    }
  }
  const requirements = context.spec.artifacts.current.find((s) => s.artifact.kind === "requirements")?.artifact;
  const architecture = context.spec.artifacts.current.find((s) => s.artifact.kind === "architecture")?.artifact;
  const tasks = context.spec.artifacts.current.find((s) => s.artifact.kind === "tasks")?.artifact;
  const dependencies: Partial<Record<ArtifactKind, readonly ArtifactKind[]>> = {
    product: ["intent"], requirements: context.spec.authoring_order === "architecture-first" ? ["product", "architecture"] : ["product"], architecture: [context.spec.authoring_order === "architecture-first" ? "product" : "requirements"],
    "program-design": ["architecture", "requirements"], "slice-plan": ["program-design"], tasks: ["slice-plan"],
  };
  for (const kind of kinds) {
    const subject = context.spec.artifacts.current.find((s) => s.artifact.kind === kind)?.artifact;
    for (const parentKind of dependencies[kind] ?? []) {
      const parent = context.spec.artifacts.current.find((s) => s.artifact.kind === parentKind)?.artifact;
      if (!subject || !parent || !hasApplicableDependency(lineage, subject, parent)) issues.push({ code: "planning-lineage-incomplete", subject: kind, related: [parentKind] });
    }
  }
  if (kinds.some((k) => ["program-design", "slice-plan", "tasks"].includes(k)) &&
    (!requirements || !architecture || !hasConsistencyBinding(lineage, architecture, requirements))) issues.push({ code: "architecture-consistency-missing" });
  if (kinds.includes("tasks")) {
    if (requirements && architecture && tasks) {
      for (const upstream of [requirements, architecture]) if (!hasApplicableDependency(lineage, tasks, upstream)) issues.push({ code: "tasks-lineage-incomplete", subject: upstream.kind });
    }
    if (context.spec.mode === "quick" && requireApproval && !context.approvals.some((a) => context.spec.approvals.includes(a.id) && integratedApprovalApplicability(a, decisions).length === 0))
      issues.push({ code: "integrated-approval-missing" });
  }
  issues.push(...blockingFindingIssues(context));
  for (const id of context.spec.approvals) if (context.approvals.filter((a) => a.id === id).length !== 1) issues.push({ code: "approval-record-missing-or-duplicate", subject: id });
  for (const id of context.spec.waivers) if (context.waivers.filter((a) => a.id === id).length !== 1) issues.push({ code: "waiver-record-missing-or-duplicate", subject: id });
  return stableIssues(issues);
}
/** Evaluate a proposed exact review set without publishing it or granting approval. */
export function evaluateApprovalEligibility(context: SpecReviewContext, subjects: readonly ArtifactSubject[]): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (!subjects.length || !unique(subjects.map((s) => s.artifact.kind)) || subjects.some((s) => !approvalArtifactKindSchema.safeParse(s.artifact.kind).success))
    issues.push({ code: "invalid-approval-subject-set" });
  if (context.spec.mode === "quick" && (subjects.length !== 6 || !planningKinds.every((kind) => subjects.some((s) => s.artifact.kind === kind))))
    issues.push({ code: "integrated-approval-incomplete" });
  for (const subject of subjects) if (![...context.spec.artifacts.current.map((s) => s.artifact), ...context.spec.artifacts.proposed].some((r) => sameArtifact(r, subject.artifact)))
    issues.push({ code: "approval-subject-mismatch", subject: subject.artifact.revision });
  const candidate: SpecReviewContext = { ...context, spec: { ...context.spec, artifacts: { ...context.spec.artifacts,
    current: [...context.spec.artifacts.current.filter((s) => !subjects.some((n) => n.artifact.kind === s.artifact.kind)), ...subjects],
    proposed: context.spec.artifacts.proposed.filter((p) => !subjects.some((s) => sameArtifact(s.artifact, p))) } } };
  return stableIssues([...issues, ...evaluateSpecGates(candidate, subjects.map((s) => s.artifact.kind), false)]);
}

/** Eligibility for making proposed tasks current. Quick mode requires the integrated
 * decision in the candidate resulting state; ordinary mode requires upstream human gates.
 * No slot is mutated by this predicate (INV-LINEAGE-002, INV-SPEC-003).
 */
export function evaluateTaskArtifactPromotion(context: SpecReviewContext): DomainIssue[] {
  return stableIssues([
    ...evaluateSpecGates(context, planningKinds, context.spec.mode === "quick"),
    ...(context.spec.mode === "quick" ? [] : evaluateSpecGates(context, planningKinds.filter((k) => k !== "tasks"))),
  ]);
}

/** Gate-aware lifecycle proposal. Never writes generations, claims, or current artifact slots. */
export function evaluateLifecycleTransition(context: SpecReviewContext, to: SpecLifecycle): DomainResult<SpecLifecycle> {
  const { spec } = context;
  const structural = checkLifecycleTransition(spec.mode, spec.lifecycle, to, spec.authoring_order);
  const issues: DomainIssue[] = structural.ok ? [] : [...structural.issues];
  const quick = spec.mode === "quick";
  for (const kind of planningKinds) {
    if (to.state === `waiting-${kind}-approval`) issues.push(...evaluateSpecGates(context, [kind], false));
    if (to.state === `${kind}-approved`) issues.push(...evaluateSpecGates(context, [kind]));
  }
  switch (to.state) {
    case "drafting-requirements":
      issues.push(...evaluateSpecGates(context, ["product"], !quick));
      if (spec.authoring_order === "architecture-first" && spec.lifecycle.state !== "drafting-requirements")
        issues.push(...evaluateSpecGates(context, ["architecture"], !quick));
      break;
    case "drafting-architecture":
      issues.push(...evaluateSpecGates(context, ["product"], !quick));
      if (spec.authoring_order === "requirements-first") issues.push(...evaluateSpecGates(context, ["requirements"], !quick));
      break;
    case "validating-architecture":
      // Revalidation is allowed to examine stale architecture. It does not authorize using it.
      issues.push(...evaluateSpecGates(context, ["requirements"], !quick));
      if (!spec.artifacts.current.some((s) => s.artifact.kind === "architecture")) issues.push({ code: "required-artifact-missing", subject: "architecture" });
      break;
    case "drafting-program-design": {
      issues.push(...evaluateSpecGates(context, ["product", "requirements", "architecture"], !quick));
      const requirements = spec.artifacts.current.find((s) => s.artifact.kind === "requirements")?.artifact;
      const architecture = spec.artifacts.current.find((s) => s.artifact.kind === "architecture")?.artifact;
      if (!requirements || !architecture || !hasConsistencyBinding(lineageContext(context), architecture, requirements)) issues.push({ code: "architecture-consistency-missing" });
      break;
    }
    case "drafting-slice-plan": issues.push(...evaluateSpecGates(context, planningKinds.slice(0, 4), !quick)); break;
    case "drafting-tasks": issues.push(...evaluateSpecGates(context, planningKinds.slice(0, 5), !quick)); break;
    case "waiting-tasks-approval":
      issues.push(...evaluateSpecGates(context, planningKinds.slice(0, 5)), ...evaluateSpecGates(context, planningKinds, false)); break;
    case "waiting-integrated-approval": issues.push(...evaluateSpecGates(context, planningKinds, false)); break;
    case "ready": case "implementing": case "verifying": issues.push(...evaluateSpecGates(context)); break;
    case "completed": issues.push({ code: "completion-evaluation-required" }); break;
  }
  return issues.length ? { ok: false, issues: stableIssues(issues) } : { ok: true, value: { ...to } };
}
