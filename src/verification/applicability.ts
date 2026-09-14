import { sameSpecBehavioralBindings, type ApprovedSpecSnapshot } from "../spec/domain/artifacts";
import { canonical, exact, stableIssues, type DomainIssue, type ProfileReference } from "../spec/domain/primitives";
import type { AttemptAuthority, AttemptRecord, TaskDefinitionReference } from "../execution/types";
import type { ExecutionBackend, WorkspaceFingerprint } from "../workspace/types";
import { checkBackendRequirements, sameWorkspaceFingerprint } from "../workspace/fingerprint";
import type { EvidenceApplicability, VerificationEvidence, VerifierDefinition } from "./types";
import { evidenceApplicabilityContractSchema } from "./schema";
import { containsPins, sameBehavioralPins } from "../builtins/roles";
import { pinsProfile } from "../builtins/bindings";

export interface EvidenceContext {
  readonly snapshot: ApprovedSpecSnapshot;
  readonly task: TaskDefinitionReference;
  readonly attempt: AttemptRecord;
  readonly authority: AttemptAuthority;
  readonly workspace: WorkspaceFingerprint;
  readonly backend: ExecutionBackend;
  readonly verifier: VerifierDefinition;
  readonly profile: ProfileReference;
  readonly allow_agent_review: boolean;
  readonly selected_evidence: VerificationEvidence["id"];
}
export function sameApprovedSnapshot(a: ApprovedSpecSnapshot, b: ApprovedSpecSnapshot): boolean {
  return a.spec_id === b.spec_id && a.generation === b.generation &&
    exact([...a.artifacts].sort((x, y) => x.artifact.kind < y.artifact.kind ? -1 : 1), [...b.artifacts].sort((x, y) => x.artifact.kind < y.artifact.kind ? -1 : 1)) &&
    exact([...a.approvals].sort(), [...b.approvals].sort()) &&
    exact(a.decision_policy, b.decision_policy) && exact(a.completion_policy, b.completion_policy) &&
    exact(a.verification_profile, b.verification_profile) &&
    sameSpecBehavioralBindings(a.behavioral_profiles, b.behavioral_profiles) &&
    sameBehavioralPins(a.behavioral_assets, b.behavioral_assets) &&
    exact([...a.capability_policies].sort((x, y) => x.id < y.id ? -1 : 1), [...b.capability_policies].sort((x, y) => x.id < y.id ? -1 : 1));
}
/** Applicability and outcome are independent: historical failed evidence is still evidence. */
export function evidenceApplicability(evidence: VerificationEvidence, context: EvidenceContext): EvidenceApplicability {
  const reasons: DomainIssue[] = [];
  const add = (code: string): void => { reasons.push({ code, subject: evidence.id }); };
  if (evidence.id !== context.selected_evidence) add("evidence-not-selected");
  if (!evidenceApplicabilityContractSchema.safeParse(evidence.applicability).success) add("unsupported-evidence-applicability");
  if (evidence.observation !== "stable" || !sameWorkspaceFingerprint(evidence.workspace_before, evidence.workspace_after)) add("evidence-observation-unstable");
  if (!sameWorkspaceFingerprint(evidence.workspace_after, context.workspace)) add("evidence-workspace-mismatch");
  if (evidence.spec_id !== context.snapshot.spec_id || !sameApprovedSnapshot(evidence.snapshot, context.snapshot)) add("evidence-spec-mismatch");
  if (!exact(evidence.task, context.task) || !exact(context.attempt.task, context.task)) add("evidence-task-mismatch");
  if (!exact(evidence.verifier, context.verifier.identity) || !exact(evidence.profile, context.profile)) add("evidence-verifier-mismatch");
  if (!exact(evidence.policy, context.verifier.policy)) add("evidence-policy-mismatch");
  if (!exact(evidence.backend, context.backend)) add("evidence-backend-mismatch");
  if (evidence.attempt !== context.attempt.id || context.authority.attempt !== context.attempt.id || context.authority.status !== "published" ||
    !exact(context.authority.fence, context.attempt.fence) || !sameApprovedSnapshot(context.authority.snapshot, context.snapshot) ||
    !sameApprovedSnapshot(context.attempt.snapshot, context.snapshot)) add("evidence-attempt-fenced");
  if (Date.parse(evidence.started_at) < Date.parse(context.attempt.started_at) || Date.parse(evidence.ended_at) > Date.parse(context.attempt.ended_at)) add("evidence-attempt-interval-mismatch");
  if (!containsPins(context.attempt.behavior.pins, evidence.behavioral_assets) ||
    !containsPins(evidence.behavioral_assets, context.attempt.behavior.pins.filter((p) => p.role === "capability-profile"))) add("evidence-behavioral-assets-mismatch");
  if (context.verifier.definition.kind === "agent-review" && !pinsProfile(evidence.behavioral_assets, "verification-review", context.verifier.definition.review_profile) &&
    !pinsProfile(evidence.behavioral_assets, "implementation-review", context.verifier.definition.review_profile) &&
    !pinsProfile(evidence.behavioral_assets, "final-spec-review", context.verifier.definition.review_profile)) add("evidence-review-asset-missing");
  if (evidence.context.length !== context.attempt.context.length || evidence.context.some((c) => !context.attempt.context.some((a) => exact(a, c)))) add("evidence-context-mismatch");
  if (evidence.requirements.some((r) => !context.verifier.requirements.includes(r)) ||
    evidence.acceptance_criteria.some((a) => !context.verifier.acceptance_criteria.includes(a)) ||
    evidence.slices.some((s) => !context.verifier.slices.includes(s)) ||
    !context.verifier.tasks.includes(evidence.task.id)) add("evidence-traceability-mismatch");
  if (context.verifier.definition.kind === "human-review" && evidence.review_actor?.kind !== "human") add("evidence-human-review-required");
  if (context.verifier.definition.kind === "agent-review" && (!context.allow_agent_review || evidence.review_actor?.kind !== "agent" ||
    !exact(evidence.review_actor.implementation, context.verifier.definition.review_profile))) add("evidence-agent-review-forbidden");
  reasons.push(...checkBackendRequirements(context.verifier.required_backend, context.backend));
  return { applicable: reasons.length === 0, reasons: stableIssues(reasons) };
}
export const evidencePasses = (evidence: VerificationEvidence, context: EvidenceContext): boolean =>
  evidence.outcome === "passed" && evidenceApplicability(evidence, context).applicable;

/** Conflicting immutable observations with the same identity must never be picked by array order. */
export function validateEvidenceIdentities(evidence: readonly VerificationEvidence[]): DomainIssue[] {
  const seen = new Map<string, string>(), issues: DomainIssue[] = [];
  for (const record of evidence) {
    if (seen.has(record.id)) issues.push({ code: "duplicate-evidence", subject: record.id });
    seen.set(record.id, canonical(record));
  }
  return stableIssues(issues);
}
