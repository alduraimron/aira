import { expect, test } from "bun:test";
import { authoringBehavioralPhaseSchema, behavioralRoleSchema, planningBehavioralRoles } from "../../src/builtins/roles";
import { modeProfileSchema, specKindProfileSchema } from "../../src/builtins/profiles";
import { behavioralResolutionRequestSchema, resolveBehavioralProfiles, effectiveBehavioralPins } from "../../src/builtins/resolution";
import { validateImmutableAssetRevision } from "../../src/builtins/assets";
import { library, pin, available, revision } from "../domain-v2/builtins/fixtures";
import { hash } from "../domain-v2/fixtures";

test.each([...planningBehavioralRoles])("canonical behavioral phase %s selects a correctly typed exact asset", (role) => {
  expect(behavioralRoleSchema.safeParse(role).success).toBe(true);
  expect(authoringBehavioralPhaseSchema.safeParse(role).success).toBe(true);
  const p = pin(role); expect(p.asset.kind).toBe(role.endsWith("-analysis") ? "analysis-profile" : "prompt-profile");
  const old = revision(p), next = { ...old, identity: { ...old.identity, hash: hash(998) } };
  expect(validateImmutableAssetRevision(old, next).length).toBeGreaterThan(0);
});
test("old design roles and old mode schema are rejected, not reinterpreted", () => {
  expect(behavioralRoleSchema.safeParse("design-generation").success).toBe(false);
  expect(behavioralRoleSchema.safeParse("design-analysis").success).toBe(false);
  const mode = library().modes[0]!;
  expect(modeProfileSchema.safeParse({ ...mode, mode: "design-first" }).success).toBe(false);
  expect(modeProfileSchema.safeParse({ ...mode, schema: "aira.dev/mode-profile/v1" }).success).toBe(false);
});
for (const kind of ["feature", "bugfix", "refactor", "migration"] as const) for (const mode of ["requirements-first", "architecture-first", "quick"] as const) {
  test(`${kind}/${mode} can differentiate every planning phase through exact kind/mode selections`, () => {
    const lib = library(), base = lib.kinds.find((k) => k.kind === kind)!;
    const selections = planningBehavioralRoles.map((role) => pin(role, "1", `planning.${kind}.${role}`));
    const configured = specKindProfileSchema.parse({ ...base, selections, required_roles: [...planningBehavioralRoles] });
    const modeBase = lib.modes.find((m) => m.mode === mode)!;
    const modeSelections = planningBehavioralRoles.map((role) => pin(role, "1", `planning.${mode}.${role}`));
    const modeConfigured = modeProfileSchema.parse({ ...modeBase, selections: modeSelections });
    const catalog = { assets: [...lib.catalog.assets.filter((a) => a.revision.identity.id !== base.asset.id && a.revision.identity.id !== modeBase.asset.id),
      ...selections.map((p) => available(p)), ...modeSelections.map((p) => available(p)),
      available({ role: "spec-kind-profile", asset: base.asset }, configured), available({ role: "mode-profile", asset: modeBase.asset }, modeConfigured)], bundles: [] };
    const request = behavioralResolutionRequestSchema.parse({ schema: "aira.dev/behavioral-resolution-request/v2", kind, mode, authoring_order: modeConfigured.authoring_order,
      required_roles: [...planningBehavioralRoles], spec_kind: { role: "spec-kind-profile", asset: base.asset }, mode_profile: { role: "mode-profile", asset: modeBase.asset }, spec: [], task: [] });
    const result = resolveBehavioralProfiles(request, catalog, lib.environment);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pins = effectiveBehavioralPins(result.value);
    for (const selection of selections) expect(pins).toContainEqual(selection);
    expect(pins.filter((p) => planningBehavioralRoles.some((r) => r === p.role))).toHaveLength(12);
    expect(modeConfigured.approval_presentation).toBe(mode === "quick" ? "integrated" : "per-artifact");
  });
}
