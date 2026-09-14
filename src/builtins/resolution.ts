import { z } from "zod";
import { specKindSchema } from "../spec/domain/kinds";
import { specModeSchema } from "../spec/domain/lifecycle";
import { exact, nonBlankSchema, stableIssues, unique, type DeepReadonly, type DomainIssue, type DomainResult } from "../spec/domain/primitives";
import { assetKey, builtinBundleReferenceSchema } from "./identity";
import { behavioralAssetCatalogSchema, validatePinnedAssets, type BehavioralAssetCatalog } from "./catalog";
import { assetCompatibilityEnvironmentSchema, evaluateAssetCompatibility, type AssetCompatibilityEnvironment } from "./compatibility";
import { behavioralAssetPinSchema, behavioralPinsSchema, behavioralRoleSchema, behavioralSelectionsSchema, distinctCapabilityPins, taskBehavioralSelectionsSchema,
  type BehavioralAssetPin, type BehavioralRole } from "./roles";

export const behavioralSelectionSourceSchema = z.enum(["bundle", "mode", "spec-kind", "spec", "task"]);
const sources = behavioralSelectionSourceSchema.options;
export const behavioralResolutionDecisionSchema = z.strictObject({
  role: behavioralRoleSchema, strategy: z.enum(["replace", "restrict-all"]),
  candidates: z.array(z.strictObject({ source: behavioralSelectionSourceSchema, pin: behavioralAssetPinSchema })).min(1),
  effective: behavioralPinsSchema.refine((ps) => ps.length > 0),
}).refine((d) => d.candidates.length > 0 && d.candidates.every((c, i) => c.pin.role === d.role && (i === 0 || sources.indexOf(d.candidates[i - 1]!.source) < sources.indexOf(c.source))) &&
  d.strategy === (d.role === "capability-profile" ? "restrict-all" : "replace") &&
  exact(d.effective, d.role === "capability-profile" ? distinctCapabilityPins(d.candidates.map((c) => c.pin)) : [d.candidates.at(-1)!.pin]), "invalid-behavioral-resolution-decision");
export const behavioralResolutionSchema = z.strictObject({
  schema: z.literal("aira.dev/behavioral-resolution/v2"), kind: specKindSchema, custom_kind: nonBlankSchema.optional(),
  mode: specModeSchema, authoring_order: z.enum(["requirements-first", "architecture-first"]),
  required_roles: z.array(behavioralRoleSchema).min(1).refine(unique),
  decisions: z.array(behavioralResolutionDecisionSchema).min(1),
}).refine((r) => (r.kind === "custom") === (r.custom_kind !== undefined) && (r.mode === "quick" || r.mode === r.authoring_order) &&
  unique(r.decisions.map((d) => d.role)) && r.required_roles.every((role) => r.decisions.some((d) => d.role === role)), "invalid-behavioral-resolution");
export type BehavioralResolution = DeepReadonly<z.infer<typeof behavioralResolutionSchema>>;
export const effectiveBehavioralPins = (resolution: BehavioralResolution): readonly BehavioralAssetPin[] => resolution.decisions.flatMap((d) => d.effective);
const plainSelections = behavioralSelectionsSchema.refine((ps) => ps.every((p) => !["spec-kind-profile", "mode-profile"].includes(p.role)), "use-typed-profile-selection");
export const behavioralResolutionRequestSchema = z.strictObject({
  schema: z.literal("aira.dev/behavioral-resolution-request/v2"), kind: specKindSchema, custom_kind: nonBlankSchema.optional(),
  mode: specModeSchema, authoring_order: z.enum(["requirements-first", "architecture-first"]),
  required_roles: z.array(behavioralRoleSchema).min(1).refine(unique),
  bundle: builtinBundleReferenceSchema.optional(),
  spec_kind: behavioralAssetPinSchema.refine((p) => p.role === "spec-kind-profile").optional(),
  mode_profile: behavioralAssetPinSchema.refine((p) => p.role === "mode-profile").optional(),
  spec: plainSelections, task: taskBehavioralSelectionsSchema,
}).refine((r) => (r.kind === "custom") === (r.custom_kind !== undefined) && (r.mode === "quick" || r.mode === r.authoring_order), "invalid-profile-request-kind-or-mode");
export type BehavioralResolutionRequest = DeepReadonly<z.infer<typeof behavioralResolutionRequestSchema>>;

/** Exact in-memory resolution only. No default is consulted after this result is pinned.
 * Kind specializes mode; neither may alter the authoritative lifecycle. Capability
 * layers are all retained and MUST be composed with the existing deny-wins compiler.
 */
export function resolveBehavioralProfiles(request: BehavioralResolutionRequest, catalog: BehavioralAssetCatalog,
  environment: AssetCompatibilityEnvironment): DomainResult<BehavioralResolution> {
  if (!behavioralResolutionRequestSchema.safeParse(request).success || !behavioralAssetCatalogSchema.safeParse(catalog).success ||
    !assetCompatibilityEnvironmentSchema.safeParse(environment).success) return { ok: false, issues: [{ code: "invalid-behavioral-resolution-input" }] };
  const issues: DomainIssue[] = [];
  const bundle = request.bundle ? catalog.bundles.find((b) => exact(b.manifest.identity, request.bundle)) : undefined;
  if (request.bundle && !bundle) issues.push({ code: "pinned-bundle-unavailable" });
  if (bundle) {
    if (bundle.verified_content_hash !== bundle.manifest.identity.hash) issues.push({ code: "pinned-bundle-hash-mismatch" });
  }
  const kindDefault = bundle?.manifest.spec_kinds.find((k) => k.kind === request.kind && k.custom_kind === request.custom_kind);
  const modeDefault = bundle?.manifest.modes.find((m) => m.mode === request.mode);
  const kindPin: BehavioralAssetPin | undefined = request.spec_kind ?? (kindDefault && { role: "spec-kind-profile", asset: kindDefault.asset, bundle: bundle!.manifest.identity });
  const modePin: BehavioralAssetPin | undefined = request.mode_profile ?? (modeDefault && { role: "mode-profile", asset: modeDefault.asset, bundle: bundle!.manifest.identity });
  const kindConfiguration = kindPin && catalog.assets.find((a) => exact(a.revision.identity, kindPin.asset))?.configuration;
  const modeConfiguration = modePin && catalog.assets.find((a) => exact(a.revision.identity, modePin.asset))?.configuration;
  const kind = kindConfiguration?.schema === "aira.dev/spec-kind-profile/v2" ? kindConfiguration : undefined;
  const mode = modeConfiguration?.schema === "aira.dev/mode-profile/v2" ? modeConfiguration : undefined;
  if (kindPin && (!kind || kind.kind !== request.kind || kind.custom_kind !== request.custom_kind)) issues.push({ code: "spec-kind-profile-mismatch" });
  if (modePin && (!mode || mode.mode !== request.mode || mode.authoring_order !== request.authoring_order)) issues.push({ code: "mode-profile-lifecycle-mismatch" });
  const layers = [
    { source: "bundle" as const, pins: bundle?.manifest.defaults.map((p) => ({ ...p, bundle: bundle.manifest.identity })) ?? [] },
    { source: "mode" as const, pins: mode?.selections ?? [] },
    { source: "spec-kind" as const, pins: kind?.selections ?? [] },
    { source: "spec" as const, pins: request.spec }, { source: "task" as const, pins: request.task },
  ];
  const roles = [...new Set<BehavioralRole>([...request.required_roles, ...(kind?.required_roles ?? []),
    ...(kindPin ? ["spec-kind-profile" as const] : []), ...(modePin ? ["mode-profile" as const] : [])])].sort();
  const decisions: z.infer<typeof behavioralResolutionDecisionSchema>[] = [];
  for (const role of roles) {
    const profilePin = role === "spec-kind-profile" ? kindPin : role === "mode-profile" ? modePin : undefined;
    const candidates = profilePin ? [{ source: (role === "spec-kind-profile" ? request.spec_kind : request.mode_profile) ? "spec" as const : "bundle" as const, pin: profilePin }] :
      layers.flatMap((layer) => layer.pins.filter((p) => p.role === role).map((pin) => ({ source: layer.source, pin })));
    if (!candidates.length) { issues.push({ code: "required-behavioral-role-unresolved", subject: role }); continue; }
    const effective = role === "capability-profile" ? distinctCapabilityPins(candidates.map((c) => c.pin)) : [candidates.at(-1)!.pin];
    const decision = behavioralResolutionDecisionSchema.safeParse({ role, strategy: role === "capability-profile" ? "restrict-all" : "replace", candidates, effective });
    if (!decision.success) issues.push({ code: "conflicting-behavioral-selection", subject: role });
    else decisions.push(decision.data);
  }
  // Validate even shadowed exact candidates: a broken explicit selection never falls
  // back silently. Active compatibility is rechecked without shadowed interfaces.
  const offered = decisions.flatMap((d) => d.candidates.map((c) => c.pin));
  const effective = decisions.flatMap((d) => d.effective);
  issues.push(...validatePinnedAssets(offered, catalog, environment), ...validatePinnedAssets(effective, catalog, environment));
  if (bundle) issues.push(...evaluateAssetCompatibility(bundle.manifest.compatibility, environment,
    effective.flatMap((p) => catalog.assets.find((a) => assetKey(a.revision.identity) === assetKey(p.asset))?.revision.compatibility.provided_interfaces ?? [])));
  if (issues.length) return { ok: false, issues: stableIssues(issues) };
  const resolution = behavioralResolutionSchema.safeParse({ schema: "aira.dev/behavioral-resolution/v2", kind: request.kind,
    ...(request.custom_kind === undefined ? {} : { custom_kind: request.custom_kind }), mode: request.mode, authoring_order: request.authoring_order,
    required_roles: roles, decisions });
  return resolution.success ? { ok: true, value: resolution.data } : { ok: false, issues: [{ code: "invalid-behavioral-resolution" }] };
}
