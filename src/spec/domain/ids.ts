import { z } from "zod";
import type { DomainIssue } from "./primitives";

// Human obligation IDs are identities, never indexes or dependency ordering.
export const requirementIdSchema = z.string().regex(/^R[1-9][0-9]*$/).brand<"RequirementId">();
export const acceptanceCriterionIdSchema = z.string().regex(/^R[1-9][0-9]*\.AC[1-9][0-9]*$/).brand<"AcceptanceCriterionId">();
export const productOutcomeIdSchema = z.string().regex(/^O[1-9][0-9]*$/).brand<"ProductOutcomeId">();
export const successCriterionIdSchema = z.string().regex(/^SC[1-9][0-9]*$/).brand<"SuccessCriterionId">();
export const architectureDecisionIdSchema = z.string().regex(/^A[1-9][0-9]*$/).brand<"ArchitectureDecisionId">();
export const programDesignDecisionIdSchema = z.string().regex(/^PD[1-9][0-9]*$/).brand<"ProgramDesignDecisionId">();
export const sliceIdSchema = z.string().regex(/^S[1-9][0-9]*$/).brand<"SliceId">();
export const taskIdSchema = z.string().regex(/^T[1-9][0-9]*$/).brand<"TaskId">();
export const verifierIdSchema = z.string().regex(/^V[1-9][0-9]*$/).brand<"VerifierId">();
const opaque = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9][a-z0-9_-]{0,63}$`));
export const specIdSchema = opaque("spec").brand<"SpecId">();
export const artifactRevisionIdSchema = opaque("rev").brand<"ArtifactRevisionId">();
export const approvalIdSchema = opaque("approval").brand<"ApprovalId">();
export const revisionRequestIdSchema = opaque("revision").brand<"RevisionRequestId">();
export const analysisFindingIdSchema = opaque("finding").brand<"AnalysisFindingId">();
export const runIdV2Schema = opaque("run").brand<"RunIdV2">();
export const attemptIdSchema = opaque("attempt").brand<"AttemptId">();
export const evidenceIdSchema = opaque("evidence").brand<"EvidenceId">();
export const workspaceIdSchema = opaque("workspace").brand<"WorkspaceId">();
export const policyIdSchema = opaque("policy").brand<"PolicyId">();
export const contextSnapshotIdSchema = opaque("snapshot").brand<"ContextSnapshotId">();
export const contextDeclarationIdSchema = opaque("context").brand<"ContextDeclarationId">();
export const operationIdSchema = opaque("operation").brand<"OperationId">();
export const claimIdSchema = opaque("claim").brand<"ClaimId">();
export const waiverIdSchema = opaque("waiver").brand<"WaiverId">();
export const profileIdSchema = opaque("profile").brand<"ProfileId">();

export type SpecId = z.infer<typeof specIdSchema>;
export type RequirementId = z.infer<typeof requirementIdSchema>;
export type AcceptanceCriterionId = z.infer<typeof acceptanceCriterionIdSchema>;
export type ProductOutcomeId = z.infer<typeof productOutcomeIdSchema>;
export type SuccessCriterionId = z.infer<typeof successCriterionIdSchema>;
export type ArchitectureDecisionId = z.infer<typeof architectureDecisionIdSchema>;
export type ProgramDesignDecisionId = z.infer<typeof programDesignDecisionIdSchema>;
export type SliceId = z.infer<typeof sliceIdSchema>;
export type TaskId = z.infer<typeof taskIdSchema>;
export type VerifierId = z.infer<typeof verifierIdSchema>;
export type ArtifactRevisionId = z.infer<typeof artifactRevisionIdSchema>;
export type ApprovalId = z.infer<typeof approvalIdSchema>;
export type RevisionRequestId = z.infer<typeof revisionRequestIdSchema>;
export type AnalysisFindingId = z.infer<typeof analysisFindingIdSchema>;
export type RunIdV2 = z.infer<typeof runIdV2Schema>;
export type AttemptId = z.infer<typeof attemptIdSchema>;
export type EvidenceId = z.infer<typeof evidenceIdSchema>;
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;
export type PolicyId = z.infer<typeof policyIdSchema>;
export type ContextSnapshotId = z.infer<typeof contextSnapshotIdSchema>;
export type OperationId = z.infer<typeof operationIdSchema>;
export type ClaimId = z.infer<typeof claimIdSchema>;

export const stableIdentitySchema = z.union([requirementIdSchema, acceptanceCriterionIdSchema,
  productOutcomeIdSchema, successCriterionIdSchema, architectureDecisionIdSchema, programDesignDecisionIdSchema,
  sliceIdSchema, taskIdSchema, verifierIdSchema, analysisFindingIdSchema]);
export const identityRegistrySchema = z.strictObject({
  schema: z.literal("aira.dev/identity-registry/v2"),
  entries: z.array(z.strictObject({
    id: stableIdentitySchema,
    introduced_in: artifactRevisionIdSchema,
    retired_in: artifactRevisionIdSchema.optional(),
  })).refine((entries) => new Set(entries.map((e) => e.id)).size === entries.length, "duplicate-identity"),
});
export type IdentityRegistry = z.infer<typeof identityRegistrySchema>;

/** Retired entries are tombstones. Neither deletion nor retirement permits reuse. */
export function validateIdentityEvolution(previous: IdentityRegistry, next: IdentityRegistry): string[] {
  const issues: string[] = [];
  for (const old of previous.entries) {
    const entry = next.entries.find((e) => e.id === old.id);
    if (!entry || entry.introduced_in !== old.introduced_in ||
        (old.retired_in !== undefined && entry.retired_in !== old.retired_in)) issues.push(old.id);
  }
  return issues.sort();
}

/** Validate edits against both identity history and the previous/next active identity sets.
 * Removal must leave a tombstone; reintroducing an identity retired from canonical content
 * is not an edit to a surviving obligation. Allocation itself belongs to a later caller.
 */
export function validateIdentityChange(previous: IdentityRegistry, next: IdentityRegistry,
  previousActive: readonly z.infer<typeof stableIdentitySchema>[], nextActive: readonly z.infer<typeof stableIdentitySchema>[],
): DomainIssue[] {
  const issues: DomainIssue[] = validateIdentityEvolution(previous, next).map((subject) => ({ code: "identity-history-rewritten", subject }));
  for (const id of previousActive) if (!nextActive.includes(id) && !next.entries.find((entry) => entry.id === id)?.retired_in)
    issues.push({ code: "identity-retirement-missing", subject: id });
  for (const id of nextActive) {
    const entry = next.entries.find((e) => e.id === id);
    if (!entry || entry.retired_in !== undefined) issues.push({ code: "identity-unregistered-or-retired", subject: id });
    if (!previousActive.includes(id) && previous.entries.some((e) => e.id === id)) issues.push({ code: "identity-reused", subject: id });
    if (nextActive.filter((value) => value === id).length !== 1) issues.push({ code: "duplicate-active-identity", subject: id });
  }
  return [...new Map(issues.map((issue) => [`${issue.code}:${issue.subject}`, issue])).entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, issue]) => issue);
}
