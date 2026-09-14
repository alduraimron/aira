import { z } from "zod";
import { contentHashSchema, exact, stableIssues, unique, type DeepReadonly, type DomainIssue } from "../spec/domain/primitives";
import { behavioralAssetRevisionSchema } from "./assets";
import { builtinBundleManifestSchema, type BuiltinBundleManifest } from "./bundle";
import { evaluateAssetCompatibility, type AssetCompatibilityEnvironment } from "./compatibility";
import { assetKey } from "./identity";
import { modeProfileSchema, specKindProfileSchema } from "./profiles";
import { behavioralAssetPinSchema, behavioralRoleSchema, roleAcceptsAsset, type BehavioralAssetPin } from "./roles";

// Supplied observations from a future authenticated content decoder. No lookup, I/O,
// hashing, normalization, or trust establishment is performed by these value contracts.
export const availableBehavioralAssetSchema = z.strictObject({
  revision: behavioralAssetRevisionSchema, verified_content_hash: contentHashSchema,
  configuration: z.union([specKindProfileSchema, modeProfileSchema]).optional(),
}).refine((a) => {
  const kind = a.revision.identity.kind;
  return kind === "spec-kind-profile" ? a.configuration?.schema === "aira.dev/spec-kind-profile/v2" && exact(a.configuration.asset, a.revision.identity) :
    kind === "mode-profile" ? a.configuration?.schema === "aira.dev/mode-profile/v2" && exact(a.configuration.asset, a.revision.identity) : a.configuration === undefined;
}, "asset-configuration-binding-mismatch");
export const behavioralAssetCatalogSchema = z.strictObject({
  assets: z.array(availableBehavioralAssetSchema),
  bundles: z.array(z.strictObject({ manifest: builtinBundleManifestSchema, verified_content_hash: contentHashSchema })),
}).refine((c) => unique(c.assets.map((a) => assetKey(a.revision.identity))) &&
  unique(c.bundles.map((b) => `${b.manifest.identity.id}@${b.manifest.identity.revision}`)) &&
  c.assets.every((a) => c.assets.every((other) => other.revision.identity.id !== a.revision.identity.id ||
    other.revision.identity.kind === a.revision.identity.kind)), "duplicate-or-reassigned-catalog-identity");
export type BehavioralAssetCatalog = DeepReadonly<z.infer<typeof behavioralAssetCatalogSchema>>;
export function validatePinnedAssets(pins: readonly BehavioralAssetPin[], catalog: BehavioralAssetCatalog,
  environment: AssetCompatibilityEnvironment): DomainIssue[] {
  if (!behavioralAssetCatalogSchema.safeParse(catalog).success || pins.some((p) => !behavioralAssetPinSchema.safeParse(p).success))
    return [{ code: "invalid-behavioral-catalog-or-pin" }];
  const issues: DomainIssue[] = [];
  const resolved = pins.map((p) => catalog.assets.find((a) => assetKey(a.revision.identity) === assetKey(p.asset)));
  const interfaces = resolved.flatMap((a) => a?.revision.compatibility.provided_interfaces ?? []);
  for (const [index, pin] of pins.entries()) {
    const key = assetKey(pin.asset), asset = resolved[index];
    if (!asset) { issues.push({ code: "pinned-asset-unavailable", subject: key }); continue; }
    if (!exact(asset.revision.identity, pin.asset)) issues.push({ code: "pinned-asset-identity-mismatch", subject: key });
    if (asset.verified_content_hash !== pin.asset.hash) issues.push({ code: "pinned-asset-hash-mismatch", subject: key });
    issues.push(...evaluateAssetCompatibility(asset.revision.compatibility, environment, interfaces).map((i) => ({ ...i, related: [key] })));
    if (pin.bundle) {
      const bundle = catalog.bundles.find((b) => exact(b.manifest.identity, pin.bundle));
      if (!bundle) issues.push({ code: "pinned-bundle-unavailable", subject: key });
      else {
        if (bundle.verified_content_hash !== pin.bundle.hash) issues.push({ code: "pinned-bundle-hash-mismatch", subject: key });
        if (!bundle.manifest.assets.some((a) => exact(a, pin.asset))) issues.push({ code: "pinned-bundle-asset-mismatch", subject: key });
        issues.push(...evaluateAssetCompatibility(bundle.manifest.compatibility, environment, interfaces));
      }
    }
  }
  return stableIssues(issues);
}

/** Whole-bundle publication validation. Resolution may load only its exact needed
 * inputs; publishing a distribution must validate every member and profile selection.
 * Kind/mode profiles cannot select other profiles, so no dependency solver is needed.
 */
export function validateBuiltinBundleContents(manifest: BuiltinBundleManifest, catalog: BehavioralAssetCatalog,
  environment: AssetCompatibilityEnvironment): DomainIssue[] {
  if (!builtinBundleManifestSchema.safeParse(manifest).success || !behavioralAssetCatalogSchema.safeParse(catalog).success)
    return [{ code: "invalid-builtin-bundle-contents" }];
  const memberPins = manifest.assets.map((asset): BehavioralAssetPin => ({
    role: behavioralRoleSchema.options.find((role) => roleAcceptsAsset(role, asset.kind))!, asset, bundle: manifest.identity,
  }));
  const issues: DomainIssue[] = [], configurationPins: BehavioralAssetPin[] = [];
  for (const asset of manifest.assets) {
    const configuration = catalog.assets.find((a) => exact(a.revision.identity, asset))?.configuration;
    if (!configuration) continue;
    for (const selected of configuration.selections) if (!manifest.assets.some((a) => exact(a, selected.asset)))
      issues.push({ code: "bundle-profile-selection-not-contained", subject: asset.id, related: [assetKey(selected.asset)] });
    configurationPins.push(...configuration.selections);
  }
  issues.push(...validatePinnedAssets([...memberPins, ...configurationPins], catalog, environment));
  for (const selected of manifest.spec_kinds) {
    const c = catalog.assets.find((a) => exact(a.revision.identity, selected.asset))?.configuration;
    if (c?.schema !== "aira.dev/spec-kind-profile/v2" || c.kind !== selected.kind || c.custom_kind !== selected.custom_kind)
      issues.push({ code: "bundle-kind-profile-mismatch", subject: selected.kind });
  }
  for (const selected of manifest.modes) {
    const c = catalog.assets.find((a) => exact(a.revision.identity, selected.asset))?.configuration;
    if (c?.schema !== "aira.dev/mode-profile/v2" || c.mode !== selected.mode) issues.push({ code: "bundle-mode-profile-mismatch", subject: selected.mode });
  }
  return stableIssues(issues);
}
