import { describe, expect, test } from "bun:test";
import { behavioralAssetReferenceSchema } from "../../src/builtins/assets";
import {
  sourceReferenceForRevision,
  steeringCustomCategorySchema,
  steeringResourceIdSchema,
  steeringResourceRevisionSchema,
  steeringRevisionIdSchema,
  steeringRuleIdSchema,
  steeringRuleSchema,
  steeringSemanticKeySchema,
  validateImmutableSteeringRevision,
  validateSteeringAdoption,
  validateSteeringProvenance,
  validateSteeringResourceRevision,
  validateSteeringRevisionHistory,
  validateSteeringRuleEvolution,
  type SteeringResourceRevision,
  type SteeringRule,
} from "../../src/steering";
import { created, hash, profile, resource, rule } from "./fixtures";

function templateResource() {
  return resource({
    identity: { id: steeringResourceIdSchema.parse("template.steering.architecture"), revision: steeringRevisionIdSchema.parse("1"), hash: hash() },
    layer: "template",
    provenance: { kind: "aira-template", publisher: "aira", published_content_hash: hash() },
    metadata: { title: "Aira architecture template", labels: ["template"] },
  });
}

function interoperabilityResource() {
  return resource({
    identity: { id: steeringResourceIdSchema.parse("interop.steering.agents-md"), revision: steeringRevisionIdSchema.parse("1"), hash: hash() },
    kind: "custom",
    custom_kind: steeringCustomCategorySchema.parse("agents-guidance"),
    layer: "interoperability",
    provenance: {
      kind: "interoperability",
      source: { kind: "agents-md", source_identity: "AGENTS.md", hash: hash(), adapter: profile() },
    },
    rules: [],
    metadata: { title: "Imported AGENTS guidance", labels: ["interoperability"] },
  });
}

describe("INV-STEER-006/009: provenance and adoption", () => {
  test("project Steering records project ownership", () => {
    const revision = resource();
    expect(revision.provenance).toEqual({ kind: "project", project: "acme", authorship: "authored" });
    expect(validateSteeringProvenance(revision.provenance)).toEqual([]);
  });

  test("an Aira template remains a non-project source with matching published bytes", () => {
    const template = templateResource();
    expect(template.provenance.kind).toBe("aira-template");
    expect(String(template.identity.id)).toBe("template.steering.architecture");
  });

  test("template bytes cannot be changed in place or relabeled as project content", () => {
    const template = templateResource();
    const changed = {
      ...template,
      identity: { ...template.identity, hash: hash(2) },
      content: { ...template.content, hash: hash(2) },
    };
    expect(steeringResourceRevisionSchema.safeParse(changed).success).toBe(false);
    expect(validateImmutableSteeringRevision(template, changed).map((issue) => issue.code))
      .toEqual(["immutable-steering-revision-overwrite"]);
    expect(steeringResourceRevisionSchema.safeParse({ ...template, identity: { ...template.identity, id: "steering.architecture" } }).success).toBe(false);
  });

  test("template adoption creates an exact provenance edge and project identity", () => {
    const source = templateResource();
    const adopted = resource({
      provenance: {
        kind: "project",
        project: "acme",
        authorship: "adopted",
        adopted_from: sourceReferenceForRevision(source.identity),
      },
    });
    expect(validateSteeringAdoption(source, adopted)).toEqual([]);
    expect(String(adopted.identity.id)).toBe("steering.architecture");
    expect(adopted.provenance.kind).toBe("project");
  });

  test("project adoption cannot omit or forge its source", () => {
    const source = templateResource();
    const authored = resource();
    expect(validateSteeringAdoption(source, authored).map((issue) => issue.code))
      .toEqual(["steering-adoption-provenance-mismatch"]);
    expect(validateSteeringProvenance({ kind: "project", project: "acme", authorship: "adopted" }).map((issue) => issue.code))
      .toContain("invalid-project-steering-adoption");
    expect(validateSteeringProvenance({ kind: "project", project: "acme", authorship: "authored", adopted_from: sourceReferenceForRevision(source.identity) }).map((issue) => issue.code))
      .toContain("invalid-project-steering-adoption");
  });

  test("AGENTS.md interoperability retains exact source and adapter provenance", () => {
    const revision = interoperabilityResource();
    expect(revision.provenance.kind).toBe("interoperability");
    if (revision.provenance.kind === "interoperability") {
      expect(revision.provenance.source.hash).toBe(revision.content.hash);
      expect(revision.provenance.source.adapter).toEqual(profile());
    }
    expect(steeringResourceRevisionSchema.safeParse({ ...revision, content: { ...revision.content, hash: hash(2) }, identity: { ...revision.identity, hash: hash(2) } }).success).toBe(false);
  });

  test("other imports distinguish exact and explicitly transformed content", () => {
    const source = { kind: "imported" as const, contract: "example.dev/project-guidance/v1", source_identity: "corp-standard", source_revision: "2025.1", hash: hash() };
    const exact = resource({
      identity: { id: steeringResourceIdSchema.parse("imported.steering.company-standards"), revision: steeringRevisionIdSchema.parse("1"), hash: hash() },
      kind: "custom",
      custom_kind: steeringCustomCategorySchema.parse("company-standards"),
      layer: "imported",
      provenance: { kind: "imported", source, importer: profile(), transformation: "exact" },
      rules: [],
    });
    expect(exact.provenance.kind).toBe("imported");
    expect(steeringResourceRevisionSchema.safeParse({ ...exact, identity: { ...exact.identity, hash: hash(2) }, content: { ...exact.content, hash: hash(2) } }).success).toBe(false);
    expect(steeringResourceRevisionSchema.safeParse({ ...exact, identity: { ...exact.identity, hash: hash(2) }, content: { ...exact.content, hash: hash(2) }, provenance: { ...exact.provenance, transformation: "transformed" } }).success).toBe(true);
  });
});

describe("structured Steering rules", () => {
  test("a rule has stable ID, semantic key, authority, scope hooks, rationale, and source", () => {
    const parsed = rule({
      scope: { kind: "phase", phases: ["architecture", "review"] },
      inclusion: { availability: "required", selector: { kind: "spec-kind", kinds: [{ kind: "feature" }] } },
    });
    expect(String(parsed.id)).toBe("rule.architecture.repository-access");
    expect(String(parsed.semantics.key)).toBe("topic.architecture.data-access");
    expect(parsed.source?.content_hash).toBe(hash());
    expect(parsed.scope?.kind).toBe("phase");
  });

  test("deprecated status preserves a structured historical rule", () => {
    expect(rule({ status: "deprecated" }).status).toBe("deprecated");
    expect(steeringRuleSchema.safeParse({ ...rule(), status: "removed" }).success).toBe(false);
  });

  test("rule metadata is strict and malformed identities or locations fail", () => {
    expect(steeringRuleSchema.safeParse({ ...rule(), id: "R1" }).success).toBe(false);
    expect(steeringRuleSchema.safeParse({ ...rule(), semantics: { ...rule().semantics, key: "architecture/data" } }).success).toBe(false);
    expect(steeringRuleSchema.safeParse({ ...rule(), source: { content_hash: hash(), location: { kind: "line-range", start: 8, end: 3 } } }).success).toBe(false);
    expect(steeringRuleSchema.safeParse({ ...rule(), prompt: "must comply" }).success).toBe(false);
  });

  test("rule order and source-content binding are deterministic", () => {
    const first = rule({
      id: steeringRuleIdSchema.parse("rule.architecture.a"),
      semantics: { ...rule().semantics, key: steeringSemanticKeySchema.parse("topic.architecture.a") },
    });
    const second = rule({
      id: steeringRuleIdSchema.parse("rule.architecture.b"),
      semantics: { ...rule().semantics, key: steeringSemanticKeySchema.parse("topic.architecture.b") },
    });
    expect(resource({ rules: [first, second] }).rules.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(steeringResourceRevisionSchema.safeParse({ ...resource(), rules: [second, first] }).success).toBe(false);
    expect(steeringResourceRevisionSchema.safeParse({ ...resource(), rules: [{ ...rule(), source: { content_hash: hash(2), location: { kind: "document" } } }] }).success).toBe(false);
  });
});

describe("INV-STEER-001/002/008: revision and exact content identity", () => {
  test("resource revision pins exact raw content hash and byte metadata", () => {
    const revision = resource();
    expect(revision.content_encoding).toBe("aira.dev/steering-bytes/raw/v1");
    expect(revision.identity.hash).toBe(revision.content.hash);
    expect(revision.content.bytes).toBe(101);
    expect("markdown" in revision).toBe(false);
  });

  test("unknown persisted, byte, and resolver contract versions fail closed", () => {
    const revision = resource();
    expect(steeringResourceRevisionSchema.safeParse({ ...revision, schema: "aira.dev/steering-resource/v2" }).success).toBe(false);
    expect(steeringResourceRevisionSchema.safeParse({ ...revision, content_encoding: "aira.dev/steering-bytes/normalized/v1" }).success).toBe(false);
    expect(steeringResourceRevisionSchema.safeParse({ ...revision, compatibility: { ...revision.compatibility, resolver: "aira.dev/steering-resolution/v2" } }).success).toBe(false);
  });

  test("missing or mismatched content identity fails with stable issues", () => {
    const revision = resource();
    const mismatch = { ...revision, content: { ...revision.content, hash: hash(2) } };
    expect(steeringResourceRevisionSchema.safeParse(mismatch).success).toBe(false);
    expect(validateSteeringResourceRevision(mismatch).map((issue) => issue.code)).toContain("steering-content-identity-mismatch");
    const { content: _content, ...missing } = revision;
    expect(validateSteeringResourceRevision(missing).length).toBeGreaterThan(0);
  });

  test("same immutable revision cannot change any envelope field", () => {
    const previous = resource();
    const changed = { ...previous, metadata: { ...previous.metadata, title: "Changed title" } };
    expect(validateImmutableSteeringRevision(previous, changed)).toEqual([
      { code: "immutable-steering-revision-overwrite", subject: "steering.architecture@1" },
    ]);
    const next = resource({ identity: { ...previous.identity, revision: steeringRevisionIdSchema.parse("2") }, supersedes: previous.identity });
    expect(validateImmutableSteeringRevision(previous, next)).toEqual([]);
  });

  test("predecessor is exact, same-resource, and strictly earlier", () => {
    const first = resource();
    const second = resource({ identity: { ...first.identity, revision: steeringRevisionIdSchema.parse("2") }, supersedes: first.identity });
    expect(second.supersedes).toEqual(first.identity);
    expect(steeringResourceRevisionSchema.safeParse({ ...first, supersedes: { ...first.identity, revision: "2" } }).success).toBe(false);
    expect(steeringResourceRevisionSchema.safeParse({ ...second, supersedes: { ...first.identity, id: "steering.security" } }).success).toBe(false);
    expect(steeringResourceRevisionSchema.safeParse({ ...second, identity: { ...second.identity, revision: "latest" } }).success).toBe(false);
  });

  test("rule evolution requires tombstones and prevents semantic-key reuse", () => {
    const first = resource();
    const retiredRule = rule({ status: "deprecated" });
    const second = resource({
      identity: { ...first.identity, revision: steeringRevisionIdSchema.parse("2") },
      supersedes: first.identity,
      rules: [retiredRule],
    });
    expect(validateSteeringRuleEvolution(first, second)).toEqual([]);

    const removed = resource({
      identity: { ...first.identity, revision: steeringRevisionIdSchema.parse("2") },
      supersedes: first.identity,
      rules: [],
    });
    expect(validateSteeringRuleEvolution(first, removed).map((issue) => issue.code))
      .toContain("steering-rule-retirement-missing");

    const reactivated = resource({
      identity: { ...first.identity, revision: steeringRevisionIdSchema.parse("3") },
      supersedes: second.identity,
    });
    expect(validateSteeringRuleEvolution(second, reactivated).map((issue) => issue.code))
      .toContain("steering-rule-reused");

    const reassignedRule = rule({ semantics: { ...rule().semantics, key: steeringSemanticKeySchema.parse("topic.architecture.other") } });
    const reassigned = resource({
      identity: { ...first.identity, revision: steeringRevisionIdSchema.parse("2") },
      supersedes: first.identity,
      rules: [reassignedRule],
    });
    expect(validateSteeringRuleEvolution(first, reassigned).map((issue) => issue.code))
      .toContain("steering-rule-identity-reassigned");
  });

  test("history rejects duplicate revisions, missing predecessors, branches, and reassignment", () => {
    const first = resource();
    const second = resource({ identity: { ...first.identity, revision: steeringRevisionIdSchema.parse("2") }, supersedes: first.identity });
    expect(validateSteeringRevisionHistory([first, second])).toEqual([]);
    expect(validateSteeringRevisionHistory([first, first]).map((issue) => issue.code)).toContain("duplicate-steering-revision");
    expect(validateSteeringRevisionHistory([second]).map((issue) => issue.code)).toContain("steering-predecessor-unavailable");
    const branch = resource({ identity: { ...first.identity, revision: steeringRevisionIdSchema.parse("3") }, supersedes: first.identity });
    expect(validateSteeringRevisionHistory([first, second, branch]).map((issue) => issue.code)).toContain("steering-revision-branch");

    const custom1 = resource({
      identity: { id: steeringResourceIdSchema.parse("project.steering.data"), revision: steeringRevisionIdSchema.parse("1"), hash: hash() },
      kind: "custom",
      custom_kind: steeringCustomCategorySchema.parse("database"),
      rules: [],
    });
    const custom2 = resource({
      ...custom1,
      identity: { ...custom1.identity, revision: steeringRevisionIdSchema.parse("2") },
      custom_kind: steeringCustomCategorySchema.parse("analytics"),
      supersedes: custom1.identity,
    });
    expect(validateSteeringRevisionHistory([custom1, custom2]).map((issue) => issue.code)).toContain("steering-logical-identity-reassigned");
  });

  test("generated Steering cannot omit exact behavioral attribution", () => {
    const generated = {
      ...resource(),
      created: { ...created, by: { kind: "model", id: "model-1", implementation: "test-model" } },
      behavioral_assets: [],
    };
    expect(steeringResourceRevisionSchema.safeParse(generated).success).toBe(false);
    expect(validateSteeringResourceRevision(generated).map((issue) => issue.code))
      .toContain("generated-steering-behavioral-attribution-required");
  });

  test("exact behavioral assets can attribute generated Steering without becoming its content", () => {
    const asset = behavioralAssetReferenceSchema.parse({
      id: "builtin.steering.generate",
      revision: "1",
      hash: hash(3),
      provenance: { kind: "aira-builtin", publisher: "aira" },
      kind: "prompt-profile",
    });
    const revision = resource({
      created: { ...created, by: { kind: "model", id: "model-1", implementation: "test-model" } },
      behavioral_assets: [asset],
    });
    expect(revision.behavioral_assets[0]?.hash).toBe(hash(3));
    expect(revision.content.hash).toBe(hash());
  });
});

describe("future hierarchy representation without resolution", () => {
  test("a scoped resource can name exact parents and explicit override targets", () => {
    const parent = resource();
    const scoped = resource({
      identity: { id: steeringResourceIdSchema.parse("project.steering.api-conventions"), revision: steeringRevisionIdSchema.parse("1"), hash: hash() },
      kind: "custom",
      custom_kind: steeringCustomCategorySchema.parse("api-conventions"),
      layer: "project-scoped",
      scope: { kind: "path", selectors: [{ kind: "tree", path: "src/api" }] },
      composition: {
        parents: [parent.identity],
        overrides: [{
          target: { resource: parent.identity, rule: parent.rules[0]!.id },
          mode: "specialize",
          rationale: "The API subtree has a narrower adapter boundary.",
        }],
      },
    });
    expect(scoped.composition.parents).toEqual([parent.identity]);
    expect(scoped.composition.overrides[0]?.target.rule).toBe(parent.rules[0]!.id);
  });

  test("self inheritance, self override, and duplicate targets are structurally rejected", () => {
    const base = resource();
    expect(steeringResourceRevisionSchema.safeParse({ ...base, composition: { parents: [base.identity], overrides: [] } }).success).toBe(false);
    const override = { target: { resource: base.identity }, mode: "replace", rationale: "No" } as const;
    expect(steeringResourceRevisionSchema.safeParse({ ...base, composition: { parents: [], overrides: [override] } }).success).toBe(false);
    const other = { ...base.identity, id: steeringResourceIdSchema.parse("steering.security") };
    const duplicate = { target: { resource: other }, mode: "strengthen", rationale: "Tighten" } as const;
    expect(steeringResourceRevisionSchema.safeParse({ ...base, composition: { parents: [], overrides: [duplicate, duplicate] } }).success).toBe(false);
  });
});

if (false) {
  const revision: SteeringResourceRevision = resource();
  const structuredRule: SteeringRule = rule();
  // @ts-expect-error Steering revision identities are deeply readonly.
  revision.identity.revision = steeringRevisionIdSchema.parse("2");
  // @ts-expect-error Steering rule inventories are deeply readonly.
  revision.rules.push(structuredRule);
  // @ts-expect-error Rule enforcement linkage is deeply readonly.
  structuredRule.enforcement.push();
  void [revision, structuredRule];
}
