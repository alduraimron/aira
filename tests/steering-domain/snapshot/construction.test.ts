import { describe, expect, test } from "bun:test";
import {
  STEERING_SNAPSHOT_ENCODING,
  STEERING_SNAPSHOT_SCHEMA,
  buildSteeringSnapshot,
  resolveSteering,
  steeringSnapshotSemanticBytes,
  validateSteeringSnapshot,
} from "../../../src/steering";
import { canonicalBytes } from "../../../src/canonical-json";
import { namedRule, policyBinding, request, revision, snapshot } from "./fixtures";

const mutable = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const visitFrozen = (value: unknown): void => {
  if (value && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) visitFrozen(child);
  }
};

describe("05C-3A SteeringSnapshot construction", () => {
  test("freezes a successful exact 05C-2 resolution without re-resolution", () => {
    const root = revision("root"), resolution = resolveSteering(request([root]));
    const built = buildSteeringSnapshot(resolution, { constructed_at: "2026-09-01T12:00:00.000Z" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.schema).toBe(STEERING_SNAPSHOT_SCHEMA);
    expect(built.value.content_encoding).toBe(STEERING_SNAPSHOT_ENCODING);
    expect(built.value.semantic.project).toBe("acme");
    expect(built.value.semantic.resources[0]!.revision.identity).toEqual(root.identity);
    expect(built.value.content.bytes).toBe(steeringSnapshotSemanticBytes(built.value).byteLength);
    expect(validateSteeringSnapshot(built.value)).toEqual([]);
  });

  test("conflicted and invalid-input results are rejected with stable codes", () => {
    const a = revision("a", { rules: [namedRule("a", "one")] });
    const b = revision("b", { rules: [namedRule("b", "two")] });
    const conflicted = buildSteeringSnapshot(resolveSteering(request([a, b])));
    expect(conflicted).toMatchObject({ ok: false, issues: [{ code: "steering-snapshot-resolution-conflicted" }] });
    const invalid = buildSteeringSnapshot(resolveSteering({}));
    expect(invalid).toMatchObject({ ok: false, issues: [{ code: "steering-snapshot-resolution-invalid" }] });
  });

  test("missing exact revisions, hashes, and detached success fields fail closed", () => {
    const result = mutable(resolveSteering(request([revision("root")])) as Record<string, unknown>);
    delete ((result.included_resources as Array<{ revision: { identity: Record<string, unknown> } }>)[0]!.revision.identity).revision;
    expect(buildSteeringSnapshot(result)).toMatchObject({ ok: false, issues: [{ code: "steering-snapshot-revision-missing" }] });

    const withoutHash = mutable(resolveSteering(request([revision("root")])) as Record<string, unknown>);
    delete ((withoutHash.included_resources as Array<{ revision: { identity: Record<string, unknown> } }>)[0]!.revision.identity).hash;
    expect(buildSteeringSnapshot(withoutHash)).toMatchObject({ ok: false, issues: [{ code: "steering-snapshot-hash-missing" }] });

    const incomplete = mutable(resolveSteering(request([revision("root")])) as Record<string, unknown>);
    delete incomplete.effective_rules;
    expect(buildSteeringSnapshot(incomplete)).toMatchObject({ ok: false, issues: [{ code: "steering-snapshot-resolution-incomplete" }] });
  });

  test("unsupported resolver policy and inconsistent project provenance are rejected", () => {
    const unsupported = mutable(resolveSteering(request([revision("root")])) as Record<string, unknown>);
    unsupported.policy = "aira.dev/steering-policy/future/v2";
    expect(buildSteeringSnapshot(unsupported)).toMatchObject({ ok: false, issues: [{ code: "steering-snapshot-policy-unsupported" }] });

    const inconsistent = mutable(resolveSteering(request([revision("root")])) as Record<string, unknown>);
    const entry = (inconsistent.included_resources as Array<{ revision: { provenance: { project: string } } }>)[0]!;
    entry.revision.provenance.project = "other";
    expect(buildSteeringSnapshot(inconsistent)).toMatchObject({ ok: false });
  });

  test("missing effective enforcement and absent contributors are rejected", () => {
    const binding = policyBinding("one");
    const root = revision("root", { rules: [namedRule("root", "protected", { authority: "enforceable", enforcement: [binding] })] });
    const noBinding = mutable(resolveSteering(request([root])) as Record<string, unknown>);
    (noBinding.enforcement as unknown[]).length = 0;
    expect(buildSteeringSnapshot(noBinding)).toMatchObject({ ok: false, issues: expect.arrayContaining([
      expect.objectContaining({ code: "steering-snapshot-enforcement-missing" }),
    ]) });

    const noContributor = mutable(resolveSteering(request([root])) as Record<string, unknown>);
    (noContributor.applicable_rules as unknown[]).length = 0;
    expect(buildSteeringSnapshot(noContributor)).toMatchObject({ ok: false, issues: expect.arrayContaining([
      expect.objectContaining({ code: "steering-snapshot-contributor-missing" }),
    ]) });
  });

  test("construction detaches caller data and deeply freezes successful output", () => {
    const input = mutable(resolveSteering(request([revision("root")])));
    const built = buildSteeringSnapshot(input);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const before = canonicalBytes(built.value);
    (input as { inputs: { project: string } }).inputs.project = "changed";
    expect(canonicalBytes(built.value)).toEqual(before);
    visitFrozen(built.value);
  });

  test("snapshot validator catches content identity and impossible typed enforcement claims", () => {
    const valid = snapshot([revision("root")]);
    const wrongHash = mutable(valid) as unknown as { content: { hash: string } };
    wrongHash.content.hash = `sha256:${"f".repeat(64)}`;
    expect(validateSteeringSnapshot(wrongHash).map((issue) => issue.code)).toContain("steering-snapshot-content-hash-mismatch");

    const binding = policyBinding("one");
    const enforceable = snapshot([revision("enforced", { rules: [namedRule("enforced", "protected", {
      authority: "enforceable", enforcement: [binding],
    })] })]);
    const impossible = mutable(enforceable) as unknown as {
      semantic: { effective_rules: Array<{ enforcement: unknown[] }> };
    };
    impossible.semantic.effective_rules[0]!.enforcement.length = 0;
    expect(validateSteeringSnapshot(impossible).map((issue) => issue.code)).toContain("steering-snapshot-content-hash-mismatch");
  });
});
