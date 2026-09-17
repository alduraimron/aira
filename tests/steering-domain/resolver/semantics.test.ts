import { describe, expect, test } from "bun:test";
import { resolveSteering, steeringRuleIdSchema, steeringSemanticKeySchema } from "../../../src/steering";
import { fact, namedRule, override, request, revision, scoped, tree } from "./fixtures";

const codes = (input: unknown) => resolveSteering(input).diagnostics.map((issue) => issue.code);
describe("05C-2 semantic identity and scoped precedence", () => {
  test("equivalent facts coalesce and keep both exact source attributions", () => {
    const a = revision("a", { rules: [fact("a", "PostgreSQL")] }), b = revision("b", { rules: [fact("b", "PostgreSQL")] });
    const result = resolveSteering(request([b, a]));
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.effective_rules).toHaveLength(1);
    expect(result.effective_rules[0]!.contributors.map((rule) => rule.resource)).toEqual([a.identity, b.identity]);
    expect(result.effective_rules[0]!.regions).toHaveLength(2);
  });
  test("same-scope contradictory descriptive facts conflict", () => {
    const a = revision("a", { rules: [fact("a", "PostgreSQL")] }), b = revision("b", { rules: [fact("b", "MySQL")] });
    const result = resolveSteering(request([a, b]));
    expect(result.status).toBe("conflicted");
    expect("effective_rules" in result).toBe(false);
    const issue = result.diagnostics.find((issue) => issue.code === "steering-semantic-conflict")!;
    expect(issue.semantic_key).toBe(steeringSemanticKeySchema.parse("topic.database")); expect(issue.rules).toHaveLength(2);
    expect(issue.rules![0]).toMatchObject({ resource: a.identity, authority: "descriptive", override_policy: "explicit-replacement", scope: a.scope });
    expect(codes(request([a, b]))).toContain("steering-conflict-unresolved");
  });
  test("disjoint descriptive facts can govern one multi-path action", () => {
    const a = revision("a", { rules: [fact("a", "PostgreSQL")], scope: tree("src/app") });
    const b = revision("b", { rules: [fact("b", "ClickHouse")], scope: tree("src/analytics") });
    const result = resolveSteering(request([a, b], { action: { phase: "implementation", paths: { status: "known", paths: ["src/app/a.ts", "src/analytics/b.ts"] } } }));
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.effective_rules).toHaveLength(2);
  });
  test("a narrowed descriptive exception still needs explicit precedence", () => {
    const root = revision("root", { rules: [fact("root", "PostgreSQL")] });
    const child = scoped(root, "analytics", tree("src/analytics"), { rules: [fact("analytics", "ClickHouse")] });
    const action = { phase: "implementation" as const, paths: { status: "known" as const, paths: ["src/analytics/a.ts", "src/app/a.ts"] } };
    expect(codes(request([root, child], { action }))).toContain("steering-semantic-conflict");
    const replaced = { ...child, composition: override(root, "replace") };
    const result = resolveSteering(request([root, replaced], { action }));
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    const parentEffective = result.effective_rules.find((rule) => rule.semantics.value === "PostgreSQL")!;
    expect(parentEffective.regions[0]!.excluded_scopes).toEqual([child.scope]);
    expect(result.shadowed_rules[0]).toMatchObject({ coverage: "partial", target: { resource: root.identity, rule: root.rules[0]!.id }, by: { resource: child.identity, rule: child.rules[0]!.id } });
  });
  test("compatible normative constraints coalesce; title and prose never determine identity", () => {
    const a = revision("a", { rules: [namedRule("a", { a: 1, b: 2 })] });
    const b = revision("b", { rules: [namedRule("b", { b: 2, a: 1 }, { title: "A very different title", rationale: "Different prose." })] });
    const result = resolveSteering(request([a, b]));
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.effective_rules[0]!.contributors).toHaveLength(2);
  });
  test("unrelated semantic keys coexist despite identical titles", () => {
    const a = namedRule("a", "service"), b = namedRule("b", "repository", { semantics: { ...a.semantics, key: steeringSemanticKeySchema.parse("topic.other"), value: "repository" } });
    expect(resolveSteering(request([revision("root", { rules: [a, b] })])).status).toBe("resolved");
  });
  test("narrower normative scope is not authorization", () => {
    const root = revision("root", { rules: [namedRule("root")] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("child", "repository")] });
    expect(codes(request([root, child]))).toContain("steering-semantic-conflict");
  });
  test("explicit valid specialization is attributable and retains the source chain", () => {
    const root = revision("root", { rules: [namedRule("root")] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("child", "repository")], composition: override(root) });
    const leaf = scoped(child, "leaf", tree("src/auth/admin"), { rules: [namedRule("leaf", "admin-service")], composition: override(child) });
    const input = request([leaf, root, child], { action: { phase: "implementation", paths: { status: "known", paths: ["src/auth/admin/a.ts"] } } });
    const result = resolveSteering(input);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.overrides).toHaveLength(2); expect(result.shadowed_rules).toHaveLength(2);
    expect(result.overrides.some((decision) => decision.source.rule === leaf.rules[0]!.id && decision.target.rule === child.rules[0]!.id)).toBe(true);
    expect(result.overrides[0]!.declaration.rationale).toBe("Explicit project-control decision");
    expect(result.included_resources.map((entry) => entry.revision.identity)).toEqual([root.identity, child.identity, leaf.identity]);
  });
  test("equal-rule-scope explicit replacement fully supersedes the target", () => {
    const root = revision("root", { rules: [namedRule("root", "service", { scope: tree("src/auth"), override_policy: "explicit-replacement" })] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("child", "repository")], composition: override(root, "replace") });
    const result = resolveSteering(request([root, child]));
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") { expect(result.effective_rules).toHaveLength(1); expect(result.shadowed_rules[0]!.coverage).toBe("full"); }
  });
  test("a partial override cannot conceal a third-party conflict elsewhere", () => {
    const root = revision("root", { rules: [namedRule("root")] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("child", "repository")], composition: override(root) });
    const other = revision("other", { rules: [namedRule("other", "repository")], scope: tree("src/payments") });
    const result = resolveSteering(request([root, child, other], { action: { phase: "implementation", paths: { status: "known", paths: ["src/auth/a.ts", "src/payments/b.ts"] } } }));
    expect(result.status).toBe("conflicted");
    expect(result.diagnostics.some((issue) => issue.code === "steering-semantic-conflict" && issue.rules?.some((rule) => rule.resource.id === other.identity.id))).toBe(true);
  });
  test("a conditional override subtracts only its included path coverage, not the whole resource scope", () => {
    const root = revision("root", { rules: [namedRule("root")] });
    const child = scoped(root, "child", tree("src"), { rules: [namedRule("child", "repository")], composition: override(root),
      inclusion: { availability: "required", selector: { kind: "path", selectors: [{ kind: "tree", path: "src/auth" }] } } });
    const action = { phase: "implementation" as const, paths: { status: "known" as const, paths: ["src/auth/a.ts", "src/payments/b.ts"] } };
    const result = resolveSteering(request([root, child], { action }));
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.overrides[0]!.scope).toEqual(tree("src/auth"));
    const other = revision("other", { scope: tree("src/payments"), rules: [namedRule("other", "repository")] });
    expect(codes(request([root, child, other], { action }))).toContain("steering-semantic-conflict");
  });
  test("disjoint inclusion coverage does not manufacture a same-scope fact conflict", () => {
    const a = revision("a", { rules: [fact("a", "PostgreSQL")], inclusion: { availability: "required", selector: { kind: "path", selectors: [{ kind: "tree", path: "src/app" }] } } });
    const b = revision("b", { rules: [fact("b", "ClickHouse")], inclusion: { availability: "required", selector: { kind: "path", selectors: [{ kind: "tree", path: "src/analytics" }] } } });
    expect(resolveSteering(request([a, b], { action: { phase: "implementation", paths: { status: "known", paths: ["src/app/a.ts", "src/analytics/b.ts"] } } })).status).toBe("resolved");
  });
  test("inclusion alone does not confer narrower-scope override authority", () => {
    const root = revision("root", { rules: [namedRule("root", "service", { scope: tree("src") })] });
    const child = scoped(root, "child", tree("src"), { rules: [namedRule("child", "repository")], composition: override(root),
      inclusion: { availability: "required", selector: { kind: "path", selectors: [{ kind: "tree", path: "src/auth" }] } } });
    expect(codes(request([root, child]))).toContain("steering-override-not-allowed");
  });
  test("partially overlapping incomparable scopes conflict in their overlap", () => {
    const a = revision("a", { scope: { kind: "path", selectors: [{ kind: "tree", path: "src/a" }, { kind: "tree", path: "src/shared" }] }, rules: [namedRule("a")] });
    const b = revision("b", { scope: { kind: "path", selectors: [{ kind: "tree", path: "src/b" }, { kind: "tree", path: "src/shared" }] }, rules: [namedRule("b", "repository")] });
    const result = resolveSteering(request([a, b], { action: { phase: "implementation", paths: { status: "known", paths: ["src/shared/a.ts"] } } }));
    expect(result.status).toBe("conflicted");
    expect(result.diagnostics.find((issue) => issue.code === "steering-semantic-conflict")!.detail).toBe("overlapping-incomparable");
  });
  test("optional contradictory resources are not arbitrarily dropped", () => {
    const a = revision("a", { rules: [namedRule("a")] }), b = revision("b", { rules: [namedRule("b", "repository")], inclusion: { availability: "optional", selector: { kind: "always" } } });
    expect(resolveSteering(request([a, b])).status).toBe("conflicted");
  });
  for (const [effectA, valueA, effectB, valueB, expected] of [
    ["forbid", "a", "forbid", "b", "resolved"], ["require", "a", "forbid", "a", "conflicted"],
    ["require", "a", "forbid", "b", "resolved"], ["require", "a", "require", "b", "conflicted"],
    ["prefer", "a", "prefer", "b", "conflicted"], ["prefer", "a", "require", "a", "conflicted"],
  ] as const) test(`${effectA} ${valueA} with ${effectB} ${valueB}: ${expected}`, () => {
    const a = namedRule("a"), b = namedRule("b");
    a.semantics.effect = effectA; a.semantics.value = valueA; b.semantics.effect = effectB; b.semantics.value = valueB;
    expect(resolveSteering(request([revision("a", { rules: [a] }), revision("b", { rules: [b] })])).status).toBe(expected);
  });
});

describe("05C-2 override validation and sealing", () => {
  test("missing exact override target rule", () => {
    const root = revision("root"), child = scoped(root, "child", tree("src/auth"), { composition: override(root, "specialize", steeringRuleIdSchema.parse("rule.missing")) });
    expect(codes(request([root, child]))).toContain("steering-override-target-missing");
  });
  test("an existing but inapplicable target cannot be overridden", () => {
    const root = revision("root", { rules: [namedRule("root", "service", { inclusion: { availability: "required", selector: { kind: "phase", phases: ["review"] } } })] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("child")], composition: override(root) });
    expect(codes(request([root, child]))).toContain("steering-override-target-missing");
  });
  test("replacement is not allowed by narrower-scope policy", () => {
    const root = revision("root", { rules: [namedRule("root")] }), child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("child", "repository")], composition: override(root, "replace") });
    expect(codes(request([root, child]))).toContain("steering-override-not-allowed");
  });
  test("same rule scope cannot specialize a narrower-scope policy", () => {
    const root = revision("root", { rules: [namedRule("root", "service", { scope: tree("src/auth") })] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("child", "repository")], composition: override(root) });
    expect(codes(request([root, child]))).toContain("steering-override-not-allowed");
  });
  test("ambiguous source rules cannot be chosen by array order", () => {
    const root = revision("root", { rules: [namedRule("root")] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("a", "one"), namedRule("b", "two")], composition: override(root) });
    expect(codes(request([root, child]))).toContain("steering-override-ambiguous");
  });
  test("resource-wide overrides need unambiguous semantic pairs", () => {
    const root = revision("root", { rules: [namedRule("a"), namedRule("b")] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("child", "repository")], composition: { parents: [root.identity], overrides: [{ target: { resource: root.identity }, mode: "specialize", rationale: "Unambiguous pair required" }] } });
    expect(codes(request([root, child]))).toContain("steering-override-ambiguous");
    const singleRoot = { ...root, rules: [root.rules[0]!] };
    expect(resolveSteering(request([singleRoot, child])).status).toBe("resolved");
  });
  test("wildcard and rule-specific declarations cannot target the same rule twice", () => {
    const root = revision("root", { rules: [namedRule("root")] });
    const declarations = override(root);
    const child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("child", "repository")] });
    const input = request([root, { ...child, composition: { parents: declarations.parents, overrides: [
      declarations.overrides[0]!, { ...declarations.overrides[0]!, target: { resource: root.identity } },
    ] } }]);
    expect(codes(input)).toContain("steering-override-ambiguous");
  });
  test("competing sibling overrides remain ambiguous even if proposed values agree", () => {
    const root = revision("root", { rules: [namedRule("root")] });
    const a = scoped(root, "a", tree("src/auth"), { rules: [namedRule("a", "repository")], composition: override(root) });
    const b = scoped(root, "b", tree("src/auth"), { rules: [namedRule("b", "repository")], composition: override(root) });
    expect(codes(request([root, a, b]))).toContain("steering-override-ambiguous");
  });
  test("explicit targets must be direct parents, not unrelated revisions", () => {
    const root = revision("root"), other = revision("other"), child = scoped(root, "child", tree("src/auth"), { composition: { parents: [root.identity], overrides: override(other).overrides } });
    expect(codes(request([root, other, child]))).toContain("steering-override-not-allowed");
  });
  for (const identical of [false, true]) test(`sealed targets reject narrower overrides even with ${identical ? "identical" : "different"} semantics`, () => {
    const root = revision("root", { rules: [namedRule("root", "service", { override_policy: "sealed" })] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("child", identical ? "service" : "repository")], composition: override(root) });
    const result = resolveSteering(request([root, child]));
    expect(result.status).toBe("conflicted"); expect(result.diagnostics.some((issue) => issue.code === "steering-sealed-rule-override")).toBe(true);
  });
  test("equivalent sealed contributions can coexist without claiming an override", () => {
    const root = revision("root", { rules: [namedRule("root", "service", { override_policy: "sealed" })] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("child")] });
    expect(resolveSteering(request([root, child])).status).toBe("resolved");
  });
  test("normative-to-descriptive downgrade is rejected", () => {
    const root = revision("root", { rules: [namedRule("root", "service", { override_policy: "explicit-replacement" })] });
    const childRule = namedRule("child", "service", { authority: "descriptive", semantics: { ...root.rules[0]!.semantics, effect: "describe" } });
    const child = scoped(root, "child", tree("src/auth"), { rules: [childRule], composition: override(root, "replace") });
    expect(codes(request([root, child]))).toContain("steering-authority-conflict");
  });
  test("compatible authority is retained and explicit upward transition is authored, not inferred", () => {
    const root = revision("root", { rules: [fact("root", "service")] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("child", "service", { semantics: { ...root.rules[0]!.semantics, effect: "require" } })], composition: override(root, "replace") });
    const result = resolveSteering(request([root, child]));
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.effective_rules.find((rule) => rule.semantics.effect === "require")!.authority).toBe("normative");
  });
});
