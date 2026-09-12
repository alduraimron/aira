import { z } from "zod";
import { contentHashSchema, createdMetadataSchema, exact, nonBlankSchema, policyReferenceSchema, profileReferenceSchema,
  stableIssues, unique, type DeepReadonly, type DomainIssue } from "../spec/domain/primitives";
import { assetCompatibilitySchema } from "./compatibility";
import { assetKey, assetProvenanceSchema, builtinAssetIdSchema, builtinAssetRevisionIdSchema, provenanceMatchesId } from "./identity";

export const behavioralAssetKindSchema = z.enum(["prompt-profile", "analysis-profile", "spec-kind-profile", "mode-profile", "skill",
  "context-profile", "capability-policy-profile", "verification-profile", "execution-profile", "execution-recipe"]);
const identity = { id: builtinAssetIdSchema, revision: builtinAssetRevisionIdSchema, hash: contentHashSchema, provenance: assetProvenanceSchema };
// References reuse the existing typed domain identities. The asset envelope is NOT a
// parallel policy/verifier/execution model. Its byte hash and the referenced body hash
// have different subjects and need not be equal.
export const behavioralAssetReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...identity, kind: z.literal("prompt-profile") }),
  z.strictObject({ ...identity, kind: z.literal("analysis-profile"), profile: profileReferenceSchema }),
  z.strictObject({ ...identity, kind: z.literal("spec-kind-profile") }),
  z.strictObject({ ...identity, kind: z.literal("mode-profile") }),
  z.strictObject({ ...identity, kind: z.literal("skill") }),
  z.strictObject({ ...identity, kind: z.literal("context-profile"), profile: profileReferenceSchema }),
  z.strictObject({ ...identity, kind: z.literal("capability-policy-profile"), policy: policyReferenceSchema }),
  z.strictObject({ ...identity, kind: z.literal("verification-profile"), profile: profileReferenceSchema }),
  z.strictObject({ ...identity, kind: z.literal("execution-profile"), profile: profileReferenceSchema }),
  z.strictObject({ ...identity, kind: z.literal("execution-recipe"), profile: profileReferenceSchema }),
]).refine((a) => provenanceMatchesId(a.id, a.provenance), "asset-provenance-namespace-mismatch");
export const behavioralAssetRevisionSchema = z.strictObject({
  schema: z.literal("aira.dev/behavioral-asset/v1"), identity: behavioralAssetReferenceSchema,
  content_encoding: z.literal("aira.dev/asset-bytes/raw/v1"),
  compatibility: assetCompatibilitySchema,
  metadata: z.strictObject({ title: nonBlankSchema, description: nonBlankSchema, labels: z.array(nonBlankSchema).refine(unique), published: createdMetadataSchema }),
  supersedes: behavioralAssetReferenceSchema.optional(),
}).refine((r) => !r.supersedes || (r.supersedes.id === r.identity.id && r.supersedes.kind === r.identity.kind &&
  exact(r.supersedes.provenance, r.identity.provenance) && builtinAssetRevisionIdSchema.safeParse(r.supersedes.revision).success &&
  builtinAssetRevisionIdSchema.safeParse(r.identity.revision).success && BigInt(r.supersedes.revision) < BigInt(r.identity.revision)), "invalid-asset-predecessor");
export type BehavioralAssetKind = z.infer<typeof behavioralAssetKindSchema>;
export type BehavioralAssetReference = DeepReadonly<z.infer<typeof behavioralAssetReferenceSchema>>;
export type BehavioralAssetRevision = DeepReadonly<z.infer<typeof behavioralAssetRevisionSchema>>;
export function validateImmutableAssetRevision(previous: BehavioralAssetRevision, candidate: BehavioralAssetRevision): DomainIssue[] {
  return assetKey(previous.identity) === assetKey(candidate.identity) && !exact(previous, candidate) ?
    [{ code: "immutable-asset-revision-overwrite", subject: assetKey(previous.identity) }] : [];
}
/** Publication history validation, not a requirement to install every historical predecessor. */
export function validateAssetRevisionHistory(revisions: readonly BehavioralAssetRevision[]): DomainIssue[] {
  const issues: DomainIssue[] = [];
  for (const revision of revisions) {
    if (!behavioralAssetRevisionSchema.safeParse(revision).success) { issues.push({ code: "invalid-asset-revision" }); continue; }
    const key = assetKey(revision.identity);
    if (revisions.filter((r) => assetKey(r.identity) === key).length !== 1) issues.push({ code: "duplicate-asset-revision", subject: key });
    if (revisions.some((r) => r.identity.id === revision.identity.id && (r.identity.kind !== revision.identity.kind || !exact(r.identity.provenance, revision.identity.provenance))))
      issues.push({ code: "asset-logical-identity-reassigned", subject: revision.identity.id });
    if (revision.supersedes && !revisions.some((r) => exact(r.identity, revision.supersedes))) issues.push({ code: "asset-predecessor-unavailable", subject: key });
  }
  return stableIssues(issues);
}
