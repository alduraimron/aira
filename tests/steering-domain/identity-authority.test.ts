import { describe, expect, test } from "bun:test";
import {
  standardSteeringResourceKinds,
  steeringCustomCategorySchema,
  steeringEnforcementBindingSchema,
  steeringResourceIdSchema,
  steeringResourceRevisionSchema,
  steeringRevisionIdSchema,
  steeringRuleIdSchema,
  steeringRuleSchema,
  steeringSnapshotIdSchema,
  validateSteeringAuthority,
  validateSteeringEnforcementBindings,
  validateSteeringKind,
} from "../../src/steering";
import { capabilityBinding, hash, ordered, policy, profile, resource, rule, verifier, verifierBinding } from "./fixtures";

describe("INV-STEER-001: logical Steering identities", () => {
  test.each([
    "steering.product",
    "steering.architecture",
    "project.steering.api-conventions",
    "project.steering.database.postgresql",
    "template.steering.security",
    "interop.steering.agents-md",
    "imported.steering.company-standards",
  ])("accepts logical resource ID %s", (id) => {
    expect(String(steeringResourceIdSchema.parse(id))).toBe(id);
  });

  test.each([
    ".aira/steering/architecture.md",
    "architecture.md",
    "/steering/product",
    "steering/product",
    "steering..product",
    "steering.Product",
    "steering.product ",
    "project.steering",
    "steering.-security",
    "steering.security-",
  ])("rejects path-like or malformed resource ID %s", (id) => {
    expect(steeringResourceIdSchema.safeParse(id).success).toBe(false);
  });

  test.each(["1", "2", "18446744073709551615"])("accepts immutable revision component %s", (revision) => {
    expect(String(steeringRevisionIdSchema.parse(revision))).toBe(revision);
  });

  test.each(["latest", "current", "0", "01", "1.0", "v1", "18446744073709551616", 1])("rejects mutable or malformed revision %s", (revision) => {
    expect(steeringRevisionIdSchema.safeParse(revision).success).toBe(false);
  });

  test("rule and future snapshot IDs are separately validated", () => {
    expect(String(steeringRuleIdSchema.parse("rule.security.no-secret-read"))).toBe("rule.security.no-secret-read");
    expect(String(steeringSnapshotIdSchema.parse("steering_snapshot_spec1-task1"))).toBe("steering_snapshot_spec1-task1");
    for (const value of ["ARCH-3", "rule/architecture/x", "rule.Arch", "rule..x"])
      expect(steeringRuleIdSchema.safeParse(value).success).toBe(false);
    for (const value of ["snapshot_current", "steering_snapshot_latest!", ".aira/steering/snapshot"])
      expect(steeringSnapshotIdSchema.safeParse(value).success).toBe(false);
  });

  test("identity remains unchanged when a future materialization path changes", () => {
    const revision = resource();
    const firstPath = ".aira/steering/architecture.md";
    const secondPath = "config/project-architecture.md";
    expect(firstPath).not.toBe(secondPath);
    expect(String(revision.identity.id)).toBe("steering.architecture");
    expect("path" in revision.identity).toBe(false);
  });
});

describe("Steering resource kinds and custom categories", () => {
  test.each([...standardSteeringResourceKinds])("supports standard %s kind", (kind) => {
    const candidate = resource({
      identity: { id: steeringResourceIdSchema.parse(`steering.${kind}`), revision: steeringRevisionIdSchema.parse("1"), hash: hash() },
      kind,
      metadata: { title: `${kind} Steering`, labels: [] },
      rules: [],
    });
    expect(candidate.kind).toBe(kind);
    expect(validateSteeringKind(kind)).toEqual([]);
  });

  test("custom purpose needs a validated custom category", () => {
    const custom = resource({
      identity: { id: steeringResourceIdSchema.parse("project.steering.api-conventions"), revision: steeringRevisionIdSchema.parse("1"), hash: hash() },
      kind: "custom",
      custom_kind: steeringCustomCategorySchema.parse("api-conventions.rest"),
      rules: [],
    });
    expect(String(custom.custom_kind)).toBe("api-conventions.rest");
    expect(validateSteeringKind("custom", "api-conventions.rest")).toEqual([]);
  });

  test("rejects missing, extra, and malformed custom categories", () => {
    const base = resource();
    expect(steeringResourceRevisionSchema.safeParse({ ...base, kind: "custom" }).success).toBe(false);
    expect(steeringResourceRevisionSchema.safeParse({ ...base, custom_kind: "api" }).success).toBe(false);
    expect(steeringResourceRevisionSchema.safeParse({ ...base, kind: "custom", custom_kind: "API conventions" }).success).toBe(false);
    expect(validateSteeringKind("custom").map((issue) => issue.code)).toEqual(["invalid-steering-custom-kind"]);
    expect(validateSteeringKind("custom", "bad/category").map((issue) => issue.code)).toContain("invalid-steering-custom-category");
    expect(validateSteeringKind("other").map((issue) => issue.code)).toEqual(["invalid-steering-resource-kind"]);
  });

  test("canonical standard logical IDs cannot claim a different purpose", () => {
    const base = resource();
    expect(steeringResourceRevisionSchema.safeParse({ ...base, kind: "security" }).success).toBe(false);
  });
});

describe("INV-STEER-003/004: authority is explicit and enforcement is real linkage", () => {
  test("descriptive rule is structured and has no enforcement", () => {
    const parsed = rule({
      authority: "descriptive",
      semantics: { key: rule().semantics.key, effect: "describe", value: "PostgreSQL" },
      override_policy: "explicit-replacement",
      enforcement: [],
    });
    expect(parsed.authority).toBe("descriptive");
    expect(validateSteeringAuthority(parsed.authority, parsed.enforcement)).toEqual([]);
  });

  test("normative rule is valid without a machine binding", () => {
    const parsed = rule();
    expect(parsed.authority).toBe("normative");
    expect(validateSteeringAuthority(parsed.authority, parsed.enforcement)).toEqual([]);
  });

  test("normative rule may cite an advisory verifier without claiming enforcement", () => {
    const parsed = rule({ enforcement: [verifierBinding("advisory")] });
    expect(parsed.enforcement[0]!.kind).toBe("verifier");
  });

  test("enforceable rule accepts a capability policy or required verifier", () => {
    for (const enforcement of [[capabilityBinding()], [verifierBinding("required")]]) {
      const parsed = rule({ authority: "enforceable", override_policy: "sealed", enforcement });
      expect(parsed.authority).toBe("enforceable");
      expect(validateSteeringAuthority(parsed.authority, parsed.enforcement)).toEqual([]);
    }
  });

  test("enforceable resource default has the same strict linkage rule", () => {
    const parsed = resource({
      default_authority: "enforceable",
      default_override_policy: "sealed",
      default_enforcement: [capabilityBinding()],
    });
    expect(parsed.default_authority).toBe("enforceable");
  });

  test("empty or prose-only enforceability fails closed", () => {
    const base = rule();
    const empty = { ...base, authority: "enforceable", override_policy: "sealed", enforcement: [] };
    const fake = { ...base, authority: "enforceable", override_policy: "sealed", enforcement: ["the AI should follow this"] };
    expect(steeringRuleSchema.safeParse(empty).success).toBe(false);
    expect(steeringRuleSchema.safeParse(fake).success).toBe(false);
    expect(validateSteeringAuthority("enforceable", []).map((issue) => issue.code))
      .toEqual(["enforceable-steering-binding-required"]);
  });

  test("descriptive bindings and normative hard bindings are rejected", () => {
    const descriptive = { ...rule(), authority: "descriptive", semantics: { ...rule().semantics, effect: "describe" }, enforcement: [verifierBinding("advisory")] };
    const normative = { ...rule(), enforcement: [verifierBinding("required")] };
    expect(steeringRuleSchema.safeParse(descriptive).success).toBe(false);
    expect(steeringRuleSchema.safeParse(normative).success).toBe(false);
    expect(validateSteeringAuthority("descriptive", descriptive.enforcement).map((issue) => issue.code))
      .toContain("descriptive-steering-enforcement-forbidden");
    expect(validateSteeringAuthority("normative", normative.enforcement).map((issue) => issue.code))
      .toContain("normative-steering-binding-must-be-advisory");
  });

  test("authority constrains semantic effect and enforceable replacement policy", () => {
    expect(steeringRuleSchema.safeParse({ ...rule(), authority: "descriptive" }).success).toBe(false);
    expect(steeringRuleSchema.safeParse({ ...rule(), authority: "enforceable", enforcement: [capabilityBinding()], override_policy: "explicit-replacement" }).success).toBe(false);
  });
});

describe("typed enforcement bindings", () => {
  test("supports capability policy, verifier, repository check, and versioned extension", () => {
    const bindings = [
      capabilityBinding(),
      verifierBinding("required"),
      { kind: "repository-check", check: "architecture-boundary", verifier: verifier(), use: "required" },
      { kind: "extension", contract: "example.dev/steering-check/v1", mechanism: profile(), use: "required" },
    ];
    for (const binding of bindings) expect(steeringEnforcementBindingSchema.safeParse(binding).success).toBe(true);
  });

  test("reuses and validates Policy, Verifier, and Profile identities", () => {
    expect(steeringEnforcementBindingSchema.safeParse({ kind: "capability-policy", policy: { ...policy(), id: "profile_wrong" } }).success).toBe(false);
    expect(steeringEnforcementBindingSchema.safeParse({ kind: "verifier", verifier: { ...verifier(), id: "verifier_one" }, use: "required" }).success).toBe(false);
    expect(steeringEnforcementBindingSchema.safeParse({ kind: "extension", contract: "unversioned", mechanism: profile(), use: "required" }).success).toBe(false);
    expect(steeringEnforcementBindingSchema.safeParse({ kind: "ai-promise", text: "obey" }).success).toBe(false);
  });

  test("duplicate and conflicting mechanism identities produce deterministic codes", () => {
    const duplicate = validateSteeringEnforcementBindings([capabilityBinding(), capabilityBinding()]);
    expect(duplicate.map((issue) => issue.code)).toContain("duplicate-steering-enforcement-binding");

    const conflict = ordered([capabilityBinding(1), capabilityBinding(2)]);
    const first = validateSteeringEnforcementBindings(conflict);
    const second = validateSteeringEnforcementBindings([...conflict].reverse());
    expect(first.map((issue) => issue.code)).toContain("conflicting-steering-enforcement-binding-identity");
    expect(second.map((issue) => issue.code)).toContain("conflicting-steering-enforcement-binding-identity");
    expect(first).toEqual([...first].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
  });
});
