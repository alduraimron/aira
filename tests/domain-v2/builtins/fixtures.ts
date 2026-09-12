import { behavioralAssetKindSchema, behavioralAssetRevisionSchema, type BehavioralAssetRevision } from "../../../src/builtins/assets";
import { behavioralAssetPinSchema, roleAcceptsAsset, type BehavioralAssetPin, type BehavioralRole } from "../../../src/builtins/roles";
import { availableBehavioralAssetSchema, behavioralAssetCatalogSchema } from "../../../src/builtins/catalog";
import { builtinBundleManifestSchema } from "../../../src/builtins/bundle";
import { modeProfileSchema, specKindProfileSchema } from "../../../src/builtins/profiles";
import { behavioralResolutionRequestSchema } from "../../../src/builtins/resolution";
import { hash, metadata, profile, policyRef } from "../fixtures";
import { syntheticCompatibility, syntheticEnvironment } from "../behavioral-fixtures";

export { hash, metadata, profile, policyRef, syntheticCompatibility, syntheticEnvironment };
export function pin(role: BehavioralRole = "requirements-generation", revision = "1", name = role as string, project?: string) {
  const kind = behavioralAssetKindSchema.options.find((kind) => roleAcceptsAsset(role, kind))!;
  const target = ["analysis-profile", "context-profile", "verification-profile", "execution-profile", "execution-recipe"].includes(kind) ? { profile: profile(name.replaceAll(".", "_")) } :
    kind === "capability-policy-profile" ? { policy: policyRef(name.replaceAll(".", "_")) } : {};
  return behavioralAssetPinSchema.parse({ role, asset: { kind, id: project ? `project.${project}.${name}` : `builtin.test.${name}`,
    revision, hash: hash(400 + Number(revision)), provenance: project ? { kind: "project", project } : { kind: "aira-builtin", publisher: "aira" }, ...target } });
}
export function revision(p: BehavioralAssetPin = pin()) {
  return behavioralAssetRevisionSchema.parse({ schema: "aira.dev/behavioral-asset/v1", identity: p.asset, content_encoding: "aira.dev/asset-bytes/raw/v1",
    compatibility: syntheticCompatibility, metadata: { title: "Synthetic", description: "No product content", labels: [], published: metadata } });
}
export function available(p: BehavioralAssetPin, configuration?: ReturnType<typeof specKindProfileSchema.parse> | ReturnType<typeof modeProfileSchema.parse>, r: BehavioralAssetRevision = revision(p)) {
  return availableBehavioralAssetSchema.parse({ revision: r, verified_content_hash: p.asset.hash, ...(configuration ? { configuration } : {}) });
}
export function library() {
  const roles: BehavioralRole[] = ["clarification", "requirements-generation", "requirements-analysis", "design-generation", "design-analysis", "task-generation", "task-analysis",
    "implementation", "repair", "implementation-review", "verification-review", "final-spec-review", "context-profile", "capability-profile", "verification-profile", "execution-profile", "execution-recipe", "host-skill"];
  const defaults = roles.map((role) => pin(role));
  const special = ["feature", "bugfix", "refactor", "migration", "custom"] as const;
  const specialized = special.map((k) => pin("requirements-analysis", "1", `${k}.requirements-analysis`));
  const kinds = special.map((kind, i) => specKindProfileSchema.parse({ schema: "aira.dev/spec-kind-profile/v1", asset: pin("spec-kind-profile", "1", `spec.${kind}`).asset,
    kind, ...(kind === "custom" ? { custom_kind: "audit" } : {}), selections: [specialized[i]], required_roles: ["requirements-analysis"] }));
  const modes = (["requirements-first", "design-first", "quick"] as const).map((mode) => modeProfileSchema.parse({ schema: "aira.dev/mode-profile/v1", asset: pin("mode-profile", "1", `mode.${mode}`).asset,
    mode, authoring_order: mode === "design-first" ? "design-first" : "requirements-first",
    approval_presentation: mode === "quick" ? "integrated" : "per-artifact", review_presentation: mode === "quick" ? "integrated-with-canonical-analyses" : "phase-specific", selections: [] }));
  const assets = [...defaults.map((p) => available(p)), ...specialized.map((p) => available(p)),
    ...kinds.map((k) => available({ role: "spec-kind-profile", asset: k.asset }, k)), ...modes.map((m) => available({ role: "mode-profile", asset: m.asset }, m))];
  const bundle = builtinBundleManifestSchema.parse({ schema: "aira.dev/builtin-bundle/v1", identity: { id: "bundle.aira.test", revision: "1", hash: hash(500) }, distribution_version: "2.0.0-test",
    compatibility: syntheticCompatibility, assets: assets.map((a) => a.revision.identity), defaults,
    spec_kinds: kinds.map((k) => ({ kind: k.kind, ...(k.custom_kind ? { custom_kind: k.custom_kind } : {}), asset: k.asset })), modes: modes.map((m) => ({ mode: m.mode, asset: m.asset })) });
  const catalog = behavioralAssetCatalogSchema.parse({ assets, bundles: [{ manifest: bundle, verified_content_hash: bundle.identity.hash }] });
  const request = behavioralResolutionRequestSchema.parse({ schema: "aira.dev/behavioral-resolution-request/v1", kind: "feature", mode: "requirements-first", authoring_order: "requirements-first",
    required_roles: ["requirements-generation", "requirements-analysis"], bundle: bundle.identity, spec: [], task: [] });
  return { defaults, specialized, kinds, modes, bundle, catalog, request, environment: syntheticEnvironment() };
}
