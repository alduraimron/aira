import { z } from "zod";
import { artifactRevisionIdSchema, approvalIdSchema, specIdSchema, stableIdentitySchema } from "./ids";
import { blobReferenceSchema, contentHashSchema, createdMetadataSchema, nonBlankSchema, policyReferenceSchema, profileReferenceSchema, unique, exact, type DeepReadonly, type DomainIssue } from "./primitives";
import { specGenerationSchema } from "./generations";
import { behavioralProfileSnapshotReferenceSchema } from "../../builtins/snapshots";
import { authoringBehavioralPhaseSchema, behavioralPinsSchema, hasRoles } from "../../builtins/roles";
import { pinsPolicy, pinsProfile } from "../../builtins/bindings";

import { planningKinds } from "./planning-kinds";

export const artifactKindSchema = z.enum(["intent", ...planningKinds, "analysis", "verification-plan"]);
export const approvalArtifactKindSchema = z.enum([...planningKinds, "verification-plan"]);
export const artifactReferenceSchema = z.strictObject({
  kind: artifactKindSchema, revision: artifactRevisionIdSchema, hash: contentHashSchema,
});
export const artifactSubjectSchema = z.strictObject({
  artifact: artifactReferenceSchema,
  // Digest of IMMUTABLE content provenance. validated_against remains separate
  // applicability, so revalidating unchanged architecture does not require new human content approval.
  lineage_hash: contentHashSchema,
});
export const entityHashSchema = z.strictObject({ id: stableIdentitySchema, hash: contentHashSchema });
export const provenanceEdgeSchema = z.discriminatedUnion("relation", [
  z.strictObject({ relation: z.literal("derived_from"), target: artifactReferenceSchema,
    scope: z.array(entityHashSchema).min(1).refine((s) => unique(s.map((e) => e.id))).optional() }),
  z.strictObject({ relation: z.literal("generated_from_intent"), target: artifactReferenceSchema.refine((r) => r.kind === "intent") }),
  z.strictObject({ relation: z.literal("supersedes"), target: artifactReferenceSchema }),
]);
export const artifactRevisionSchema = z.strictObject({
  schema: z.literal("aira.dev/artifact-revision/v2"), id: artifactRevisionIdSchema,
  spec_id: specIdSchema, kind: artifactKindSchema, content: blobReferenceSchema,
  created: createdMetadataSchema, lineage: z.array(provenanceEdgeSchema),
  behavioral_profile: behavioralProfileSnapshotReferenceSchema.optional(),
}).superRefine((r, ctx) => {
  if (r.created.by.kind !== "human" && !r.behavioral_profile)
    ctx.addIssue({ code: "custom", message: "generated-artifact-behavioral-profile-required" });
  if (!unique(r.lineage.map((e) => `${e.relation}:${e.target.revision}`)))
    ctx.addIssue({ code: "custom", message: "duplicate-lineage-edge" });
  for (const edge of r.lineage) {
    if (edge.target.revision === r.id) ctx.addIssue({ code: "custom", message: "self-lineage" });
    if (edge.relation === "supersedes" && edge.target.kind !== r.kind)
      ctx.addIssue({ code: "custom", message: "supersedes-kind-mismatch" });
  }
  if (r.lineage.filter((e) => e.relation === "supersedes").length > 1)
    ctx.addIssue({ code: "custom", message: "multiple-predecessors" });
});
export const validationRecordSchema = z.strictObject({
  schema: z.literal("aira.dev/lineage-validation/v2"),
  relation: z.literal("validated_against"), subject: artifactReferenceSchema,
  against: z.array(artifactReferenceSchema).min(1), analysis: artifactReferenceSchema.refine((r) => r.kind === "analysis"),
  outcome: z.enum(["consistent", "inconsistent", "unknown"]),
  generation: specGenerationSchema, created: createdMetadataSchema,
}).refine((r) => unique(r.against.map((a) => a.kind)) && r.against.every((a) => a.revision !== r.subject.revision), "invalid-validation-inputs");
export const artifactInvalidationSchema = z.strictObject({
  schema: z.literal("aira.dev/artifact-invalidation/v2"), subject: artifactReferenceSchema,
  generation: specGenerationSchema, reason: nonBlankSchema, created: createdMetadataSchema,
});
export const specBehavioralBindingSchema = z.strictObject({
  output: artifactReferenceSchema, phase: authoringBehavioralPhaseSchema,
  snapshot: behavioralProfileSnapshotReferenceSchema, generation: specGenerationSchema,
}).refine((b) => ({ clarification: ["intent"], "product-generation": ["product"], "product-analysis": ["analysis"],
  "program-design-generation": ["program-design"], "program-design-analysis": ["analysis"], "slice-plan-generation": ["slice-plan"], "slice-plan-analysis": ["analysis"],
  "requirements-generation": ["requirements"], "architecture-generation": ["architecture"],
  "task-generation": ["tasks", "verification-plan"], "requirements-analysis": ["analysis"], "architecture-analysis": ["analysis"], "task-analysis": ["analysis"], "final-spec-review": ["analysis"] })[b.phase].includes(b.output.kind), "behavioral-output-phase-mismatch");
export const specBehavioralBindingsSchema = z.array(specBehavioralBindingSchema)
  .refine((bs) => unique(bs.map((b) => b.output.revision)), "duplicate-behavioral-output-binding");
export const approvedSpecSnapshotSchema = z.strictObject({
  schema: z.literal("aira.dev/approved-spec-snapshot/v2"), spec_id: specIdSchema,
  generation: specGenerationSchema, artifacts: z.array(artifactSubjectSchema).min(6),
  approvals: z.array(approvalIdSchema).min(1),
  decision_policy: policyReferenceSchema, completion_policy: policyReferenceSchema,
  verification_profile: profileReferenceSchema, capability_policies: z.array(policyReferenceSchema),
  behavioral_profiles: specBehavioralBindingsSchema, behavioral_assets: behavioralPinsSchema,
}).refine((s) => unique(s.artifacts.map((a) => a.artifact.kind)) &&
  planningKinds.every((k) => s.artifacts.some((a) => a.artifact.kind === k)) &&
  unique(s.approvals) && unique(s.capability_policies.map((p) => p.id)) &&
  specGenerationSchema.safeParse(s.generation).success &&
  s.behavioral_profiles.every((b) => specGenerationSchema.safeParse(b.generation).success && BigInt(b.generation) <= BigInt(s.generation)) &&
  hasRoles(s.behavioral_assets, ["implementation", "context-profile", "capability-profile", "execution-profile", "verification-profile"]) &&
  pinsProfile(s.behavioral_assets, "verification-profile", s.verification_profile) &&
  s.capability_policies.every((p) => pinsPolicy(s.behavioral_assets, p)) &&
  s.behavioral_assets.every((p) => {
    const asset = p.asset;
    return asset.kind !== "capability-policy-profile" || s.capability_policies.some((policy) => exact(policy, asset.policy));
  }), "invalid-approved-snapshot");
export const intentSchema = z.strictObject({
  schema: z.literal("aira.dev/intent/v1"), spec_id: specIdSchema, revision: artifactRevisionIdSchema,
  statement: nonBlankSchema, constraints: z.array(nonBlankSchema), metadata: createdMetadataSchema,
});
export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
export type ArtifactSubject = z.infer<typeof artifactSubjectSchema>;
export type ArtifactRevision = DeepReadonly<z.infer<typeof artifactRevisionSchema>>;
export type ValidationRecord = DeepReadonly<z.infer<typeof validationRecordSchema>>;
export type ArtifactInvalidation = DeepReadonly<z.infer<typeof artifactInvalidationSchema>>;
export type ApprovedSpecSnapshot = DeepReadonly<z.infer<typeof approvedSpecSnapshotSchema>>;
export function sameSpecBehavioralBindings(a: ApprovedSpecSnapshot["behavioral_profiles"], b: ApprovedSpecSnapshot["behavioral_profiles"]): boolean {
  return a.length === b.length && a.every((binding) => b.some((other) => exact(binding, other)));
}
export const referenceOf = (revision: ArtifactRevision): ArtifactReference => ({
  kind: revision.kind, revision: revision.id, hash: revision.content.hash,
});
export const sameArtifact = (a: ArtifactReference, b: ArtifactReference): boolean =>
  a.kind === b.kind && a.revision === b.revision && a.hash === b.hash;
/** A later store can use this predicate before accepting an existing immutable identity. */
export function validateImmutableRevision(previous: ArtifactRevision, candidate: ArtifactRevision): DomainIssue[] {
  return previous.id === candidate.id && !exact(previous, candidate) ? [{ code: "immutable-revision-overwrite", subject: previous.id }] : [];
}
