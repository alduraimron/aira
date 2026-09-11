import { z } from "zod";
import { acceptanceCriterionIdSchema, artifactRevisionIdSchema, attemptIdSchema, evidenceIdSchema, requirementIdSchema, specIdSchema, taskIdSchema, verifierIdSchema } from "../spec/domain/ids";
import { approvedSpecSnapshotSchema } from "../spec/domain/artifacts";
import { blobReferenceSchema, contentHashSchema, nonBlankSchema, policyReferenceSchema, profileReferenceSchema, timestampSchema, unique } from "../spec/domain/primitives";
import { exactPathSchema } from "../context/declarations";
import { contextSnapshotReferenceSchema } from "../context/snapshot";
import { taskDefinitionReferenceSchema } from "../execution/schema";
import { recoveryDeclarationSchema } from "../execution/recovery";
import { backendCapabilitySchema, executionBackendSchema, workspaceFingerprintSchema } from "../workspace/schema";

export const verifierReferenceSchema = z.strictObject({ id: verifierIdSchema, revision: artifactRevisionIdSchema, hash: contentHashSchema });
export const verifierDefinitionSchema = z.strictObject({
  schema: z.literal("aira.dev/verifier/v1"), identity: verifierReferenceSchema, title: nonBlankSchema,
  requirements: z.array(requirementIdSchema), acceptance_criteria: z.array(acceptanceCriterionIdSchema), tasks: z.array(taskIdSchema),
  policy: policyReferenceSchema, recovery: z.array(recoveryDeclarationSchema), required_backend: z.array(backendCapabilitySchema),
  definition: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("command"), executable: nonBlankSchema, arguments: z.array(z.string()), execution_profile: profileReferenceSchema }),
    z.strictObject({ kind: z.literal("file-state"), checks: z.array(z.strictObject({ path: exactPathSchema, state: z.enum(["present", "absent"]), hash: contentHashSchema.optional() })
      .refine((check) => check.state === "present" || check.hash === undefined, "absent-file-cannot-have-hash")).min(1) }),
    z.strictObject({ kind: z.literal("repository-state"), checks: z.array(z.strictObject({ predicate: z.enum(["clean", "base-revision", "no-conflicts"]), expected: nonBlankSchema })).min(1) }),
    z.strictObject({ kind: z.literal("static-analysis"), analyzer: profileReferenceSchema, rules: z.array(nonBlankSchema) }),
    z.strictObject({ kind: z.literal("human-review"), rubric: nonBlankSchema, actor_kind: z.literal("human") }),
    z.strictObject({ kind: z.literal("agent-review"), rubric: nonBlankSchema, review_profile: profileReferenceSchema }),
    z.strictObject({ kind: z.literal("external"), provider: profileReferenceSchema, contract: nonBlankSchema }),
    z.strictObject({ kind: z.literal("custom"), contract: profileReferenceSchema, configuration: z.record(nonBlankSchema, z.json()) }),
  ]),
}).refine((v) => [v.requirements, v.acceptance_criteria, v.tasks, v.required_backend].every(unique) &&
  v.acceptance_criteria.every((a) => v.requirements.some((r) => a.startsWith(`${r}.`))), "invalid-verifier-mappings");
export const verificationPlanSchema = z.strictObject({
  schema: z.literal("aira.dev/verification-plan/v1"), spec_id: specIdSchema, revision: artifactRevisionIdSchema,
  profile: profileReferenceSchema, verifiers: z.array(verifierDefinitionSchema), required_verifiers: z.array(verifierIdSchema),
  final_consistency_review: verifierIdSchema.optional(),
}).refine((p) => unique(p.verifiers.map((v) => v.identity.id)) && unique(p.required_verifiers) &&
  p.required_verifiers.every((id) => p.verifiers.some((v) => v.identity.id === id)) &&
  (p.final_consistency_review === undefined || p.required_verifiers.includes(p.final_consistency_review)), "invalid-verification-plan");
export const evidenceOutcomeSchema = z.enum(["passed", "failed", "interrupted", "cancelled", "timed_out", "unknown", "skipped"]);
export const evidenceApplicabilityContractSchema = z.strictObject({
  schema: z.literal("aira.dev/evidence-applicability/exact-workspace/v1"),
});
export const verificationEvidenceSchema = z.strictObject({
  schema: z.literal("aira.dev/evidence/v1"), id: evidenceIdSchema, spec_id: specIdSchema,
  verifier: verifierReferenceSchema, profile: profileReferenceSchema, snapshot: approvedSpecSnapshotSchema,
  task: taskDefinitionReferenceSchema, attempt: attemptIdSchema,
  workspace_before: workspaceFingerprintSchema, workspace_after: workspaceFingerprintSchema,
  observation: z.enum(["stable", "unstable", "unknown"]), backend: executionBackendSchema,
  policy: policyReferenceSchema, context: z.array(contextSnapshotReferenceSchema),
  started_at: timestampSchema, ended_at: timestampSchema, outcome: evidenceOutcomeSchema,
  outputs: z.array(blobReferenceSchema),
  requirements: z.array(requirementIdSchema), acceptance_criteria: z.array(acceptanceCriterionIdSchema),
  applicability: evidenceApplicabilityContractSchema,
  review_actor: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("human"), id: nonBlankSchema }),
    z.strictObject({ kind: z.literal("agent"), implementation: profileReferenceSchema }),
  ]).optional(),
}).refine((e) => e.snapshot.spec_id === e.spec_id && Date.parse(e.ended_at) >= Date.parse(e.started_at) &&
  unique(e.requirements) && unique(e.acceptance_criteria) && unique(e.context.map((c) => c.id)), "invalid-evidence-binding");
