import { describe, expect, test } from "bun:test";
import { resolveSteering, steeringResourceIdSchema, steeringRevisionIdSchema } from "../../../src/steering";
import { hash, override, request, revision, scoped, tree } from "./fixtures";

const codes = (input: unknown) => resolveSteering(input).diagnostics.map((issue) => issue.code);
describe("05C-2 hierarchy", () => {
  test("parents are included by exact edges, not catalog position", () => {
    const parent = revision("root"), child = scoped(parent);
    const result = resolveSteering(request([child, parent], { selections: [{ resource: child.identity, inclusion: child.inclusion }] }));
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.hierarchy_order).toEqual([parent.identity, child.identity]);
    expect(result.included_resources[0]!.reasons[0]!.kind).toBe("parent");
    expect(result.included_resources[1]!.tier).toBe("project-scoped");
  });
  test("unknown exact parent", () => {
    const parent = revision("root"), child = scoped(parent);
    expect(codes(request([child]))).toContain("steering-parent-missing");
  });
  test("parent hash is exact, with no current revision fallback", () => {
    const parent = revision("root"), child = scoped(parent);
    const bad = { ...child, composition: { ...child.composition, parents: [{ ...parent.identity, hash: hash(2) }] } };
    expect(codes(request([parent, bad]))).toContain("steering-parent-missing");
  });
  test("self-parent reports the lineage error and cycle", () => {
    const parent = revision("root");
    const bad = { ...parent, composition: { parents: [parent.identity], overrides: [] } };
    expect(codes(request([bad]))).toContain("steering-parent-invalid");
    expect(codes(request([bad]))).toContain("steering-parent-cycle");
  });
  for (const count of [2, 3]) test(`${count}-node parent cycle is stable`, () => {
    const revisions = Array.from({ length: count }, (_, i) => revision(`node-${i}`));
    const catalog = revisions.map((item, i) => ({ ...item, composition: { parents: [revisions[(i + 1) % count]!.identity], overrides: [] } }));
    const input = request(catalog);
    expect(codes(input)).toContain("steering-parent-cycle");
    expect(resolveSteering(input)).toEqual(resolveSteering({ ...input, catalog: [...catalog].reverse(), selections: [...input.selections].reverse() }));
  });
  test("duplicate resources, rules, and parent relations have semantic codes", () => {
    const parent = revision("root"), child = scoped(parent);
    expect(codes(request([parent, parent]))).toContain("steering-duplicate-resource");
    expect(codes(request([{ ...parent, rules: [parent.rules[0]!, parent.rules[0]!] }]))).toContain("steering-duplicate-rule");
    expect(codes(request([parent, { ...child, composition: { parents: [parent.identity, parent.identity], overrides: [] } }]))).toContain("steering-parent-duplicate");
  });
  test("same rule ID in separate resources is not a duplicate identity", () => {
    expect(resolveSteering(request([revision("a"), revision("b")])).status).toBe("resolved");
  });
  test("own earlier revision is not an inheritance parent", () => {
    const first = revision("root");
    const second = { ...first, identity: { ...first.identity, revision: steeringRevisionIdSchema.parse("2") }, composition: { parents: [first.identity], overrides: [] } };
    expect(codes(request([first, second]))).toContain("steering-parent-invalid");
  });
  test("root-to-root inheritance is not permitted", () => {
    const parent = revision("root"), other = revision("other", { composition: { parents: [parent.identity], overrides: [] } });
    expect(codes(request([parent, other]))).toContain("steering-parent-invalid");
  });
  test("scoped project resource needs an explicit parent", () => {
    expect(codes(request([revision("orphan", { layer: "project-scoped", scope: tree("src") })]))).toContain("steering-parent-missing");
  });
  test("scope widening is invalid, not inheritance", () => {
    const parent = revision("root", { scope: { kind: "phase", phases: ["implementation"] } });
    const child = scoped(parent, "child", { kind: "phase", phases: ["implementation", "verification"] });
    expect(codes(request([parent, child]))).toContain("steering-scope-widening");
  });
  test("cross-project provenance fails", () => {
    expect(codes(request([revision("foreign", { provenance: { kind: "project", project: "other", authorship: "authored" } })]))).toContain("steering-project-mismatch");
  });
  test("template may be in the catalog but cannot be selected as project authority", () => {
    const template = revision("template");
    const value = { ...template, identity: { ...template.identity, id: "template.steering.architecture" }, layer: "template", provenance: { kind: "aira-template", publisher: "aira", published_content_hash: hash() } };
    const input = { ...request([]), catalog: [value] };
    expect(resolveSteering(input).status).toBe("resolved");
    expect(codes({ ...input, selections: [{ resource: value.identity, inclusion: value.inclusion }] })).toContain("steering-source-invalid");
  });
  test("an adopted project revision does not inherit template authority", () => {
    const source = { ...revision("root").identity, id: steeringResourceIdSchema.parse("template.steering.architecture") };
    const adopted = revision("adopted", { provenance: { kind: "project", project: "acme", authorship: "adopted", adopted_from: { kind: "steering-revision", revision: source } } });
    const result = resolveSteering(request([adopted]));
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.included_resources[0]!.revision.provenance).toEqual(adopted.provenance);
  });
  test("native provenance cannot claim an external adoption from another native resource", () => {
    const parent = revision("root");
    const adopted = revision("adopted", { provenance: { kind: "project", project: "acme", authorship: "adopted", adopted_from: { kind: "steering-revision", revision: parent.identity } } });
    expect(codes(request([adopted]))).toContain("steering-source-invalid");
  });
  test("invalid logical scope syntax has a dedicated diagnostic", () => {
    const root = revision("root");
    expect(codes({ ...request([root]), catalog: [{ ...root, scope: { kind: "path", selectors: [{ kind: "tree", path: "../outside" }] } }] })).toContain("steering-scope-invalid");
  });
  test("external content cannot supply native override authority", () => {
    const parent = revision("root"), child = scoped(parent, "child", tree("src/auth"), { composition: override(parent) });
    const external = { ...child, identity: { ...child.identity, id: "interop.steering.auth" }, layer: "interoperability",
      provenance: { kind: "interoperability", source: { kind: "agents-md", source_identity: "logical-source", hash: hash(), adapter: { id: "profile_adapter", revision: "rev_one", hash: hash() } } } };
    expect(codes({ ...request([parent]), catalog: [parent, external] })).toContain("steering-source-invalid");
  });
  test("a selected parent's non-applicability cannot be bypassed by a child", () => {
    const parent = revision("root", { inclusion: { availability: "required", selector: { kind: "phase", phases: ["verification"] } } });
    const child = scoped(parent);
    expect(codes(request([parent, child]))).toContain("steering-parent-missing");
  });
  test("unrelated inactive old revisions can be cataloged but not simultaneously applied", () => {
    const first = revision("root"), second = { ...first, identity: { ...first.identity, revision: steeringRevisionIdSchema.parse("2") } };
    const input = request([first, second], { selections: [{ resource: second.identity, inclusion: second.inclusion }] });
    expect(resolveSteering(input).status).toBe("resolved");
    expect(codes(request([first, second]))).toContain("steering-duplicate-resource");
  });
  test("malformed and unknown-version inputs return invalid-input", () => {
    for (const input of [null, {}, { ...request([]), policy: "aira.dev/steering-policy/conservative/v2" },
      { ...request([]), catalog: [{ invalid: true }] }, { ...request([]), action: { phase: "unknown" } }])
      expect(resolveSteering(input).status).toBe("invalid-input");
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(codes(cycle)).toContain("steering-input-limit");
  });
  test("unsupported required contracts fail closed, optional resources can be omitted", () => {
    const root = revision("root", { compatibility: { resolver: "aira.dev/steering-resolution/v1", required_schemas: ["aira.dev/example/v1"] } });
    expect(codes(request([root]))).toContain("steering-compatibility-invalid");
    expect(resolveSteering(request([root], { supported_contracts: ["aira.dev/example/v1"] })).status).toBe("resolved");
    const optional = { ...root, inclusion: { ...root.inclusion, availability: "optional" as const } };
    const result = resolveSteering(request([optional]));
    expect(result.status).toBe("resolved");
    expect(result.diagnostics[0]?.severity).toBe("warning");
  });
});
