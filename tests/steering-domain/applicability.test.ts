import { describe, expect, test } from "bun:test";
import {
  canonicalSteeringPhases,
  canonicalSteeringSelectors,
  steeringInclusionSchema,
  steeringInclusionSelectorSchema,
  steeringScopeSchema,
  validateSteeringInclusion,
  validateSteeringScope,
} from "../../src/steering";
import { resource } from "./fixtures";

const pathSelectors = canonicalSteeringSelectors([
  { kind: "tree" as const, path: "src/domain" },
  { kind: "glob" as const, pattern: "tests/**/*.test.ts", dialect: "aira.dev/glob/v1" as const },
]);
const specKinds = canonicalSteeringSelectors([
  { kind: "feature" as const },
  { kind: "custom" as const, custom_kind: "api-change" },
]);
const taskKinds = canonicalSteeringSelectors([
  { kind: "implementation" as const },
  { kind: "custom" as const, custom_kind: "data-backfill" },
]);

describe("Steering inclusion declarations", () => {
  test("always inclusion is explicit", () => {
    const value = { availability: "required", selector: { kind: "always" } } as const;
    expect(steeringInclusionSchema.parse(value)).toEqual(value);
    expect(validateSteeringInclusion(value)).toEqual([]);
  });

  test("phase inclusion uses canonical SDD phase order", () => {
    const phases = canonicalSteeringPhases(["review", "product", "implementation"]);
    expect(phases).toEqual(["product", "implementation", "review"]);
    expect(steeringInclusionSchema.safeParse({ availability: "required", selector: { kind: "phase", phases } }).success).toBe(true);
    expect(steeringInclusionSchema.safeParse({ availability: "required", selector: { kind: "phase", phases: [...phases].reverse() } }).success).toBe(false);
  });

  test("path inclusion reuses the declared Aira glob grammar", () => {
    const value = { availability: "required", selector: { kind: "path", selectors: pathSelectors } };
    expect(steeringInclusionSchema.safeParse(value).success).toBe(true);
    expect(steeringInclusionSchema.safeParse({ ...value, selector: { kind: "path", selectors: [{ kind: "glob", pattern: "src/{a,b}/**", dialect: "aira.dev/glob/v1" }] } }).success).toBe(false);
    expect(steeringInclusionSchema.safeParse({ ...value, selector: { kind: "path", selectors: [{ kind: "glob", pattern: "../src/**", dialect: "aira.dev/glob/v1" }] } }).success).toBe(false);
  });

  test("Spec-kind inclusion covers built-in and named custom kinds", () => {
    const value = { availability: "optional", selector: { kind: "spec-kind", kinds: specKinds } };
    expect(steeringInclusionSchema.safeParse(value).success).toBe(true);
    expect(steeringInclusionSchema.safeParse({ ...value, selector: { kind: "spec-kind", kinds: [{ kind: "custom" }] } }).success).toBe(false);
    expect(steeringInclusionSchema.safeParse({ ...value, selector: { kind: "spec-kind", kinds: [{ kind: "feature", custom_kind: "extra" }] } }).success).toBe(false);
  });

  test("task-kind inclusion reuses canonical Task kinds", () => {
    const value = { availability: "required", selector: { kind: "task-kind", kinds: taskKinds } };
    expect(steeringInclusionSchema.safeParse(value).success).toBe(true);
    expect(steeringInclusionSchema.safeParse({ ...value, selector: { kind: "task-kind", kinds: [{ kind: "unknown" }] } }).success).toBe(false);
  });

  test("manual inclusion is a closed selector, not arbitrary prompt text", () => {
    const value = { availability: "optional", selector: { kind: "manual" } } as const;
    expect(steeringInclusionSchema.parse(value)).toEqual(value);
    expect(steeringInclusionSchema.safeParse({ ...value, selector: { kind: "manual", selected_by: "worker" } }).success).toBe(false);
  });

  test("AND and OR composition has one deterministic flattened representation", () => {
    const children = canonicalSteeringSelectors([
      { kind: "phase" as const, phases: ["implementation" as const] },
      { kind: "path" as const, selectors: [{ kind: "tree" as const, path: "src" }] },
    ]);
    const and = { availability: "required", selector: { kind: "composite", operator: "and", selectors: children } };
    expect(steeringInclusionSchema.safeParse(and).success).toBe(true);
    expect(steeringInclusionSchema.safeParse({ ...and, selector: { ...and.selector, selectors: [...children].reverse() } }).success).toBe(false);

    const nested = canonicalSteeringSelectors([
      { kind: "manual" as const },
      { kind: "composite" as const, operator: "and" as const, selectors: children },
    ]);
    expect(steeringInclusionSchema.safeParse({ availability: "optional", selector: { kind: "composite", operator: "or", selectors: nested } }).success).toBe(true);
  });

  test("invalid, redundant, and ambiguous selector structures fail", () => {
    const phase = { kind: "phase" as const, phases: ["implementation" as const] };
    for (const selector of [
      { kind: "phase", phases: [] },
      { kind: "other" },
      { kind: "composite", operator: "xor", selectors: [phase, { kind: "manual" }] },
      { kind: "composite", operator: "and", selectors: [phase] },
      { kind: "composite", operator: "and", selectors: canonicalSteeringSelectors([{ kind: "always" }, phase]) },
      { kind: "composite", operator: "and", selectors: canonicalSteeringSelectors([phase, { kind: "composite", operator: "and", selectors: canonicalSteeringSelectors([phase, { kind: "manual" }]) }]) },
    ]) expect(steeringInclusionSelectorSchema.safeParse(selector).success).toBe(false);
    expect(validateSteeringInclusion({ availability: "sometimes", selector: phase }).map((issue) => issue.code)).toContain("invalid-steering-inclusion");
  });
});

describe("Steering scopes", () => {
  test("project-global scope is explicit", () => {
    expect(steeringScopeSchema.parse({ kind: "project-global" })).toEqual({ kind: "project-global" });
  });

  test("path, phase, Spec-kind, and task-kind scopes are supported", () => {
    for (const scope of [
      { kind: "path", selectors: pathSelectors },
      { kind: "phase", phases: ["architecture", "verification"] },
      { kind: "spec-kind", kinds: specKinds },
      { kind: "task-kind", kinds: taskKinds },
    ]) {
      expect(steeringScopeSchema.safeParse(scope).success).toBe(true);
      expect(validateSteeringScope(scope)).toEqual([]);
    }
  });

  test("scope intersections and unions are deterministic", () => {
    const scopes = canonicalSteeringSelectors([
      { kind: "phase" as const, phases: ["implementation" as const] },
      { kind: "path" as const, selectors: [{ kind: "tree" as const, path: "src/security" }] },
      { kind: "spec-kind" as const, kinds: [{ kind: "feature" as const }] },
    ]);
    const scope = { kind: "composite", operator: "and", scopes };
    expect(steeringScopeSchema.safeParse(scope).success).toBe(true);
    expect(steeringScopeSchema.safeParse({ ...scope, scopes: [...scopes].reverse() }).success).toBe(false);
  });

  test("malformed or redundant scope combinations are rejected", () => {
    const phase = { kind: "phase" as const, phases: ["implementation" as const] };
    expect(steeringScopeSchema.safeParse({ kind: "composite", operator: "and", scopes: canonicalSteeringSelectors([{ kind: "project-global" }, phase]) }).success).toBe(false);
    expect(steeringScopeSchema.safeParse({ kind: "path", selectors: [] }).success).toBe(false);
    expect(steeringScopeSchema.safeParse({ kind: "phase", phases: ["tasks"] }).success).toBe(false);
    expect(validateSteeringScope({ kind: "path", paths: ["src"] }).map((issue) => issue.code)).toContain("invalid-steering-scope");
  });

  test("a project-scoped layer cannot declare a global scope", () => {
    const base = resource();
    expect(() => resource({ layer: "project-scoped" })).toThrow();
    expect(resource({ layer: "project-scoped", scope: { kind: "path", selectors: [{ kind: "tree", path: "src/domain" }] } }).layer)
      .toBe("project-scoped");
    expect(base.scope.kind).toBe("project-global");
  });
});
