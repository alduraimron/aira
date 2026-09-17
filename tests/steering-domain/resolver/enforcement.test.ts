import { describe, expect, test } from "bun:test";
import { capabilityDecision, composeCapabilityPolicies } from "../../../src/capabilities/policy";
import { capabilityPolicySchema } from "../../../src/capabilities/schema";
import { canonicalSteeringSelectors, resolveSteering, type SteeringEnforcementBinding, type SteeringRule } from "../../../src/steering";
import { capabilityPolicy } from "../../domain-v2/fixtures";
import { profile, verifierBinding } from "../fixtures";
import { hash, namedRule, override, policyBinding, request, revision, scoped, tree } from "./fixtures";

const enforced = (name: string, enforcement: readonly SteeringEnforcementBinding[], overrides: Partial<SteeringRule> = {}) =>
  namedRule(name, "protected", { authority: "enforceable", enforcement: canonicalSteeringSelectors(enforcement), ...overrides });
const codes = (input: unknown) => resolveSteering(input).diagnostics.map((issue) => issue.code);
describe("05C-2 enforcement and non-weakening", () => {
  test("recognized capability/verifier/check/extension bindings all survive resolution", () => {
    const verifier = verifierBinding();
    if (verifier.kind !== "verifier") throw new Error("fixture");
    const bindings = canonicalSteeringSelectors([
      policyBinding("one"), verifier, { kind: "repository-check", check: "architecture-boundary", verifier: verifier.verifier, use: "required" },
      { kind: "extension", contract: "aira.dev/check-extension/v1", mechanism: profile(), use: "required" },
    ] as SteeringEnforcementBinding[]);
    const root = revision("root", { rules: [enforced("root", bindings)] });
    const result = resolveSteering(request([root], { supported_contracts: ["aira.dev/check-extension/v1"] }));
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.effective_rules[0]!.enforcement).toEqual(bindings);
    expect(canonicalSteeringSelectors(result.enforcement.map((entry) => entry.binding))).toEqual(bindings);
    expect(result.enforcement.map((entry) => entry.binding.kind)).toEqual(["capability-policy", "extension", "repository-check", "verifier"]);
    expect(result.enforcement.every((entry) => entry.sources[0]!.resource.id === root.identity.id)).toBe(true);
  });
  test("compatible equivalent enforceable rules union bindings and source provenance", () => {
    const a = revision("a", { rules: [enforced("a", [policyBinding("one")])] });
    const b = revision("b", { rules: [enforced("b", [policyBinding("two"), verifierBinding()])] });
    const result = resolveSteering(request([a, b]));
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.effective_rules).toHaveLength(1); expect(result.effective_rules[0]!.contributors).toHaveLength(2);
    expect(result.effective_rules[0]!.enforcement).toHaveLength(3); expect(result.enforcement).toHaveLength(3);
  });
  test("explicit strengthening retains all required bindings and composes, not replaces", () => {
    const p1 = policyBinding("one"), p2 = policyBinding("two"), v = verifierBinding();
    const root = revision("root", { rules: [enforced("root", [p1, v])] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [enforced("child", [p1, p2, v])], composition: override(root, "strengthen") });
    const result = resolveSteering(request([root, child]));
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.overrides[0]!.disposition).toBe("compose"); expect(result.shadowed_rules).toHaveLength(0);
    expect(result.enforcement).toHaveLength(3); expect(result.effective_rules[0]!.contributors).toHaveLength(2);
  });
  test("cumulative forbids strengthen without removing the upstream prohibition", () => {
    const p = policyBinding("one"), base = enforced("root", [p]);
    const rootRule = { ...base, semantics: { ...base.semantics, effect: "forbid" as const, value: "network" } };
    const root = revision("root", { rules: [rootRule] });
    const childRule = enforced("child", [p], { semantics: { ...rootRule.semantics, value: "shell" } });
    const child = scoped(root, "child", tree("src/auth"), { rules: [childRule], composition: override(root, "strengthen") });
    const result = resolveSteering(request([root, child]));
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") { expect(result.effective_rules).toHaveLength(2); expect(result.shadowed_rules).toHaveLength(0); }
  });
  test("required verifier cannot be removed even when the capability policy remains", () => {
    const p = policyBinding("one"), root = revision("root", { rules: [enforced("root", [p, verifierBinding()])] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [enforced("child", [p])], composition: override(root, "strengthen") });
    expect(codes(request([root, child]))).toContain("steering-enforcement-weakening");
  });
  test("required verifier cannot be changed to advisory", () => {
    const p = policyBinding("one"), root = revision("root", { rules: [enforced("root", [p, verifierBinding()])] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [enforced("child", [p, verifierBinding("advisory")])], composition: override(root, "strengthen") });
    expect(codes(request([root, child]))).toContain("steering-enforcement-weakening");
  });
  test("enforceable-to-normative prose replacement is both an authority and enforcement violation", () => {
    const root = revision("root", { rules: [enforced("root", [policyBinding("one"), verifierBinding()])] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("child", "protected")], composition: override(root, "strengthen") });
    const result = resolveSteering(request([root, child]));
    expect(result.status).toBe("conflicted");
    expect(result.diagnostics.map((issue) => issue.code)).toContain("steering-authority-conflict");
    expect(result.diagnostics.map((issue) => issue.code)).toContain("steering-enforcement-weakening");
  });
  test("capability deny cannot be replaced with lower-level allow, even if the original binding is repeated", () => {
    const p = policyBinding("one"), root = revision("root", { rules: [enforced("root", [p])] });
    const lower = enforced("child", [p], { semantics: { ...root.rules[0]!.semantics, value: "allow-all" } });
    const child = scoped(root, "child", tree("src/auth"), { rules: [lower], composition: override(root, "strengthen") });
    expect(codes(request([root, child]))).toContain("steering-enforcement-weakening");
  });
  test("specialization is not a backdoor around enforceable-only strengthening", () => {
    const p = policyBinding("one"), root = revision("root", { rules: [enforced("root", [p])] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [enforced("child", [p])], composition: override(root, "specialize") });
    expect(codes(request([root, child]))).toContain("steering-enforcement-weakening");
  });
  test("upstream default required bindings are retained independently of structured rule selection", () => {
    const p = policyBinding("one"), root = revision("root", { default_authority: "enforceable", default_enforcement: [p], rules: [enforced("root", [p])] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [] });
    const result = resolveSteering(request([root, child]));
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.enforcement[0]!.sources).toHaveLength(2);
  });
  test("absent exact required mechanism observations fail; advisory references remain advisory", () => {
    const root = revision("root", { rules: [enforced("root", [policyBinding("one")])] });
    expect(codes(request([root], { available_enforcement: [] }))).toContain("steering-enforcement-missing");
    const advisory = revision("advisory", { rules: [namedRule("advisory", "service", { enforcement: [verifierBinding("advisory")] })] });
    const result = resolveSteering(request([advisory], { available_enforcement: [] }));
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.effective_rules[0]!.authority).toBe("normative");
  });
  test("conflicting immutable mechanism hashes fail across sources", () => {
    const a = revision("a", { rules: [enforced("a", [verifierBinding("required", 1)])] });
    const b = revision("b", { rules: [enforced("b", [verifierBinding("required", 2)])] });
    expect(codes(request([a, b]))).toContain("steering-enforcement-conflict");
  });
  test("hash conflict cannot hide under repository-check vs verifier binding kinds", () => {
    const v = verifierBinding("required", 2); if (v.kind !== "verifier") throw new Error("fixture");
    const a = revision("a", { rules: [enforced("a", [verifierBinding()])] });
    const b = revision("b", { rules: [enforced("b", [{ kind: "repository-check", check: "architecture-boundary", verifier: v.verifier, use: "required" }])] });
    expect(codes(request([a, b]))).toContain("steering-enforcement-conflict");
  });
  test("a required extension needs an explicitly supported versioned contract", () => {
    const binding = { kind: "extension" as const, contract: "aira.dev/check-extension/v1", mechanism: profile(), use: "required" as const };
    const root = revision("root", { rules: [enforced("root", [binding])] });
    expect(codes(request([root]))).toContain("steering-compatibility-invalid");
    expect(resolveSteering(request([root], { supported_contracts: [binding.contract] })).status).toBe("resolved");
  });
  test("extension contract substitution cannot reuse one exact mechanism revision", () => {
    const binding = { kind: "extension" as const, contract: "aira.dev/check-extension/v1", mechanism: profile(), use: "required" as const };
    const a = revision("a", { rules: [enforced("a", [binding])] });
    const b = revision("b", { rules: [enforced("b", [{ ...binding, contract: "aira.dev/check-extension/v2" }])] });
    expect(codes(request([a, b], { supported_contracts: [binding.contract, "aira.dev/check-extension/v2"] }))).toContain("steering-enforcement-conflict");
  });
  test("optional availability cannot omit a known incompatible enforceable restriction", () => {
    const root = revision("root", { rules: [enforced("root", [policyBinding("one")])],
      inclusion: { availability: "optional", selector: { kind: "always" } },
      compatibility: { resolver: "aira.dev/steering-resolution/v1", required_schemas: ["aira.dev/check/v1"] } });
    const result = resolveSteering(request([root]));
    expect(result.status).toBe("conflicted"); expect(result.diagnostics.find((issue) => issue.code === "steering-compatibility-invalid")!.severity).toBe("error");
  });
  test("enforceable defaults must have structured enforceable linkage", () => {
    const root = revision("root", { default_authority: "enforceable", default_enforcement: [policyBinding("one")], rules: [] });
    expect(codes(request([root]))).toContain("steering-enforcement-weakening");
  });
  test("compatible authority labels remain scoped and do not promote unrelated prose", () => {
    const root = revision("root", { rules: [namedRule("root", "protected")] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [enforced("child", [policyBinding("one")])], composition: override(root, "strengthen") });
    const result = resolveSteering(request([root, child]));
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.effective_rules.map((rule) => rule.authority).sort()).toEqual(["enforceable", "normative"]);
  });
  test("capability layers resolve to the existing deny-wins compiler, including filesystem and network", () => {
    const base = capabilityPolicy();
    const upper = capabilityPolicySchema.parse({ ...base, identity: policyBinding("upper").policy, protected_paths: [{ kind: "tree", path: ".aira" }], network: { mode: "deny" } });
    const lower = capabilityPolicySchema.parse({ ...base, identity: policyBinding("lower").policy, protected_paths: [], filesystem: { ...base.filesystem, write: { allow: [{ kind: "tree", path: ".aira" }], deny: [] } } });
    const a = revision("a", { rules: [enforced("a", [{ kind: "capability-policy", policy: upper.identity }])] });
    const b = revision("b", { rules: [enforced("b", [{ kind: "capability-policy", policy: lower.identity }])] });
    const result = resolveSteering(request([a, b]));
    expect(result.status).toBe("resolved"); if (result.status !== "resolved") return;
    const policies = result.enforcement.map((entry) => entry.binding.kind === "capability-policy" && entry.binding.policy.id === upper.identity.id ? upper : lower);
    expect(policies).toHaveLength(2);
    const effective = composeCapabilityPolicies(policies[0]!, ...policies.slice(1));
    expect(capabilityDecision(effective, { kind: "filesystem", action: "write", logical_path: ".aira/secrets" })).toBe("deny");
    expect(capabilityDecision(effective, { kind: "network", destination: { host: "example.com", port: 443, protocol: "tcp" } })).toBe("deny");
  });
});
