import { z } from "zod";
import { approvalIdSchema, identityRegistrySchema, revisionRequestIdSchema, specIdSchema, waiverIdSchema } from "./ids";
import { artifactReferenceSchema, artifactSubjectSchema, artifactInvalidationSchema, validationRecordSchema } from "./artifacts";
import { commitSequenceSchema, specGenerationSchema } from "./generations";
import { lifecycleSchema, specModeSchema, lifecycleAllowedForMode } from "./lifecycle";
import { createdMetadataSchema, nonBlankSchema, policyReferenceSchema, timestampSchema, unique } from "./primitives";
import { approvalApplicabilitySchema, specDecisionPolicySchema, waiverApplicabilitySchema } from "../../approval/spec-records";
import { runBindingSchema } from "../../execution/schema";

export const completionPolicySchema = z.strictObject({
  schema: z.literal("aira.dev/spec-completion-policy/v1"), identity: policyReferenceSchema,
  traceability: z.enum(["must", "must-and-should", "all"]),
  allow_agent_review: z.boolean(), final_consistency_review_required: z.boolean(),
  verification_plan_approval_required: z.boolean(),
});
export const specSchema = z.strictObject({
  schema: z.literal("aira.dev/spec/v1"), id: specIdSchema, title: nonBlankSchema,
  kind: z.enum(["feature", "bugfix", "refactor", "migration", "custom"]), custom_kind: nonBlankSchema.optional(),
  mode: specModeSchema, authoring_order: z.enum(["requirements-first", "design-first"]), lifecycle: lifecycleSchema,
  commit_sequence: commitSequenceSchema.optional(), generation: specGenerationSchema,
  artifacts: z.strictObject({ current: z.array(artifactSubjectSchema), proposed: z.array(artifactReferenceSchema), superseded: z.array(artifactReferenceSchema) }),
  analyses: z.array(artifactReferenceSchema.refine((a) => a.kind === "analysis")),
  lineage: z.strictObject({ validations: z.array(validationRecordSchema), invalidations: z.array(artifactInvalidationSchema) }),
  approvals: z.array(approvalIdSchema), approval_applicability: z.array(approvalApplicabilitySchema),
  revisions: z.array(revisionRequestIdSchema), waivers: z.array(waiverIdSchema), waiver_applicability: z.array(waiverApplicabilitySchema), identities: identityRegistrySchema,
  decision_policy: specDecisionPolicySchema, completion_policy: completionPolicySchema,
  run_binding: runBindingSchema.optional(), created: createdMetadataSchema, updated_at: timestampSchema,
  metadata: z.strictObject({ labels: z.array(nonBlankSchema), description: nonBlankSchema.optional(), external_references: z.array(nonBlankSchema) }),
}).superRefine((s, ctx) => {
  const issue = (message: string): void => { ctx.addIssue({ code: "custom", message }); };
  if ((s.kind === "custom") !== (s.custom_kind !== undefined)) issue("invalid-custom-spec-kind");
  if (s.mode !== "quick" && s.mode !== s.authoring_order) issue("spec-authoring-order-mismatch");
  if (!lifecycleAllowedForMode(s.mode, s.lifecycle)) issue("invalid-lifecycle-mode");
  if (!unique(s.artifacts.current.map((a) => a.artifact.kind)) || s.artifacts.current.some((a) => a.artifact.kind === "analysis")) issue("ambiguous-current-artifact");
  const all = [...s.artifacts.current.map((a) => a.artifact), ...s.artifacts.proposed, ...s.artifacts.superseded];
  if (!unique(all.map((a) => a.revision)) || !unique(s.analyses.map((a) => a.revision))) issue("duplicate-artifact-selection");
  if (![s.approvals, s.revisions, s.waivers].every(unique)) issue("duplicate-spec-record");
  if (s.approval_applicability.some((a) => a.spec_id !== s.id || !s.approvals.includes(a.approval) || a.generation !== s.generation)) issue("invalid-current-approval-binding");
  if (!unique(s.approval_applicability.map((a) => `${a.approval}:${a.subject.artifact.kind}`))) issue("duplicate-approval-applicability");
  if (!unique(s.waiver_applicability.map((a) => a.waiver)) || s.waiver_applicability.some((a) => a.spec_id !== s.id || !s.waivers.includes(a.waiver) || a.generation !== s.generation)) issue("invalid-current-waiver-binding");
  if (s.run_binding && (s.run_binding.snapshot.spec_id !== s.id || BigInt(s.run_binding.applicable_generation) > BigInt(s.generation))) issue("invalid-spec-run-binding");
  if (Date.parse(s.updated_at) < Date.parse(s.created.at)) issue("invalid-spec-timestamps");
});
