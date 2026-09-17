import { describe, expect, test } from "bun:test";
import {
  canonicalSteeringSelectors, compareSteeringScopes, evaluateSteeringExpression, resolveSteering,
  type SteeringInclusionSelector, type SteeringScope,
} from "../../../src/steering";
import { andScope, fact, globalScope, manualSelection, namedRule, orScope, phase, request, revision, tree } from "./fixtures";

const codes = (input: unknown) => resolveSteering(input).diagnostics.map((issue) => issue.code);
const glob = (pattern: string): SteeringScope => ({ kind: "path", selectors: [{ kind: "glob", pattern, dialect: "aira.dev/glob/v1" }] });
describe("05C-2 scope relations", () => {
  test.each([
    [globalScope, globalScope, "equal"], [tree("src"), globalScope, "narrower"],
    [tree("src/auth"), tree("src"), "narrower"], [tree("src"), tree("src/auth"), "wider"],
    [tree("src/auth"), tree("src/analytics"), "disjoint"], [tree("src/a"), tree("src/ab"), "disjoint"],
    [phase("implementation"), phase("implementation", "verification"), "narrower"],
    [phase("implementation"), phase("verification"), "disjoint"],
    [phase("implementation", "verification"), phase("verification", "review"), "overlapping-incomparable"],
    [glob("src/**"), glob("src/**"), "equal"],
    [glob("src/auth/**"), glob("src/**"), "overlapping-incomparable"],
    [tree("src"), phase("implementation"), "overlapping-incomparable"],
  ] as const)("%j compared with %j is %s", (a, b, relation) => expect(compareSteeringScopes(a, b)).toBe(relation));
  test("exact paths narrow only provable exact/tree scopes", () => {
    const exact: SteeringScope = { kind: "path", selectors: [{ kind: "exact", path: "src/auth/a.ts" }] };
    expect(compareSteeringScopes(exact, tree("src/auth"))).toBe("narrower");
    expect(compareSteeringScopes(exact, exact)).toBe("equal");
    expect(compareSteeringScopes(exact, tree("src/other"))).toBe("disjoint");
    expect(compareSteeringScopes(exact, glob("tests/**"))).toBe("disjoint");
  });
  test("Spec and Task kind sets use exact inclusion, including custom identity", () => {
    const spec: SteeringScope = { kind: "spec-kind", kinds: [{ kind: "custom", custom_kind: "one" }] };
    expect(compareSteeringScopes(spec, { kind: "spec-kind", kinds: [{ kind: "feature" }, { kind: "custom", custom_kind: "one" }] })).toBe("narrower");
    expect(compareSteeringScopes(spec, { kind: "spec-kind", kinds: [{ kind: "custom", custom_kind: "two" }] })).toBe("disjoint");
    expect(compareSteeringScopes({ kind: "task-kind", kinds: [{ kind: "test" }] }, { kind: "task-kind", kinds: [{ kind: "test" }, { kind: "implementation" }] })).toBe("narrower");
  });
  test("structural composite implication and disjointness are order independent", () => {
    const narrow = andScope(tree("src/auth"), phase("implementation"));
    const broad = andScope(tree("src"), phase("implementation", "verification"));
    expect(compareSteeringScopes(narrow, broad)).toBe("narrower");
    expect(compareSteeringScopes(narrow, orScope(tree("src"), tree("tests")))).toBe("narrower");
    expect(compareSteeringScopes(narrow, andScope(tree("src"), phase("verification")))).toBe("disjoint");
    const reordered = { ...broad, scopes: broad.kind === "composite" ? [...broad.scopes].reverse() : [] } as SteeringScope;
    expect(compareSteeringScopes(broad, reordered)).toBe("equal");
  });
  test("empty intersections are invalid", () => {
    expect(compareSteeringScopes(andScope(phase("implementation"), phase("verification")), globalScope)).toBe("invalid");
    expect(compareSteeringScopes({ kind: "path", selectors: [] }, globalScope)).toBe("invalid");
  });
  test("rule scope and rule inclusion cannot widen the resource declaration", () => {
    const root = revision("root", { scope: tree("src"), rules: [namedRule("wide", "service", { scope: globalScope })] });
    expect(codes(request([root]))).toContain("steering-scope-widening");
    const inclusion = revision("other", { inclusion: { availability: "required", selector: { kind: "phase", phases: ["implementation"] } },
      rules: [namedRule("wide", "service", { inclusion: { availability: "required", selector: { kind: "always" } } })] });
    expect(codes(request([inclusion]))).toContain("steering-inclusion-widening");
  });
});

describe("05C-2 inclusion", () => {
  const selectors: [SteeringInclusionSelector, "match" | "miss"][] = [
    [{ kind: "always" }, "match"], [{ kind: "phase", phases: ["implementation"] }, "match"],
    [{ kind: "phase", phases: ["verification"] }, "miss"],
    [{ kind: "path", selectors: [{ kind: "glob", pattern: "src/**/handler.?s", dialect: "aira.dev/glob/v1" }] }, "match"],
    [{ kind: "path", selectors: [{ kind: "tree", path: "tests" }] }, "miss"],
    [{ kind: "spec-kind", kinds: [{ kind: "feature" }] }, "match"],
    [{ kind: "spec-kind", kinds: [{ kind: "bugfix" }] }, "miss"],
    [{ kind: "task-kind", kinds: [{ kind: "implementation" }] }, "match"],
    [{ kind: "task-kind", kinds: [{ kind: "test" }] }, "miss"],
    [{ kind: "manual" }, "miss"],
  ];
  for (const [selector, outcome] of selectors) test(`${selector.kind} ${outcome} evaluates deterministically`, () => {
    const action = { ...request([]).action, spec: { selector: { kind: "feature" as const } }, task: { selector: { kind: "implementation" as const } } };
    expect(evaluateSteeringExpression(selector, action).outcome).toBe(outcome);
    const root = revision("root", { inclusion: { availability: "required", selector } });
    const result = resolveSteering(request([root], { action }));
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.included_resources.length).toBe(outcome === "match" ? 1 : 0);
  });
  test("known empty paths are false; absent or unknown observations are errors", () => {
    const selector: SteeringInclusionSelector = { kind: "path", selectors: [{ kind: "tree", path: "src" }] };
    expect(evaluateSteeringExpression(selector, { phase: "implementation", paths: { status: "known", paths: [] } }).outcome).toBe("miss");
    for (const action of [{ phase: "implementation" as const }, { phase: "implementation" as const, paths: { status: "unknown" as const } }]) {
      const root = revision("root", { inclusion: { availability: "required", selector } });
      expect(codes(request([root], { action }))).toContain("steering-inclusion-input-missing");
    }
  });
  test("missing phase and malformed Spec/Task selectors are invalid, not non-applicable", () => {
    expect(codes({ ...request([]), action: {} })).toContain("steering-inclusion-input-missing");
    for (const action of [{ phase: "implementation", spec: {} }, { phase: "implementation", task: { selector: { kind: "custom" } } }])
      expect(resolveSteering({ ...request([]), action }).status).toBe("invalid-input");
    expect(evaluateSteeringExpression({ kind: "spec-kind", kinds: [{ kind: "feature" }] }, request([]).action).outcome).toBe("miss");
    expect(evaluateSteeringExpression({ kind: "task-kind", kinds: [{ kind: "implementation" }] }, request([]).action).outcome).toBe("miss");
  });
  for (const operator of ["and", "or"] as const) test(`${operator} visits all children, including errors`, () => {
    const selector: SteeringInclusionSelector = { kind: "composite", operator, selectors: canonicalSteeringSelectors([
      { kind: "phase", phases: [operator === "or" ? "implementation" : "verification"] },
      { kind: "path", selectors: [{ kind: "tree", path: "src" }] },
    ] as SteeringInclusionSelector[]) };
    const evaluated = evaluateSteeringExpression(selector, { phase: "implementation" });
    expect(evaluated.outcome).toBe("error"); expect(evaluated.children).toHaveLength(2); expect(evaluated.missing).toEqual(["paths"]);
    const known = evaluateSteeringExpression(selector, request([]).action);
    expect(known.outcome).toBe(operator === "and" ? "miss" : "match");
  });
  test("AND witnessed by disjoint touched paths cannot invent common semantic coverage", () => {
    const root = revision("root", { inclusion: { availability: "required", selector: { kind: "composite", operator: "and", selectors: [
      { kind: "path", selectors: [{ kind: "tree", path: "src/auth" }] }, { kind: "path", selectors: [{ kind: "tree", path: "src/payments" }] },
    ] } } });
    expect(codes(request([root], { action: { phase: "implementation", paths: { status: "known", paths: ["src/auth/a.ts", "src/payments/b.ts"] } } }))).toContain("steering-scope-invalid");
  });
  test("AND match and OR miss", () => {
    const selectors: SteeringInclusionSelector[] = [{ kind: "phase", phases: ["implementation"] }, { kind: "task-kind", kinds: [{ kind: "test" }] }];
    expect(evaluateSteeringExpression({ kind: "composite", operator: "and", selectors }, { phase: "implementation", task: { selector: { kind: "test" } } }).outcome).toBe("match");
    expect(evaluateSteeringExpression({ kind: "composite", operator: "or", selectors }, { phase: "review" }).outcome).toBe("miss");
  });
  test("manual resources need an authorized exact resource selection", () => {
    const root = revision("manual", { inclusion: { availability: "required", selector: { kind: "manual" } } });
    const unselected = resolveSteering(request([root]));
    expect(unselected.status).toBe("resolved");
    if (unselected.status === "resolved") expect(unselected.omissions[0]!.reason).toBe("manual-unselected");
    const selected = resolveSteering(request([root], { manual: [manualSelection(root)] }));
    expect(selected.status).toBe("resolved");
    if (selected.status === "resolved") expect(selected.effective_rules).toHaveLength(1);
    const bad = manualSelection(root);
    expect(codes({ ...request([root]), manual: [{ ...bad, authorization: undefined }] })).toContain("steering-manual-unauthorized");
    expect(codes({ ...request([root]), manual: [{ ...bad, authorization: { ...bad.authorization, by: { kind: "worker", id: "self", implementation: "worker" } } }] })).toContain("steering-manual-unauthorized");
    expect(codes(request([root], { manual: [{ ...bad, authorization: { ...bad.authorization, project: "other" } }] }))).toContain("steering-manual-unauthorized");
  });
  test("manual rules require their own selection; selecting a resource is not selecting a rule", () => {
    const rule = namedRule("manual", "service", { inclusion: { availability: "required", selector: { kind: "manual" } } });
    const root = revision("root", { rules: [rule] });
    const unselected = resolveSteering(request([root], { manual: [manualSelection(root)] }));
    expect(unselected.status).toBe("resolved");
    if (unselected.status === "resolved") expect(unselected.effective_rules).toHaveLength(0);
    const result = resolveSteering(request([root], { manual: [manualSelection(root, rule)] }));
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.effective_rules).toHaveLength(1);
  });
  test("required missing, optional missing, and required selector miss differ", () => {
    const root = revision("missing"), selection = { resource: root.identity, inclusion: root.inclusion };
    expect(codes(request([], { selections: [selection] }))).toContain("steering-required-resource-missing");
    const optional = resolveSteering(request([], { selections: [{ ...selection, inclusion: { ...selection.inclusion, availability: "optional" } }] }));
    expect(optional.status).toBe("resolved"); expect(optional.diagnostics[0]!.code).toBe("steering-optional-resource-missing");
    const missed = resolveSteering(request([], { selections: [{ ...selection, inclusion: { availability: "required", selector: { kind: "phase", phases: ["review"] } } }] }));
    expect(missed.status).toBe("resolved"); expect(missed.diagnostics).toHaveLength(0);
    if (missed.status === "resolved") expect(missed.omissions[0]).toMatchObject({ availability: "required", reason: "selector-miss" });
  });
  test("required and optional missing manual resources and rules", () => {
    const root = revision("missing"), selection = manualSelection(root);
    expect(codes(request([], { manual: [selection] }))).toContain("steering-manual-selection-missing");
    const optional = resolveSteering(request([], { manual: [{ ...selection, availability: "optional" }] }));
    expect(optional.status).toBe("resolved"); expect(optional.diagnostics[0]!.severity).toBe("warning");
    expect(codes(request([root], { manual: [manualSelection(root, namedRule("missing"))] }))).toContain("steering-manual-selection-missing");
  });
  test("deprecated rules are recorded but not selected", () => {
    const root = revision("root", { rules: [namedRule("retired", "service", { status: "deprecated" })] });
    const result = resolveSteering(request([root]));
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") { expect(result.effective_rules).toHaveLength(0); expect(result.omissions[0]!.reason).toBe("deprecated"); }
  });
});
