import { describe, expect, test } from "bun:test";
import { behavioralResolutionRequestSchema, behavioralResolutionSchema, effectiveBehavioralPins, resolveBehavioralProfiles, type BehavioralResolution } from "../../../src/builtins/resolution";
import { evaluateAssetCompatibility, assetCompatibilitySchema } from "../../../src/builtins/compatibility";
import { behavioralAssetPinSchema } from "../../../src/builtins/roles";
import { specKindProfileSchema, modeProfileSchema } from "../../../src/builtins/profiles";
import { validatePinnedAssets } from "../../../src/builtins/catalog";
import { compileBehavioralCapabilityPolicy } from "../../../src/builtins/policy";
import { capabilityDecision } from "../../../src/capabilities/policy";
import { capabilityPolicySchema } from "../../../src/capabilities/schema";
import { checkLifecycleTransition } from "../../../src/spec/domain/lifecycle";
import { backend, capabilityPolicy } from "../fixtures";
import { available, hash, library, pin, syntheticCompatibility } from "./fixtures";

function resolved(f: ReturnType<typeof library>): BehavioralResolution {
  const result = resolveBehavioralProfiles(f.request, f.catalog, f.environment);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
describe("INV-BUILTIN-002/003: deterministic and inspectable exact resolution", () => {
  test("Spec override wins default and records both exact candidates", () => {
    const f = library(), selected = pin("requirements-generation", "3", "my-prompt", "acme");
    f.request.spec.push(selected); f.catalog.assets.push(available(selected));
    const decision = resolved(f).decisions.find((d) => d.role === selected.role)!;
    expect(decision.effective).toEqual([selected]); expect(decision.candidates.map((c) => c.source)).toEqual(["bundle", "spec"]);
    expect(String(decision.effective[0]!.asset.revision)).toBe("3"); expect(decision.effective[0]!.asset.hash).toBe(selected.asset.hash);
  });
  test("task overrides Spec for permitted execution roles only", () => {
    const f = library(), s = pin("implementation", "2"), t = pin("implementation", "3", "impl", "acme");
    f.request.required_roles = ["implementation"]; f.request.spec = [s]; f.request.task = [t]; f.catalog.assets.push(available(s), available(t));
    const decision = resolved(f).decisions.find((d) => d.role === "implementation")!;
    expect(decision.candidates.map((c) => c.source)).toEqual(["bundle", "spec", "task"]); expect(decision.effective).toEqual([t]);
    expect(behavioralResolutionRequestSchema.safeParse({ ...f.request, task: [pin("requirements-generation")] }).success).toBe(false);
    expect(behavioralResolutionRequestSchema.safeParse({ ...f.request, task: [pin("mode-profile")] }).success).toBe(false);
  });
  test("kind specializes mode, Spec specializes kind; source ordering is explicit", () => {
    const f = library(), mode = f.catalog.assets.find((a) => a.configuration?.schema === "aira.dev/mode-profile/v2" && a.configuration.mode === "requirements-first")!;
    mode.configuration = modeProfileSchema.parse({ ...mode.configuration, selections: [pin("requirements-analysis")] });
    const decision = resolved(f).decisions.find((d) => d.role === "requirements-analysis")!;
    expect(decision.candidates.map((c) => c.source)).toEqual(["bundle", "mode", "spec-kind"]);
    expect(String(decision.effective[0]!.asset.id)).toBe("builtin.test.feature.requirements-analysis");
    const explicit = pin("requirements-analysis", "2"); f.request.spec.push(explicit); f.catalog.assets.push(available(explicit));
    expect(resolved(f).decisions.find((d) => d.role === "requirements-analysis")!.effective).toEqual([explicit]);
  });
  test("enumeration ordering does not select a different revision or decision", () => {
    const f = library(), before = JSON.stringify(f), a = resolved(f);
    expect(JSON.stringify(f)).toBe(before);
    f.catalog.assets.reverse(); f.catalog.bundles.reverse(); f.catalog.bundles[0]!.manifest.defaults.reverse(); f.request.required_roles.reverse();
    expect(resolved(f)).toEqual(a);
  });
  test("required role cannot fall back to some unrelated profile", () => {
    const f = library(); f.request.bundle = undefined;
    const result = resolveBehavioralProfiles(f.request, f.catalog, f.environment);
    expect(result.ok).toBe(false); if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("required-behavioral-role-unresolved");
  });
  test("broken explicit exact selection never silently falls back", () => {
    const f = library(); f.request.spec = [pin("requirements-generation", "99")];
    const result = resolveBehavioralProfiles(f.request, f.catalog, f.environment);
    expect(result.ok).toBe(false); if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("pinned-asset-unavailable");
  });
  test("explicit profile selector can choose a project kind profile without impersonation", () => {
    const f = library(), p = pin("spec-kind-profile", "2", "my-feature", "acme");
    const kind = specKindProfileSchema.parse({ ...f.kinds[0]!, asset: p.asset });
    f.catalog.assets.push(available(p, kind)); f.request.spec_kind = p;
    expect(resolved(f).decisions.find((d) => d.role === "spec-kind-profile")!.effective).toEqual([p]);
  });
  test("profile selection rejects a missing body, mismatched kind, and unknown request version", () => {
    const f = library(); f.request.spec_kind = { role: "spec-kind-profile", asset: f.kinds[1]!.asset };
    expect(resolveBehavioralProfiles(f.request, f.catalog, f.environment).ok).toBe(false);
    const asset = f.catalog.assets.find((a) => a.configuration?.schema === "aira.dev/spec-kind-profile/v2")!;
    delete asset.configuration;
    expect(resolveBehavioralProfiles(f.request, f.catalog, f.environment).ok).toBe(false);
    expect(behavioralResolutionRequestSchema.safeParse({ ...f.request, schema: "aira.dev/behavioral-resolution-request/v99" }).success).toBe(false);
  });
  test("later defaults do not mutate detached resolution pins or invalidate installed old assets", () => {
    const f = library(), result = resolved(f), old = JSON.stringify(result), newer = pin("requirements-generation", "2");
    f.catalog.assets.push(available(newer));
    const nextBundle = structuredClone(f.catalog.bundles[0]!);
    nextBundle.manifest.identity = { ...nextBundle.manifest.identity, revision: "2" as typeof nextBundle.manifest.identity.revision, hash: hash(501) };
    nextBundle.verified_content_hash = hash(501); nextBundle.manifest.assets.push(newer.asset);
    nextBundle.manifest.defaults = nextBundle.manifest.defaults.map((p) => p.role === newer.role ? newer : p);
    f.catalog.bundles.push(nextBundle); f.request.bundle = nextBundle.manifest.identity;
    expect(String(resolved(f).decisions.find((d) => d.role === newer.role)!.effective[0]!.asset.revision)).toBe("2");
    expect(JSON.stringify(result)).toBe(old); expect(validatePinnedAssets(effectiveBehavioralPins(result), f.catalog, f.environment)).toEqual([]);
  });
  test("forged persisted decisions cannot change precedence, drop required roles or grant lifecycle flags", () => {
    const result = resolved(library()), d = result.decisions.find((d) => d.role === "requirements-analysis")!;
    for (const decision of [{ ...d, effective: [d.candidates[0]!.pin] }, { ...d, candidates: [...d.candidates].reverse() }, { ...d, candidates: [] }])
      expect(behavioralResolutionSchema.safeParse({ ...result, decisions: result.decisions.map((item) => item.role === d.role ? decision : item) }).success).toBe(false);
    expect(behavioralResolutionSchema.safeParse({ ...result, decisions: [] }).success).toBe(false);
    expect(behavioralResolutionSchema.safeParse({ ...result, skip_approval: true }).success).toBe(false);
  });
});

describe("INV-BUILTIN-005: meaningful kind and lifecycle-constrained mode contracts", () => {
  test.each(["feature", "bugfix", "refactor", "migration", "custom"] as const)("%s selects a differentiated exact analysis", (kind) => {
    const f = library(); f.request.kind = kind; if (kind === "custom") f.request.custom_kind = "audit";
    const result = resolved(f);
    expect(String(result.decisions.find((d) => d.role === "requirements-analysis")!.effective[0]!.asset.id)).toBe(`builtin.test.${kind}.requirements-analysis`);
    expect(String(result.decisions.find((d) => d.role === "spec-kind-profile")!.effective[0]!.asset.id)).toBe(`builtin.test.spec.${kind}`);
  });
  test("a kind cannot be an empty cosmetic label or a recursive profile graph", () => {
    const k = library().kinds[0]!;
    expect(specKindProfileSchema.safeParse({ ...k, selections: [] }).success).toBe(false);
    expect(specKindProfileSchema.safeParse({ ...k, selections: [pin("spec-kind-profile")], required_roles: ["spec-kind-profile"] }).success).toBe(false);
    expect(specKindProfileSchema.safeParse({ ...k, kind: "custom" }).success).toBe(false);
    expect(specKindProfileSchema.safeParse({ ...k, required_roles: ["implementation"] }).success).toBe(false);
  });
  test.each(["requirements-first", "architecture-first", "quick"] as const)("%s uses explicit safe configuration", (mode) => {
    const f = library(); f.request.mode = mode; f.request.authoring_order = mode === "architecture-first" ? "architecture-first" : "requirements-first";
    expect(resolved(f).mode).toBe(mode);
    const m = f.modes.find((m) => m.mode === mode)!;
    expect(modeProfileSchema.parse(m)).toEqual(m);
    expect(checkLifecycleTransition(mode, { state: "draft" }, { state: "ready" }, m.authoring_order).ok).toBe(false);
  });
  test("quick supports either authoring order but never removes canonical analyses or final human approval", () => {
    const m = library().modes.find((m) => m.mode === "quick")!;
    expect(modeProfileSchema.safeParse({ ...m, authoring_order: "architecture-first" }).success).toBe(true);
    for (const extra of [{ approval_presentation: "none" }, { approval_presentation: "per-artifact" }, { review_presentation: "skip" }, { skip_analysis: true }, { lifecycle: "ready" }])
      expect(modeProfileSchema.safeParse({ ...m, ...extra }).success).toBe(false);
  });
  test("mode/order mismatch cannot reinterpret an already selected Spec mode", () => {
    const f = library(); f.request.mode_profile = { role: "mode-profile", asset: f.modes.find((m) => m.mode === "architecture-first")!.asset };
    expect(resolveBehavioralProfiles(f.request, f.catalog, f.environment).ok).toBe(false);
    expect(modeProfileSchema.safeParse({ ...f.modes[0]!, authoring_order: "architecture-first" }).success).toBe(false);
  });
});

describe("INV-CAP-002/BUILTIN-003: restriction-only behavioral capability selections", () => {
  test("child grant retains all parent layers and cannot widen access", () => {
    const f = library(), parent = capabilityPolicy(), child = capabilityPolicySchema.parse({ ...capabilityPolicy(), identity: { id: "policy_child", revision: "rev_child", hash: hash(702) },
      protected_paths: [], filesystem: { ...parent.filesystem, read: { allow: [{ kind: "tree", path: "src" }], deny: [] } } });
    const parentPin = behavioralAssetPinSchema.parse({ ...pin("capability-profile"), asset: { ...pin("capability-profile").asset, policy: parent.identity } });
    const childPin = behavioralAssetPinSchema.parse({ ...pin("capability-profile", "1", "child", "acme"), asset: { ...pin("capability-profile", "1", "child", "acme").asset, policy: child.identity } });
    // No bundle needed for an explicit exact-input resolution.
    f.request.bundle = undefined; f.request.required_roles = ["capability-profile"]; f.request.spec = [parentPin]; f.request.task = [childPin];
    f.catalog = { bundles: [], assets: [available(parentPin), available(childPin)] };
    const resolution = resolved(f), decision = resolution.decisions[0]!;
    expect(decision.strategy).toBe("restrict-all"); expect(decision.effective).toHaveLength(2);
    const compiled = compileBehavioralCapabilityPolicy(resolution, [parent, child], backend());
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(capabilityDecision(compiled.value.effective, { kind: "filesystem", action: "read", logical_path: "src/secrets/key" })).toBe("deny");
    expect(compileBehavioralCapabilityPolicy(resolution, [child], backend()).ok).toBe(false);
    expect(compileBehavioralCapabilityPolicy(resolution, [parent, child], backend(false)).ok).toBe(false);
    expect(behavioralResolutionSchema.safeParse({ ...resolution, decisions: [{ ...decision, effective: [childPin] }] }).success).toBe(false);
  });
  test("the same restriction selected directly and via a bundle is idempotent, with both origins inspectable", () => {
    const f = library(); f.request.required_roles = ["capability-profile"]; f.request.spec = [pin("capability-profile")];
    const decision = resolved(f).decisions.find((d) => d.role === "capability-profile")!;
    expect(decision.candidates).toHaveLength(2); expect(decision.effective).toHaveLength(1);
  });
});

describe("structured compatibility, no dependency solver or guessed guarantees", () => {
  test("compatible revision accepts known schemas, runtime abilities, exact backend and interfaces", () => {
    const f = library(), b = backend();
    const c = assetCompatibilitySchema.parse({ ...syntheticCompatibility, required_schemas: ["aira.dev/tasks/v2"], runtime_capabilities: ["structured-output"],
      backend_capabilities: ["process_confinement"], backend_implementations: [b.identity], required_interfaces: ["aira.dev/prompt-interface/v1"] });
    expect(evaluateAssetCompatibility(c, { ...f.environment, supported_schemas: ["aira.dev/tasks/v2"], runtime_capabilities: ["structured-output"], backend: b }, ["aira.dev/prompt-interface/v1"])).toEqual([]);
  });
  test.each(["domain_schemas", "required_schemas", "runtime_capabilities", "backend_capabilities", "backend_implementations", "required_interfaces"])("missing/incompatible %s fails closed", (field) => {
    const f = library();
    const values = { domain_schemas: ["aira.dev/spec/v99"], required_schemas: ["aira.dev/tasks/v99"], runtime_capabilities: ["structured-output"],
      backend_capabilities: ["process_confinement"], backend_implementations: [backend().identity], required_interfaces: ["aira.dev/missing-interface/v1"] };
    const c = assetCompatibilitySchema.parse({ ...syntheticCompatibility, [field]: values[field as keyof typeof values] });
    expect(evaluateAssetCompatibility(c, f.environment).length).toBeGreaterThan(0);
    f.catalog.assets.find((a) => a.revision.identity.id === "builtin.test.requirements-generation")!.revision.compatibility = c;
    expect(resolveBehavioralProfiles(f.request, f.catalog, f.environment).ok).toBe(false);
  });
  test("interfaces from unselected catalog assets cannot satisfy active pins", () => {
    const f = library(), consumer = f.catalog.assets.find((a) => a.revision.identity.id === "builtin.test.requirements-generation")!;
    consumer.revision.compatibility.required_interfaces = ["aira.dev/analysis-interface/v1"];
    const unused = f.catalog.assets.find((a) => a.revision.identity.id === "builtin.test.bugfix.requirements-analysis")!;
    unused.revision.compatibility.provided_interfaces = ["aira.dev/analysis-interface/v1"];
    expect(resolveBehavioralProfiles(f.request, f.catalog, f.environment).ok).toBe(false);
    const active = f.catalog.assets.find((a) => a.revision.identity.id === "builtin.test.feature.requirements-analysis")!;
    active.revision.compatibility.provided_interfaces = ["aira.dev/analysis-interface/v1"];
    expect(resolveBehavioralProfiles(f.request, f.catalog, f.environment).ok).toBe(true);
  });
  test("backend identity and capability booleans both matter", () => {
    const f = library(), c = assetCompatibilitySchema.parse({ ...syntheticCompatibility, backend_capabilities: ["force_termination"], backend_implementations: [backend().identity] });
    expect(evaluateAssetCompatibility(c, { ...f.environment, backend: backend(false) }).length).toBeGreaterThan(0);
    expect(evaluateAssetCompatibility(c, { ...f.environment, backend: { ...backend(), identity: { ...backend().identity, configuration_hash: hash(1) } } }).map((i) => i.code)).toContain("asset-backend-incompatible");
    expect(assetCompatibilitySchema.safeParse({ ...c, runtime_capabilities: ["arbitrary-plugin"] }).success).toBe(false);
  });
});
