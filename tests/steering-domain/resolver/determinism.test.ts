import { describe, expect, test } from "bun:test";
import {
  canonicalSteeringSelectors, resolveSteering, steeringSemanticKeySchema, steeringResourceRevisionSchema,
  type SteeringInclusionSelector, type SteeringResolutionRequest,
} from "../../../src/steering";
import { verifierBinding } from "../fixtures";
import { namedRule, override, policyBinding, request, revision, scoped, tree } from "./fixtures";

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values]; let state = seed >>> 0;
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1); [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
function permuted(input: SteeringResolutionRequest, seed: number): unknown {
  const value = JSON.parse(JSON.stringify(input));
  // Permute declared sets only. JSON semantic value arrays remain ordered authored values.
  const walk = (object: Record<string, unknown>, salt: number): void => {
    for (const [key, item] of Object.entries(object)) {
      if (key === "value") continue;
      if (Array.isArray(item)) {
        object[key] = shuffled(item, salt + key.length);
        for (const child of object[key] as unknown[]) if (child && typeof child === "object") walk(child as Record<string, unknown>, salt + 13);
      } else if (item && typeof item === "object") walk(item as Record<string, unknown>, salt + 7);
    }
  };
  walk(value, seed); return value;
}
function fixture(): SteeringResolutionRequest {
  const inclusion: SteeringInclusionSelector = { kind: "composite", operator: "and", selectors: canonicalSteeringSelectors([
    { kind: "phase", phases: ["implementation", "verification"] },
    { kind: "path", selectors: [{ kind: "tree", path: "src" }, { kind: "tree", path: "tests" }] },
    { kind: "composite", operator: "or", selectors: canonicalSteeringSelectors([
      { kind: "spec-kind", kinds: [{ kind: "feature" }, { kind: "refactor" }] },
      { kind: "task-kind", kinds: [{ kind: "implementation" }, { kind: "test" }] },
    ] as SteeringInclusionSelector[]) },
  ] as SteeringInclusionSelector[]) };
  const bindings = canonicalSteeringSelectors([policyBinding("one"), verifierBinding()]);
  const main = namedRule("main", ["ordered", "semantic", "value"], { authority: "enforceable", enforcement: bindings });
  const extra = namedRule("other", "other", { semantics: { key: steeringSemanticKeySchema.parse("topic.other"), effect: "require", value: "other" } });
  const a = revision("a", { rules: [main, extra], inclusion: { availability: "required", selector: inclusion } });
  const b = revision("b", { rules: [main, extra], inclusion: a.inclusion });
  const child = scoped(a, "child", tree("src/auth"), { rules: [main, extra], inclusion: a.inclusion,
    composition: { parents: canonicalSteeringSelectors([a.identity, b.identity]), overrides: canonicalSteeringSelectors([...override(a, "strengthen").overrides, ...override(b, "strengthen").overrides]) } });
  return request([a, b, child], { action: { phase: "implementation", paths: { status: "known", paths: ["src/auth/b.ts", "src/auth/a.ts"] },
    spec: { selector: { kind: "feature" } }, task: { selector: { kind: "implementation" } } } });
}

describe("05C-2 deterministic permutation properties", () => {
  test("64 shuffles of resources, parents, rules, bindings, selectors and expectations produce byte-identical comparison results", () => {
    const input = fixture(), baseline = resolveSteering(input);
    expect(baseline.status).toBe("resolved");
    for (let seed = 1; seed <= 64; seed++) expect(JSON.stringify(resolveSteering(permuted(input, seed)))).toBe(JSON.stringify(baseline));
  });
  test("fatal semantic and override diagnostics are stable across 32 shuffles", () => {
    const root = revision("root", { rules: [namedRule("root", "service", { override_policy: "sealed" })] });
    const child = scoped(root, "child", tree("src/auth"), { rules: [namedRule("child", "repository")], composition: override(root) });
    const input = request([root, child]), baseline = resolveSteering(input);
    expect(baseline.status).toBe("conflicted");
    for (let seed = 1; seed <= 32; seed++) expect(resolveSteering(permuted(input, seed))).toEqual(baseline);
  });
  test("invalid graph diagnostics are stable across 32 shuffles", () => {
    const input = fixture();
    const bad = { ...input, catalog: [...input.catalog, input.catalog[0]!] };
    const baseline = resolveSteering(bad);
    expect(baseline.status).toBe("invalid-input");
    for (let seed = 1; seed <= 32; seed++) expect(resolveSteering(permuted(bad, seed))).toEqual(baseline);
  });
  test("results are deeply immutable, detached, and do not freeze or mutate caller objects", () => {
    const input = fixture(), before = JSON.stringify(input), result = resolveSteering(input);
    expect(result.status).toBe("resolved"); expect(JSON.stringify(input)).toBe(before);
    const visit = (item: unknown): void => { if (item && typeof item === "object") { expect(Object.isFrozen(item)).toBe(true); for (const child of Object.values(item)) visit(child); } };
    visit(result);
    expect(Object.isFrozen(input)).toBe(false); expect(Object.isFrozen(input.catalog[0])).toBe(false);
    const copy = JSON.stringify(result); (input.catalog[0]!.metadata as { title: string }).title = "Changed after resolution";
    expect(JSON.stringify(result)).toBe(copy);
  });
  test("persisted 05C-1 decoder still rejects noncanonical revisions; resolver set presentation is not a decoder", () => {
    const input = fixture(), changed = { ...input.catalog[0]!, rules: [...input.catalog[0]!.rules].reverse() };
    expect(steeringResourceRevisionSchema.safeParse(changed).success).toBe(false);
    expect(resolveSteering({ ...input, catalog: [changed, ...input.catalog.slice(1)] }).status).toBe("resolved");
  });
  test("duplicate members and noncanonical expression structure are rejected, not silently normalized", () => {
    const input = fixture(), root = input.catalog[0]!;
    const duplicate = { ...root, default_enforcement: [policyBinding("one"), policyBinding("one")] };
    expect(resolveSteering({ ...input, catalog: [duplicate, ...input.catalog.slice(1)] }).status).toBe("invalid-input");
    const phase = { kind: "phase", phases: ["implementation"] };
    const malformed = { ...root, inclusion: { availability: "required", selector: { kind: "composite", operator: "and", selectors: [phase, { kind: "composite", operator: "and", selectors: [phase, { kind: "manual" }] }] } } };
    expect(resolveSteering({ ...input, catalog: [malformed, ...input.catalog.slice(1)] }).status).toBe("invalid-input");
  });
  test("semantic JSON arrays are not reordered into false equivalence", () => {
    const a = revision("a", { rules: [namedRule("a", ["a", "b"])] });
    const b = revision("b", { rules: [namedRule("b", ["b", "a"])] });
    expect(resolveSteering(request([a, b])).status).toBe("conflicted");
  });
  test("limits reject excessively deep expressions and oversized catalogs without recursion errors", () => {
    const deep: Record<string, unknown> = {}; let cursor = deep;
    for (let i = 0; i < 60; i++) { const child = {}; cursor.child = child; cursor = child; }
    expect(resolveSteering(deep).diagnostics[0]!.code).toBe("steering-input-limit");
    expect(resolveSteering({ ...request([]), catalog: Array.from({ length: 257 }, () => ({})) }).status).toBe("invalid-input");
    const root = revision("root"), longPath = Array.from({ length: 129 }, () => "a").join("/");
    expect(resolveSteering(request([root], { action: { phase: "implementation", paths: { status: "known", paths: [longPath] } } })).status).toBe("invalid-input");
    const longGlob = { ...root, scope: { kind: "path", selectors: [{ kind: "glob", pattern: Array.from({ length: 129 }, () => "**").join("/"), dialect: "aira.dev/glob/v1" }] } };
    expect(resolveSteering({ ...request([root]), catalog: [longGlob] }).diagnostics[0]!.code).toBe("steering-input-limit");
  });
});
