import { z } from "zod";
import { specIdSchema } from "../spec/domain/ids";
import { specGenerationSchema } from "../spec/domain/generations";
import { createdMetadataSchema, exact, profileReferenceSchema, stableIssues, type DeepReadonly, type DomainIssue } from "../spec/domain/primitives";
import { authoringBehavioralPhaseSchema, hasRoles } from "./roles";
import { behavioralResolutionRequestSchema, behavioralResolutionSchema, effectiveBehavioralPins, resolveBehavioralProfiles } from "./resolution";
import type { BehavioralAssetCatalog } from "./catalog";
import type { AssetCompatibilityEnvironment } from "./compatibility";

// Reuse the existing profile revision/hash vocabulary, not context-snapshot IDs.
export const behavioralProfileSnapshotReferenceSchema = profileReferenceSchema;
export const behavioralProfileSnapshotSchema = z.strictObject({
  schema: z.literal("aira.dev/behavioral-profile-snapshot/v2"), identity: behavioralProfileSnapshotReferenceSchema,
  spec_id: specIdSchema, generation: specGenerationSchema, phase: authoringBehavioralPhaseSchema,
  request: behavioralResolutionRequestSchema, resolution: behavioralResolutionSchema, created: createdMetadataSchema,
}).refine((s) => s.request.task.length === 0 && s.request.kind === s.resolution.kind && s.request.custom_kind === s.resolution.custom_kind &&
  s.request.mode === s.resolution.mode && s.request.authoring_order === s.resolution.authoring_order &&
  hasRoles(effectiveBehavioralPins(s.resolution), [s.phase, "spec-kind-profile", "mode-profile"]), "invalid-behavioral-snapshot-binding");
export type BehavioralProfileSnapshot = DeepReadonly<z.infer<typeof behavioralProfileSnapshotSchema>>;
export type BehavioralProfileSnapshotReference = DeepReadonly<z.infer<typeof behavioralProfileSnapshotReferenceSchema>>;
export function validateBehavioralProfileSnapshot(snapshot: BehavioralProfileSnapshot, catalog: BehavioralAssetCatalog,
  environment: AssetCompatibilityEnvironment): DomainIssue[] {
  if (!behavioralProfileSnapshotSchema.safeParse(snapshot).success) return [{ code: "invalid-behavioral-profile-snapshot" }];
  const result = resolveBehavioralProfiles(snapshot.request, catalog, environment);
  return result.ok ? (exact(result.value, snapshot.resolution) ? [] : [{ code: "behavioral-snapshot-resolution-mismatch", subject: snapshot.identity.id }]) : stableIssues(result.issues);
}
export function validateImmutableBehavioralSnapshot(previous: BehavioralProfileSnapshot, candidate: BehavioralProfileSnapshot): DomainIssue[] {
  return previous.identity.id === candidate.identity.id && previous.identity.revision === candidate.identity.revision && !exact(previous, candidate) ?
    [{ code: "immutable-behavioral-snapshot-overwrite", subject: previous.identity.id }] : [];
}
