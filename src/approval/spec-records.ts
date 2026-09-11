import { z } from "zod";
import { acceptanceCriterionIdSchema, analysisFindingIdSchema, approvalIdSchema, operationIdSchema, requirementIdSchema, specIdSchema, waiverIdSchema } from "../spec/domain/ids";
import { artifactSubjectSchema, sameArtifact } from "../spec/domain/artifacts";
import { specGenerationSchema } from "../spec/domain/generations";
import { channelSchema, createdMetadataSchema, humanActorSchema, nonBlankSchema, policyReferenceSchema, timestampSchema, unique, type DeepReadonly } from "../spec/domain/primitives";

export const specApprovalRecordSchema = z.strictObject({
  schema: z.literal("aira.dev/spec-approval/v1"), id: approvalIdSchema, spec_id: specIdSchema,
  operation: operationIdSchema, actor: humanActorSchema, channel: channelSchema.optional(),
  observed_generation: specGenerationSchema, committed_generation: specGenerationSchema,
  subjects: z.array(artifactSubjectSchema).min(1), decision: z.enum(["approved", "rejected"]),
  scope: z.enum(["artifact", "integrated"]), integrated_group: operationIdSchema.optional(),
  at: timestampSchema, comment: z.string().optional(),
}).refine((a) => BigInt(a.committed_generation) === BigInt(a.observed_generation) + 1n &&
  unique(a.subjects.map((s) => s.artifact.kind)) &&
  a.subjects.every((s) => ["requirements", "design", "tasks", "verification-plan"].includes(s.artifact.kind)) &&
  (a.scope === "artifact" ? a.subjects.length === 1 && a.integrated_group === undefined :
    a.integrated_group === a.operation && a.subjects.length === 3 &&
      ["requirements", "design", "tasks"].every((k) => a.subjects.some((s) => s.artifact.kind === k))), "invalid-approval-binding");
export const approvalApplicabilitySchema = z.strictObject({
  schema: z.literal("aira.dev/approval-applicability/v1"), approval: approvalIdSchema, spec_id: specIdSchema,
  subject: artifactSubjectSchema, generation: specGenerationSchema,
  status: z.enum(["applicable", "revoked", "superseded"]),
  carried_from: specGenerationSchema.optional(), superseded_by: approvalIdSchema.optional(),
  reason: nonBlankSchema, created: createdMetadataSchema,
}).refine((a) => (a.carried_from === undefined || BigInt(a.carried_from) < BigInt(a.generation)) &&
  (a.status === "superseded") === (a.superseded_by !== undefined), "invalid-approval-applicability");
export const waiverScopeSchema = z.strictObject({
  code: z.enum(["unresolved-blocker", "requirement-design-missing", "requirement-implementation-missing",
    "acceptance-implementation-missing", "requirement-verification-missing", "acceptance-verification-missing"]),
  subject: nonBlankSchema,
}).refine((scope) => (scope.code === "unresolved-blocker" ? analysisFindingIdSchema :
  scope.code.startsWith("acceptance-") ? acceptanceCriterionIdSchema : requirementIdSchema).safeParse(scope.subject).success, "invalid-waiver-scope-identity");
export const humanWaiverSchema = z.strictObject({
  schema: z.literal("aira.dev/human-waiver/v1"), id: waiverIdSchema, spec_id: specIdSchema,
  actor: humanActorSchema, channel: channelSchema.optional(), operation: operationIdSchema,
  policy: policyReferenceSchema, scope: waiverScopeSchema, subjects: z.array(artifactSubjectSchema).min(1),
  observed_generation: specGenerationSchema, committed_generation: specGenerationSchema,
  rationale: nonBlankSchema, at: timestampSchema,
}).refine((w) => BigInt(w.committed_generation) === BigInt(w.observed_generation) + 1n &&
  unique(w.subjects.map((s) => s.artifact.kind)), "invalid-waiver-binding");
export const waiverApplicabilitySchema = z.strictObject({
  schema: z.literal("aira.dev/waiver-applicability/v1"), waiver: waiverIdSchema, spec_id: specIdSchema,
  generation: specGenerationSchema, status: z.enum(["active", "revoked", "superseded"]),
  carried_from: specGenerationSchema.optional(), superseded_by: waiverIdSchema.optional(),
  reason: nonBlankSchema, created: createdMetadataSchema,
}).refine((a) => (a.carried_from === undefined || BigInt(a.carried_from) < BigInt(a.generation)) &&
  (a.status === "superseded") === (a.superseded_by !== undefined), "invalid-waiver-applicability");
export const specDecisionPolicySchema = z.strictObject({
  schema: z.literal("aira.dev/spec-decision-policy/v1"), identity: policyReferenceSchema,
  waivable: z.array(waiverScopeSchema.shape.code),
  required_analyses: z.array(z.enum(["requirements", "design", "tasks"])),
}).refine((p) => unique(p.waivable) && unique(p.required_analyses) &&
  ["requirements", "design", "tasks"].every((k) => p.required_analyses.includes(k as "requirements" | "design" | "tasks")), "required-analysis-cannot-be-disabled");
export type SpecApprovalRecord = DeepReadonly<z.infer<typeof specApprovalRecordSchema>>;
export type ApprovalApplicability = z.infer<typeof approvalApplicabilitySchema>;
export type HumanWaiver = DeepReadonly<z.infer<typeof humanWaiverSchema>>;
export type WaiverApplicability = z.infer<typeof waiverApplicabilitySchema>;
export type SpecDecisionPolicy = z.infer<typeof specDecisionPolicySchema>;
export const sameSubject = (a: z.infer<typeof artifactSubjectSchema>, b: z.infer<typeof artifactSubjectSchema>): boolean =>
  sameArtifact(a.artifact, b.artifact) && a.lineage_hash === b.lineage_hash;
