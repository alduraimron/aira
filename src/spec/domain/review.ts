import type { Spec } from "./types";
import { sameArtifact, type ArtifactKind, type ArtifactRevision, type ArtifactSubject } from "./artifacts";
import type { Analysis } from "./analysis";
import { artifactApplicability, hasConsistencyBinding, type LineageContext } from "./lineage";
import { approvalApplicability, integratedApprovalApplicability, waiverApplies, type DecisionContext } from "../../approval/spec-policy";
import type { HumanWaiver, SpecApprovalRecord } from "../../approval/spec-records";
import { stableIssues, type DomainIssue, type DomainResult } from "./primitives";
import { checkLifecycleTransition, type SpecLifecycle } from "./lifecycle";

export interface SpecReviewContext {
  readonly spec: Spec;
  readonly revisions: readonly ArtifactRevision[];
  readonly analyses: readonly Analysis[];
  readonly approvals: readonly SpecApprovalRecord[];
  readonly waivers: readonly HumanWaiver[];
}
export function lineageContext(context: SpecReviewContext): LineageContext {
  return { revisions: context.revisions, current: [...context.spec.artifacts.current.map((s) => s.artifact), ...context.spec.analyses],
    proposed: context.spec.artifacts.proposed, validations: context.spec.lineage.validations, invalidations: context.spec.lineage.invalidations,
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
export function evaluateSpecGates(context: SpecReviewContext, kinds: readonly ArtifactKind[] = ["requirements", "design", "tasks"], requireApproval = true): DomainIssue[] {
  const issues: DomainIssue[] = [], lineage = lineageContext(context), decisions = decisionContext(context);
  for (const kind of kinds) {
    const subject = context.spec.artifacts.current.find((s) => s.artifact.kind === kind);
    if (!subject) { issues.push({ code: "required-artifact-missing", subject: kind }); continue; }
    issues.push(...artifactApplicability(lineage, subject.artifact).reasons);
    if (requireApproval && !context.approvals.some((a) => context.spec.approvals.includes(a.id) && approvalApplicability(a, subject, decisions).length === 0))
      issues.push({ code: "artifact-approval-missing", subject: kind });
    if (["requirements", "design", "tasks"].includes(kind)) {
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
  const design = context.spec.artifacts.current.find((s) => s.artifact.kind === "design")?.artifact;
  const tasks = context.spec.artifacts.current.find((s) => s.artifact.kind === "tasks")?.artifact;
  if (kinds.includes("tasks")) {
    if (!requirements || !design || !hasConsistencyBinding(lineage, design, requirements)) issues.push({ code: "design-consistency-missing" });
    if (requirements && design && tasks) {
      const definition = context.revisions.find((r) => r.id === tasks.revision);
      for (const upstream of [requirements, design]) if (!definition?.lineage.some((e) => e.relation === "derived_from" && sameArtifact(e.target, upstream)) &&
        !hasConsistencyBinding(lineage, tasks, upstream)) issues.push({ code: "tasks-lineage-incomplete", subject: upstream.kind });
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
  if (context.spec.mode === "quick" && (subjects.length !== 3 || !["requirements", "design", "tasks"].every((kind) => subjects.some((s) => s.artifact.kind === kind))))
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
    ...evaluateSpecGates(context, ["requirements", "design", "tasks"], context.spec.mode === "quick"),
    ...(context.spec.mode === "quick" ? [] : evaluateSpecGates(context, ["requirements", "design"])),
  ]);
}

/** Gate-aware lifecycle proposal. Never writes generations, claims, or current artifact slots. */
export function evaluateLifecycleTransition(context: SpecReviewContext, to: SpecLifecycle): DomainResult<SpecLifecycle> {
  const { spec } = context;
  const structural = checkLifecycleTransition(spec.mode, spec.lifecycle, to, spec.authoring_order);
  const issues: DomainIssue[] = structural.ok ? [] : [...structural.issues];
  const quick = spec.mode === "quick";
  switch (to.state) {
    case "waiting-requirements-approval": issues.push(...evaluateSpecGates(context, ["requirements"], false)); break;
    case "requirements-approved": issues.push(...evaluateSpecGates(context, ["requirements"])); break;
    case "waiting-design-approval": issues.push(...evaluateSpecGates(context, ["design"], false)); break;
    case "design-approved": issues.push(...evaluateSpecGates(context, ["design"])); break;
    case "drafting-requirements":
      if (spec.authoring_order === "design-first" && spec.lifecycle.state !== "drafting-requirements")
        issues.push(...evaluateSpecGates(context, ["design"], !quick));
      break;
    case "drafting-design":
      if (spec.authoring_order === "requirements-first") issues.push(...evaluateSpecGates(context, ["requirements"], !quick));
      break;
    case "validating-design":
      // Revalidation is allowed to examine stale design. It does not authorize using it.
      issues.push(...evaluateSpecGates(context, ["requirements"], !quick));
      if (!spec.artifacts.current.some((s) => s.artifact.kind === "design")) issues.push({ code: "required-artifact-missing", subject: "design" });
      break;
    case "drafting-tasks": {
      issues.push(...evaluateSpecGates(context, ["requirements", "design"], !quick));
      const requirements = spec.artifacts.current.find((s) => s.artifact.kind === "requirements")?.artifact;
      const design = spec.artifacts.current.find((s) => s.artifact.kind === "design")?.artifact;
      if (!requirements || !design || !hasConsistencyBinding(lineageContext(context), design, requirements)) issues.push({ code: "design-consistency-missing" });
      break;
    }
    case "waiting-tasks-approval":
      issues.push(...evaluateSpecGates(context, ["requirements", "design"]), ...evaluateSpecGates(context, ["requirements", "design", "tasks"], false)); break;
    case "waiting-integrated-approval": issues.push(...evaluateSpecGates(context, ["requirements", "design", "tasks"], false)); break;
    case "ready": case "implementing": case "verifying": issues.push(...evaluateSpecGates(context)); break;
    case "completed": issues.push({ code: "completion-evaluation-required" }); break;
  }
  return issues.length ? { ok: false, issues: stableIssues(issues) } : { ok: true, value: { ...to } };
}
