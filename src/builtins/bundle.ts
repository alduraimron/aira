import { z } from "zod";
import { specKindSchema } from "../spec/domain/kinds";
import { specModeSchema } from "../spec/domain/lifecycle";
import { exact, nonBlankSchema, unique, type DeepReadonly, type DomainIssue } from "../spec/domain/primitives";
import { behavioralAssetReferenceSchema } from "./assets";
import { assetCompatibilitySchema } from "./compatibility";
import { assetKey, builtinBundleReferenceSchema } from "./identity";
import { behavioralAssetSelectionSchema } from "./roles";

export const builtinBundleManifestSchema = z.strictObject({
  schema: z.literal("aira.dev/builtin-bundle/v2"), identity: builtinBundleReferenceSchema,
  distribution_version: nonBlankSchema, compatibility: assetCompatibilitySchema,
  assets: z.array(behavioralAssetReferenceSchema).min(1),
  defaults: z.array(behavioralAssetSelectionSchema),
  spec_kinds: z.array(z.strictObject({ kind: specKindSchema, custom_kind: nonBlankSchema.optional(), asset: behavioralAssetReferenceSchema })
    .refine((s) => s.asset.kind === "spec-kind-profile" && (s.kind === "custom") === (s.custom_kind !== undefined), "invalid-bundle-kind-profile")),
  modes: z.array(z.strictObject({ mode: specModeSchema, asset: behavioralAssetReferenceSchema })
    .refine((s) => s.asset.kind === "mode-profile", "invalid-bundle-mode-profile")),
}).superRefine((b, ctx) => {
  const issue = (message: string): void => { ctx.addIssue({ code: "custom", message }); };
  if (!unique(b.assets.map(assetKey))) issue("duplicate-bundle-asset-revision");
  if (b.assets.some((a) => a.provenance.kind !== "aira-builtin")) issue("bundle-contains-non-builtin");
  if (b.assets.some((a) => b.assets.some((other) => other.id === a.id && other.kind !== a.kind))) issue("bundle-asset-kind-reassigned");
  if (!unique(b.defaults.map((d) => d.role)) || !unique(b.spec_kinds.map((k) => `${k.kind}:${k.custom_kind ?? ""}`)) || !unique(b.modes.map((m) => m.mode))) issue("duplicate-bundle-default");
  if (b.defaults.some((s) => ["spec-kind-profile", "mode-profile"].includes(s.role))) issue("use-typed-bundle-profile-default");
  for (const selected of [...b.defaults, ...b.spec_kinds, ...b.modes])
    if (!b.assets.some((a) => exact(a, selected.asset))) issue("bundle-reference-mismatch");
});
export type BuiltinBundleManifest = DeepReadonly<z.infer<typeof builtinBundleManifestSchema>>;
export function validateImmutableBuiltinBundle(previous: BuiltinBundleManifest, candidate: BuiltinBundleManifest): DomainIssue[] {
  return previous.identity.id === candidate.identity.id && previous.identity.revision === candidate.identity.revision && !exact(previous, candidate) ?
    [{ code: "immutable-bundle-overwrite", subject: `${previous.identity.id}@${previous.identity.revision}` }] : [];
}
