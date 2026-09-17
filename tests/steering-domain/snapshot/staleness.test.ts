import { describe, expect, test } from "bun:test";
import {
  bindSteeringDependency,
  canonicalSteeringSelectors,
  compareSteeringSnapshots,
  evaluateSteeringStaleness,
  steeringChangeSetSchema,
  type SteeringDependency,
  type SteeringSnapshot,
} from "../../../src/steering";
import { canonical, compareText } from "../../../src/spec/domain/primitives";
import {
  hash,
  namedRule,
  nextRevision,
  policyBinding,
  revision,
  snapshot,
} from "./fixtures";

const subject = { kind: "implementation-attempt" as const, attempt: "attempt_one" as const };
function dependency(value: SteeringSnapshot, mode: Parameters<typeof bindSteeringDependency>[1]["dependency"]): SteeringDependency {
  const result = bindSteeringDependency(value, { phase: "implementation", subject, dependency: mode });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
const keyDependency = (value: SteeringSnapshot, key = "topic.access") => dependency(value, {
  mode: "declared", resources: [], semantic_keys: [key as never], rules: [], enforcement: [],
});

describe("05C-3A causal Steering staleness", () => {
  test("an unrelated rule change leaves a fine-grained semantic-key dependency applicable", () => {
    const depended = revision("depended", { rules: [namedRule("depended", "stable")] });
    const unrelated = revision("unrelated", { rules: [namedRule("unrelated", "one", {
      semantics: { key: "topic.unrelated" as never, effect: "require", value: "one" },
    })] });
    const changed = nextRevision(unrelated, 2, { rules: [namedRule("unrelated", "two", {
      semantics: { key: "topic.unrelated" as never, effect: "require", value: "two" }, source: undefined,
    })] });
    const previous = snapshot([depended, unrelated]), current = snapshot([depended, changed]);
    expect(evaluateSteeringStaleness(keyDependency(previous), previous, current)).toMatchObject({
      status: "still-applicable", reasons: [{ code: "steering-dependency-unrelated-change" }],
    });
  });

  test("a depended semantic value change and removal are stale", () => {
    const root = revision("root", { rules: [namedRule("root", "one")] });
    const previous = snapshot([root]), changed = snapshot([nextRevision(root, 2, {
      rules: [namedRule("root", "two", { source: undefined })],
    })]);
    expect(evaluateSteeringStaleness(keyDependency(previous), previous, changed)).toMatchObject({
      status: "stale", reasons: expect.arrayContaining([expect.objectContaining({ code: "steering-dependency-rule-changed" })]),
    });
    expect(evaluateSteeringStaleness(keyDependency(previous), previous, snapshot([]))).toMatchObject({
      status: "stale", reasons: expect.arrayContaining([expect.objectContaining({ code: "steering-dependency-rule-removed" })]),
    });
  });

  test("audit-only timestamp changes are semantically equivalent", () => {
    const root = revision("root");
    const previous = snapshot([root], {}, "2026-09-01T00:00:00.000Z");
    const current = snapshot([root], {}, "2026-09-02T00:00:00.000Z");
    const result = evaluateSteeringStaleness(dependency(previous, { mode: "whole-snapshot" }), previous, current);
    expect(result).toEqual({
      status: "still-applicable",
      reasons: [{ code: "steering-dependency-equivalent" }],
      comparison: {
        previous: { id: previous.id, hash: previous.content.hash },
        current: { id: current.id, hash: current.content.hash },
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
  });

  test("authority and applicable scope changes require reanalysis", () => {
    const root = revision("root", { rules: [namedRule("root", "stable")] });
    const previous = snapshot([root]);
    const binding = policyBinding("one");
    const authority = nextRevision(root, 2, { rules: [namedRule("root", "stable", {
      authority: "enforceable", enforcement: [binding], source: undefined,
    })] });
    expect(evaluateSteeringStaleness(keyDependency(previous), previous, snapshot([authority]))).toMatchObject({
      status: "requires-reanalysis",
      reasons: expect.arrayContaining([expect.objectContaining({ code: "steering-dependency-authority-changed" })]),
    });

    const narrowed = nextRevision(root, 3, {
      scope: { kind: "path", selectors: [{ kind: "tree", path: "src/auth" }] },
      rules: [namedRule("root", "stable", { scope: { kind: "path", selectors: [{ kind: "tree", path: "src/auth" }] }, source: undefined })],
    });
    expect(evaluateSteeringStaleness(keyDependency(previous), previous, snapshot([narrowed]))).toMatchObject({
      status: "requires-reanalysis",
      reasons: expect.arrayContaining([expect.objectContaining({ code: "steering-dependency-scope-changed" })]),
    });
  });

  test("dependent enforcement disappearance is stale and strengthening requires reanalysis", () => {
    const one = policyBinding("one"), two = policyBinding("two");
    const root = revision("root", { rules: [namedRule("root", "protected", {
      authority: "enforceable", enforcement: [one],
    })] });
    const previous = snapshot([root]);
    const enforcementDependency = dependency(previous, {
      mode: "declared", resources: [], semantic_keys: [], rules: [], enforcement: [one],
    });
    const replaced = nextRevision(root, 2, { rules: [namedRule("root", "protected", {
      authority: "enforceable", enforcement: [two], source: undefined,
    })] });
    expect(evaluateSteeringStaleness(enforcementDependency, previous, snapshot([replaced]))).toMatchObject({
      status: "stale",
      reasons: expect.arrayContaining([expect.objectContaining({ code: "steering-dependency-enforcement-changed" })]),
    });

    const strengthened = nextRevision(root, 3, { rules: [namedRule("root", "protected", {
      authority: "enforceable", enforcement: canonicalSteeringSelectors([one, two]), source: undefined,
    })] });
    expect(evaluateSteeringStaleness(enforcementDependency, previous, snapshot([strengthened]))).toMatchObject({
      status: "requires-reanalysis",
      reasons: expect.arrayContaining([expect.objectContaining({ code: "steering-dependency-enforcement-changed" })]),
    });
  });

  test("equivalent effective semantics ignore contributor churn only for semantic-key dependencies", () => {
    const a = revision("a", { rules: [namedRule("a", "same")] });
    const b = revision("b", { rules: [namedRule("b", "same")] });
    const b2 = nextRevision(b, 2, { rules: [namedRule("b", "same", { source: undefined })] });
    const previous = snapshot([a, b]), current = snapshot([a, b2]);
    expect(evaluateSteeringStaleness(keyDependency(previous), previous, current).status).toBe("still-applicable");
    const resourceDependency = dependency(previous, {
      mode: "declared", resources: [b.identity], semantic_keys: [], rules: [], enforcement: [],
    });
    expect(evaluateSteeringStaleness(resourceDependency, previous, current)).toMatchObject({
      status: "stale", reasons: expect.arrayContaining([expect.objectContaining({ code: "steering-dependency-resource-changed" })]),
    });
    const ruleDependency = dependency(previous, {
      mode: "declared", resources: [], semantic_keys: [],
      rules: [{ resource: b.identity, rule: b.rules[0]!.id }], enforcement: [],
    });
    expect(evaluateSteeringStaleness(ruleDependency, previous, current)).toMatchObject({
      status: "stale", reasons: expect.arrayContaining([expect.objectContaining({ code: "steering-dependency-rule-changed" })]),
    });
  });

  test("whole-snapshot dependencies observe any semantic snapshot change", () => {
    const root = revision("root"), previous = snapshot([root]);
    const current = snapshot([nextRevision(root, 2, { rules: [namedRule("architecture.repository-access", "changed", { source: undefined })] })]);
    expect(evaluateSteeringStaleness(dependency(previous, { mode: "whole-snapshot" }), previous, current).status).toBe("stale");
  });

  test("selection and omission-only changes remain complete structured comparisons", () => {
    const selection = (revisionId: string, digit: number) => ({
      resource: { id: "project.steering.optional" as never, revision: revisionId as never, hash: hash(digit) },
      inclusion: { availability: "optional" as const, selector: { kind: "always" as const } },
    });
    const previous = snapshot([], { selections: [selection("1", 1)] });
    const current = snapshot([], { selections: [selection("2", 2)] });
    const compared = compareSteeringSnapshots(previous, current);
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    expect(compared.value.changes.map((change) => change.dimension)).toEqual(expect.arrayContaining([
      "resource-selections", "omissions", "diagnostics",
    ]));
    expect(evaluateSteeringStaleness(dependency(previous, { mode: "whole-snapshot" }), previous, compared.value).status)
      .toBe("requires-reanalysis");
  });

  test("resolver-policy evolution is explicit and conservative", () => {
    const depended = revision("depended", { rules: [namedRule("depended", "stable")] });
    const unrelated = revision("other", { rules: [namedRule("other", "other", {
      semantics: { key: "topic.other" as never, effect: "require", value: "other" },
    })] });
    const previous = snapshot([depended]), current = snapshot([depended, unrelated]);
    const compared = compareSteeringSnapshots(previous, current);
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    const raw = JSON.parse(JSON.stringify(compared.value));
    raw.current.policy = "aira.dev/steering-policy/future/v2";
    raw.changes.push({
      kind: "resolver-policy-changed", previous: { resources: [], effective_rules: [] },
      current: { resources: [], effective_rules: [] },
      previous_policy: "aira.dev/steering-policy/conservative/v1",
      current_policy: "aira.dev/steering-policy/future/v2",
    });
    raw.changes.sort((a: unknown, b: unknown) => compareText(canonical(a), canonical(b)));
    const changeSet = steeringChangeSetSchema.parse(raw);
    expect(evaluateSteeringStaleness(keyDependency(previous), previous, changeSet)).toMatchObject({
      status: "requires-reanalysis",
      reasons: expect.arrayContaining([expect.objectContaining({ code: "steering-dependency-resolution-policy-changed" })]),
    });
  });

  test("missing or mismatched comparison information fails closed", () => {
    const root = revision("root", { rules: [namedRule("root", "stable")] }), previous = snapshot([root]);
    expect(evaluateSteeringStaleness(keyDependency(previous), previous, undefined)).toMatchObject({
      status: "invalid-input", reasons: [{ code: "steering-dependency-required-input-missing", detail: "comparison" }],
    });
    const other = snapshot([nextRevision(root, 2)]);
    const changes = compareSteeringSnapshots(previous, other);
    expect(changes.ok).toBe(true);
    if (!changes.ok) return;
    const wrongOrigin = JSON.parse(JSON.stringify(changes.value));
    wrongOrigin.previous.snapshot.hash = other.content.hash;
    expect(evaluateSteeringStaleness(keyDependency(previous), previous, wrongOrigin).status).toBe("invalid-input");
  });

  test("change sets classify exact resource, semantic, authority, scope, enforcement, and provenance dimensions", () => {
    const one = policyBinding("one"), root = revision("root", { rules: [namedRule("root", "one")] });
    const changed = nextRevision(root, 2, {
      inclusion: { availability: "required", selector: { kind: "phase", phases: ["implementation"] } },
      scope: { kind: "path", selectors: [{ kind: "tree", path: "src" }] },
      rules: [namedRule("root", "two", { authority: "enforceable", enforcement: [one],
        scope: { kind: "path", selectors: [{ kind: "tree", path: "src" }] }, source: undefined })],
    });
    const result = compareSteeringSnapshots(snapshot([root]), snapshot([changed]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changes.map((change) => change.kind)).toEqual(expect.arrayContaining([
      "resource-revision-changed", "semantic-value-changed", "authority-changed", "scope-changed",
      "inclusion-changed", "enforcement-changed", "provenance-changed",
    ]));
  });
});
