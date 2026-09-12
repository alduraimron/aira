import { z } from "zod";
import { contentHashSchema } from "../spec/domain/primitives";

// Logical product identities, never filenames. Project namespace includes its owner.
export const builtinAssetIdSchema = z.string().max(200)
  .regex(/^(?:builtin\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*|project\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*)$/)
  .brand<"BuiltinAssetId">();
const revision = z.string().regex(/^[1-9][0-9]{0,19}$/)
  .refine((s) => /^[1-9][0-9]{0,19}$/.test(s) && BigInt(s) <= 18446744073709551615n, "asset-revision-overflow");
export const builtinAssetRevisionIdSchema = revision.brand<"BuiltinAssetRevisionId">();
export const builtinBundleIdSchema = z.string().max(200).regex(/^bundle\.aira\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/).brand<"BuiltinBundleId">();
export const builtinBundleRevisionIdSchema = revision.brand<"BuiltinBundleRevisionId">();
export const builtinBundleReferenceSchema = z.strictObject({
  id: builtinBundleIdSchema, revision: builtinBundleRevisionIdSchema, hash: contentHashSchema,
});
export const assetProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("aira-builtin"), publisher: z.literal("aira") }),
  z.strictObject({ kind: z.literal("project"), project: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
]);
export type BuiltinAssetId = z.infer<typeof builtinAssetIdSchema>;
export type BuiltinAssetRevisionId = z.infer<typeof builtinAssetRevisionIdSchema>;
export type BuiltinBundleId = z.infer<typeof builtinBundleIdSchema>;
export type BuiltinBundleRevisionId = z.infer<typeof builtinBundleRevisionIdSchema>;
export type BuiltinBundleReference = Readonly<z.infer<typeof builtinBundleReferenceSchema>>;
export type AssetProvenance = Readonly<z.infer<typeof assetProvenanceSchema>>;
export const assetKey = (asset: { readonly id: BuiltinAssetId; readonly revision: BuiltinAssetRevisionId }): string => `${asset.id}@${asset.revision}`;
export function provenanceMatchesId(id: BuiltinAssetId, provenance: AssetProvenance): boolean {
  return provenance.kind === "aira-builtin" ? id.startsWith("builtin.") : id.startsWith(`project.${provenance.project}.`);
}
