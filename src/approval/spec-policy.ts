import { artifactApplicability, type LineageContext } from "../spec/domain/lineage";
import { sameSubject, type ApprovalApplicability, type HumanWaiver, type SpecApprovalRecord, type SpecDecisionPolicy, type WaiverApplicability } from "./spec-records";
import { planningKinds } from "../spec/domain/planning-kinds";
import type { ArtifactSubject } from "../spec/domain/artifacts";
import type { SpecGeneration } from "../spec/domain/generations";
import type { SpecId } from "../spec/domain/ids";
import { exact, stableIssues, type DomainIssue } from "../spec/domain/primitives";

export interface DecisionContext {
  readonly spec_id: SpecId;
  readonly generation: SpecGeneration;
  readonly subjects: readonly ArtifactSubject[];
  readonly lineage: LineageContext;
  readonly applicability: readonly ApprovalApplicability[];
  readonly waiver_applicability: readonly WaiverApplicability[];
}
export function approvalApplicability(record: SpecApprovalRecord, subject: ArtifactSubject, context: DecisionContext): DomainIssue[] {
  const issues = artifactApplicability(context.lineage, subject.artifact).reasons;
  if (!context.subjects.some((s) => sameSubject(s, subject))) issues.push({ code: "approval-lineage-mismatch", subject: record.id });
  if (record.spec_id !== context.spec_id || record.decision !== "approved" ||
    !record.subjects.some((s) => sameSubject(s, subject))) issues.push({ code: "approval-subject-mismatch", subject: record.id });
  const bindings = context.applicability.filter((a) => a.approval === record.id && sameSubject(a.subject, subject) && a.generation === context.generation);
  if (bindings.length !== 1) issues.push({ code: "approval-generation-inapplicable", subject: record.id });
  else {
    const binding = bindings[0]!;
    if (binding.spec_id !== context.spec_id || binding.status !== "applicable") issues.push({ code: "approval-revoked", subject: record.id });
    if (BigInt(binding.generation) < BigInt(record.committed_generation) ||
      (binding.generation !== record.committed_generation && (binding.carried_from === undefined || BigInt(binding.carried_from) < BigInt(record.committed_generation))))
      issues.push({ code: "approval-carry-forward-missing", subject: record.id });
  }
  return stableIssues(issues);
}
/** One record is the indivisible quick-mode human operation; no opaque bundle approval. */
export function integratedApprovalApplicability(record: SpecApprovalRecord, context: DecisionContext): DomainIssue[] {
  const required = context.subjects.filter((s) => planningKinds.some((k) => k === s.artifact.kind));
  const issues: DomainIssue[] = [];
  if (record.scope !== "integrated" || required.length !== 6 || record.subjects.length !== 6)
    issues.push({ code: "integrated-approval-incomplete", subject: record.id });
  for (const subject of required) issues.push(...approvalApplicability(record, subject, context));
  return stableIssues(issues);
}
export function waiverApplies(waiver: HumanWaiver, scope: { code: string; subject: string }, policy: SpecDecisionPolicy, context: DecisionContext): boolean {
  const bindings = context.waiver_applicability.filter((a) => a.waiver === waiver.id && a.generation === context.generation);
  const binding = bindings.length === 1 ? bindings[0] : undefined;
  return waiver.spec_id === context.spec_id && binding?.status === "active" && binding.spec_id === context.spec_id &&
    BigInt(binding.generation) >= BigInt(waiver.committed_generation) &&
    (binding.generation === waiver.committed_generation || (binding.carried_from !== undefined && BigInt(binding.carried_from) >= BigInt(waiver.committed_generation))) &&
    exact(waiver.policy, policy.identity) && exact(waiver.scope, scope) && policy.waivable.some((c) => c === scope.code) &&
    waiver.subjects.every((subject) => context.subjects.some((s) => sameSubject(s, subject)) &&
      artifactApplicability(context.lineage, subject.artifact).applicable);
}
/** Exact-subject, no-staleness carry-forward decision. The caller must commit the returned record. */
export function canCarryApproval(record: SpecApprovalRecord, from: DecisionContext, to: DecisionContext): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (from.spec_id !== to.spec_id || BigInt(to.generation) <= BigInt(from.generation)) issues.push({ code: "invalid-approval-carry-generation" });
  for (const subject of record.subjects) {
    issues.push(...approvalApplicability(record, subject, from));
    if (!to.subjects.some((s) => sameSubject(s, subject))) issues.push({ code: "approval-subject-mismatch", subject: record.id });
    issues.push(...artifactApplicability(to.lineage, subject.artifact).reasons);
  }
  return stableIssues(issues);
}
