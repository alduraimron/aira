import { describe, expect, test } from "bun:test";
import {
  STEERING_SNAPSHOT_SCHEMA,
  canonicalSteeringSelectors,
  steeringSnapshotIdFromHash,
  steeringSnapshotSemanticBytes,
} from "../../../src/steering";
import { hashCanonical } from "../../../src/canonical-json";
import {
  hash,
  namedRule,
  nextRevision,
  override,
  policyBinding,
  profile,
  revision,
  scoped,
  snapshot,
  tree,
  verifierBinding,
} from "./fixtures";

describe("05C-3A snapshot semantic identity", () => {
  test("identical semantics and reordered equivalent resolver inputs have identical bytes and IDs", () => {
    const a = revision("a", { rules: [namedRule("a", "same")] });
    const b = revision("b", { rules: [namedRule("b", "same")] });
    const first = snapshot([a, b]), second = snapshot([b, a]);
    expect(steeringSnapshotSemanticBytes(first)).toEqual(steeringSnapshotSemanticBytes(second));
    expect(first.content.hash).toBe(second.content.hash);
    expect(first.id).toBe(second.id);
  });

  test("semantic rule and exact resource hash changes produce new identities", () => {
    const root = revision("root", { rules: [namedRule("root", "service")] });
    const changedRule = nextRevision(root, 2, { rules: [namedRule("root", "repository", { source: undefined })] });
    const sameRuleNewBytes = nextRevision(root, 3, { rules: [namedRule("root", "service", { source: undefined })] });
    const original = snapshot([root]);
    expect(snapshot([changedRule]).id).not.toBe(original.id);
    expect(snapshot([sameRuleNewBytes]).id).not.toBe(original.id);
  });

  test("resolver policy is in the hash subject even though unsupported policies cannot be built", () => {
    const current = snapshot([revision("root")]);
    const futureSemantic = {
      ...current.semantic,
      resolver: { ...current.semantic.resolver, policy: "aira.dev/steering-policy/future/v2" },
    };
    const futureHash = hashCanonical(futureSemantic);
    expect(futureHash).not.toBe(current.content.hash);
    expect(steeringSnapshotIdFromHash(futureHash)).not.toBe(current.id);
  });

  test("audit-only construction timestamps do not affect semantic bytes or identity", () => {
    const root = revision("root");
    const before = snapshot([root], {}, "2026-09-01T00:00:00.000Z");
    const after = snapshot([root], {}, "2026-09-02T00:00:00.000Z");
    expect(before.audit.constructed_at).not.toBe(after.audit.constructed_at);
    expect(steeringSnapshotSemanticBytes(before)).toEqual(steeringSnapshotSemanticBytes(after));
    expect(before.content).toEqual(after.content);
    expect(before.id).toBe(after.id);
  });
});

describe("05C-3A exact provenance and enforcement attribution", () => {
  test("equivalent contributors retain every exact source revision", () => {
    const a = revision("a", { rules: [namedRule("a", "same")] });
    const b = revision("b", { rules: [namedRule("b", "same")] });
    const value = snapshot([b, a]);
    expect(value.semantic.effective_rules).toHaveLength(1);
    expect(value.semantic.effective_rules[0]!.contributors.map((rule) => rule.resource)).toEqual([a.identity, b.identity]);
    expect(value.semantic.effective_rules[0]!.regions.map((region) => region.source)).toEqual([
      { resource: a.identity, rule: a.rules[0]!.id },
      { resource: b.identity, rule: b.rules[0]!.id },
    ]);
  });

  test("override and shadow chains, inclusion reasons, scopes, and exact resources survive", () => {
    const root = revision("root", { rules: [namedRule("root", "service")] });
    const child = scoped(root, "child", tree("src/auth"), {
      rules: [namedRule("child", "repository")],
      composition: override(root),
    });
    const value = snapshot([child, root]);
    expect(value.semantic.contract).toBe(STEERING_SNAPSHOT_SCHEMA);
    expect(value.semantic.resources.map((entry) => entry.revision.identity)).toEqual([root.identity, child.identity]);
    expect(value.semantic.resources.every((entry) => entry.reasons.length > 0)).toBe(true);
    expect(value.semantic.decisions.overrides[0]).toMatchObject({
      source: { resource: child.identity, rule: child.rules[0]!.id },
      target: { resource: root.identity, rule: root.rules[0]!.id },
      disposition: "supersede",
    });
    expect(value.semantic.decisions.shadowed_rules[0]).toMatchObject({
      target: { resource: root.identity, rule: root.rules[0]!.id },
      by: { resource: child.identity, rule: child.rules[0]!.id },
      coverage: "partial",
    });
    expect(value.semantic.effective_rules.find((rule) => rule.semantics.value === "service")!
      .regions[0]!.excluded_scopes).toEqual([tree("src/auth")]);
  });

  test("all typed enforcement variants and exact mechanism identities remain structured", () => {
    const verifier = verifierBinding();
    if (verifier.kind !== "verifier") throw new Error("fixture");
    const bindings = canonicalSteeringSelectors([
      policyBinding("one"),
      { kind: "extension" as const, contract: "aira.dev/check-extension/v1", mechanism: profile(), use: "required" as const },
      { kind: "repository-check" as const, check: "static-analysis" as const, verifier: verifier.verifier, use: "required" as const },
      verifier,
    ]);
    const root = revision("enforced", { rules: [namedRule("enforced", "protected", {
      authority: "enforceable", enforcement: bindings,
    })] });
    const value = snapshot([root], { supported_contracts: ["aira.dev/check-extension/v1"] });
    expect(value.semantic.effective_rules[0]!.enforcement).toEqual(bindings);
    expect(value.semantic.enforcement.map((entry) => entry.binding.kind)).toEqual([
      "capability-policy", "extension", "repository-check", "verifier",
    ]);
    expect(value.semantic.enforcement.every((entry) => entry.sources[0]!.resource.hash === root.identity.hash)).toBe(true);
  });

  test("raw content size/media metadata, authored provenance, and compatibility observations are pinned", () => {
    const root = revision("root");
    const value = snapshot([root]);
    const entry = value.semantic.resources[0]!;
    expect(entry.revision.content).toEqual(root.content);
    expect(entry.revision.provenance).toEqual(root.provenance);
    expect(entry.revision.identity.hash).toBe(hash());
    expect(value.semantic.compatibility).toEqual({ supported_contracts: [], available_enforcement: [] });
    expect(value.audit.resource_creation[0]).toEqual({ resource: root.identity, created: root.created });
  });
});
