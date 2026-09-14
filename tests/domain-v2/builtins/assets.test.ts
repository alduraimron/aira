import { describe, expect, test } from "bun:test";
import { builtinAssetIdSchema, builtinAssetRevisionIdSchema, builtinBundleIdSchema, builtinBundleRevisionIdSchema } from "../../../src/builtins/identity";
import { behavioralAssetReferenceSchema, behavioralAssetRevisionSchema, validateAssetRevisionHistory, validateImmutableAssetRevision, type BehavioralAssetRevision } from "../../../src/builtins/assets";
import { behavioralAssetPinSchema, behavioralPinsSchema, behavioralRoleSchema, type BehavioralAssetPin } from "../../../src/builtins/roles";
import { builtinBundleManifestSchema, validateImmutableBuiltinBundle } from "../../../src/builtins/bundle";
import { behavioralAssetCatalogSchema, validateBuiltinBundleContents, validatePinnedAssets } from "../../../src/builtins/catalog";
import { available, hash, library, pin, revision } from "./fixtures";

describe("INV-BUILTIN-001: logical identity and immutable revision/hash", () => {
  test.each(["builtin.requirements.generate", "builtin.spec.feature", "project.acme.requirements-prompt", "builtin.a-b.c2"])("valid path-independent asset %s", (id) => expect(String(builtinAssetIdSchema.parse(id))).toBe(id));
  test.each(["requirements.md", "./builtin.x", "/builtin.x", "builtin/requirements", "builtin..x", "builtin.X", "builtin.x@1", "project.x", "project..x", "builtin.x ", "builtin.x\\y", "builtin.x\n"])("reject invalid asset %s", (id) => expect(builtinAssetIdSchema.safeParse(id).success).toBe(false));
  test.each(["1", "2", "18446744073709551615"])("exact immutable revision %s", (r) => {
    expect(String(builtinAssetRevisionIdSchema.parse(r))).toBe(r); expect(String(builtinBundleRevisionIdSchema.parse(r))).toBe(r);
  });
  test.each(["latest", "current", "default", "whatever-ships-now", "v1", "1.0.0", "0", "01", "-1", "1e3", "18446744073709551616", "", 1])("mutable/invalid revision %s fails without throwing", (r) => {
    expect(builtinAssetRevisionIdSchema.safeParse(r).success).toBe(false); expect(behavioralAssetPinSchema.safeParse({ ...pin(), asset: { ...pin().asset, revision: r } }).success).toBe(false);
  });
  test("bundle identity has a logical, branded namespace", () => {
    expect(String(builtinBundleIdSchema.parse("bundle.aira.core"))).toBe("bundle.aira.core");
    for (const id of ["builtin.requirements.generate", "bundle/aira/core", "package.json", "bundle.aira."]) expect(builtinBundleIdSchema.safeParse(id).success).toBe(false);
  });
  test("one logical asset supports multiple revisions and a checked predecessor", () => {
    const r1 = revision(), r2 = behavioralAssetRevisionSchema.parse({ ...revision(pin("requirements-generation", "2")), supersedes: r1.identity });
    expect(validateAssetRevisionHistory([r2, r1])).toEqual([]); expect(validateImmutableAssetRevision(r1, r2)).toEqual([]);
    expect(validateAssetRevisionHistory([r1, r1]).map((i) => i.code)).toContain("duplicate-asset-revision");
    expect(validateAssetRevisionHistory([r2]).map((i) => i.code)).toContain("asset-predecessor-unavailable");
    expect(behavioralAssetRevisionSchema.safeParse({ ...r1, supersedes: r2.identity }).success).toBe(false);
    expect(behavioralAssetRevisionSchema.safeParse({ ...r2, supersedes: pin("architecture-generation").asset }).success).toBe(false);
  });
  test.each(["hash", "metadata", "compatibility", "encoding"])("same revision cannot overwrite %s", (field) => {
    const r = revision();
    const changed = field === "hash" ? { ...r, identity: { ...r.identity, hash: hash(9) } } : field === "metadata" ? { ...r, metadata: { ...r.metadata, title: "Changed" } } :
      field === "compatibility" ? { ...r, compatibility: { ...r.compatibility, required_schemas: ["aira.dev/spec/v99"] } } : { ...r, content_encoding: "future" };
    expect(validateImmutableAssetRevision(r, changed as BehavioralAssetRevision).map((i) => i.code)).toContain("immutable-asset-revision-overwrite");
    expect(validateImmutableAssetRevision(r, structuredClone(r))).toEqual([]);
  });
  test("invalid predecessor revisions fail schema validation without numeric conversion exceptions", () => {
    const r = revision();
    expect(behavioralAssetRevisionSchema.safeParse({ ...r, identity: { ...r.identity, revision: "latest" }, supersedes: r.identity }).success).toBe(false);
    expect(behavioralAssetRevisionSchema.safeParse({ ...r, supersedes: { ...r.identity, revision: "latest" } }).success).toBe(false);
  });
  test("all ten kinds are closed and reuse typed domain references", () => {
    const f = library();
    expect(new Set(f.catalog.assets.map((a) => a.revision.identity.kind)).size).toBe(10);
    for (const a of f.catalog.assets) expect(behavioralAssetRevisionSchema.safeParse(a.revision).success).toBe(true);
    expect(behavioralAssetReferenceSchema.safeParse({ ...pin().asset, kind: "arbitrary-plugin" }).success).toBe(false);
    const policy = pin("capability-profile");
    expect(behavioralAssetReferenceSchema.safeParse({ ...policy.asset, policy: { id: "profile_wrong", revision: "rev_one", hash: hash(1) } }).success).toBe(false);
    expect(behavioralAssetReferenceSchema.safeParse({ ...pin().asset, profile: { id: "profile_extra", revision: "rev_one", hash: hash(1) } }).success).toBe(false);
  });
  test("one established lowercase SHA-256 format, no inline prompt content or implicit normalization", () => {
    for (const h of ["abc", "SHA256:" + "a".repeat(64), "sha256:" + "A".repeat(64), "sha256:" + "a".repeat(63)])
      expect(behavioralAssetPinSchema.safeParse({ ...pin(), asset: { ...pin().asset, hash: h } }).success).toBe(false);
    expect(behavioralAssetRevisionSchema.safeParse({ ...revision(), markdown: "not domain content" }).success).toBe(false);
    expect(behavioralAssetRevisionSchema.safeParse({ ...revision(), content_encoding: "normalize-whitespace" }).success).toBe(false);
    expect(behavioralAssetRevisionSchema.safeParse({ ...revision(), schema: "aira.dev/behavioral-asset/v2" }).success).toBe(false);
  });
});

describe("INV-BUILTIN-004: explicit origin, not logical role", () => {
  test("project override keeps the same role but not the builtin identity or provenance", () => {
    const builtin = pin(), project = pin("requirements-generation", "3", "my-requirements", "acme");
    expect(project.role).toBe(builtin.role); expect(project.asset.provenance).toEqual({ kind: "project", project: "acme" });
    expect(builtin.asset.provenance).toEqual({ kind: "aira-builtin", publisher: "aira" });
    expect(behavioralAssetPinSchema.safeParse({ ...builtin, asset: { ...builtin.asset, provenance: project.asset.provenance } }).success).toBe(false);
    expect(behavioralAssetPinSchema.safeParse({ ...project, asset: { ...project.asset, provenance: builtin.asset.provenance } }).success).toBe(false);
    expect(behavioralAssetPinSchema.safeParse({ ...project, asset: { ...project.asset, provenance: { kind: "project", project: "other" } } }).success).toBe(false);
    expect(behavioralAssetPinSchema.safeParse({ ...project, bundle: library().bundle.identity }).success).toBe(false);
  });
  test("claims cannot replace the exact trusted published revision or observed hash", () => {
    const f = library(), p = f.defaults[0]!;
    const forged = { ...p, asset: { ...p.asset, hash: hash(1) } };
    expect(validatePinnedAssets([forged], f.catalog, f.environment).map((i) => i.code)).toContain("pinned-asset-identity-mismatch");
    const observed = structuredClone(f.catalog); observed.assets[0]!.verified_content_hash = hash(2);
    expect(validatePinnedAssets([p], observed, f.environment).map((i) => i.code)).toContain("pinned-asset-hash-mismatch");
    // Selecting the actual unmodified published builtin is not a project override.
    expect(validatePinnedAssets([p], f.catalog, f.environment)).toEqual([]);
  });
  test("unknown provenance requires schema evolution", () => expect(behavioralAssetPinSchema.safeParse({ ...pin(), asset: { ...pin().asset, provenance: { kind: "marketplace" } } }).success).toBe(false));
});

describe("INV-BUILTIN-002/003: bundle manifests and exact pins", () => {
  test("valid manifest contains exact immutable asset revisions and profile defaults", () => {
    const { bundle } = library(); expect(builtinBundleManifestSchema.parse(bundle)).toEqual(bundle);
    expect(bundle.spec_kinds.map((k) => k.kind)).toEqual(["feature", "bugfix", "refactor", "migration", "custom"]);
  });
  test("whole-bundle publication verifies available members, nested selections and typed profile mappings", () => {
    const f = library(); expect(validateBuiltinBundleContents(f.bundle, f.catalog, f.environment)).toEqual([]);
    f.catalog.assets = f.catalog.assets.filter((a) => a.revision.identity.id !== f.defaults[0]!.asset.id);
    expect(validateBuiltinBundleContents(f.bundle, f.catalog, f.environment).map((i) => i.code)).toContain("pinned-asset-unavailable");
    const g = library(), p = pin("requirements-analysis", "2"); g.catalog.assets.push(available(p));
    const configuration = g.catalog.assets.find((a) => a.configuration?.schema === "aira.dev/spec-kind-profile/v2")!.configuration!;
    configuration.selections = [p];
    expect(validateBuiltinBundleContents(g.bundle, g.catalog, g.environment).map((i) => i.code)).toContain("bundle-profile-selection-not-contained");
    const h = library(); h.bundle.spec_kinds[0]!.asset = h.kinds[1]!.asset;
    expect(validateBuiltinBundleContents(h.bundle, h.catalog, h.environment).map((i) => i.code)).toContain("bundle-kind-profile-mismatch");
  });
  test("multiple revisions in one bundle are legal; duplicate revision is not", () => {
    const { bundle } = library();
    expect(builtinBundleManifestSchema.safeParse({ ...bundle, assets: [...bundle.assets, pin("requirements-generation", "2").asset] }).success).toBe(true);
    expect(builtinBundleManifestSchema.safeParse({ ...bundle, assets: [...bundle.assets, bundle.assets[0]] }).success).toBe(false);
  });
  test.each(["hash", "revision", "missing", "schema", "duplicate-role", "duplicate-kind", "duplicate-mode", "project"])("bundle rejects %s inconsistency", (change) => {
    const b = structuredClone(library().bundle);
    const candidate = change === "hash" ? { ...b, defaults: [{ ...b.defaults[0]!, asset: { ...b.defaults[0]!.asset, hash: hash(9) } }] } :
      change === "revision" ? { ...b, defaults: [{ ...b.defaults[0]!, asset: { ...b.defaults[0]!.asset, revision: "99" } }] } :
      change === "missing" ? { ...b, assets: b.assets.slice(1) } : change === "schema" ? { ...b, schema: "aira.dev/builtin-bundle/v99" } :
      change === "duplicate-role" ? { ...b, defaults: [...b.defaults, b.defaults[0]] } : change === "duplicate-kind" ? { ...b, spec_kinds: [...b.spec_kinds, b.spec_kinds[0]] } :
      change === "duplicate-mode" ? { ...b, modes: [...b.modes, b.modes[0]] } : { ...b, assets: [...b.assets, pin("implementation", "1", "impl", "acme").asset] };
    expect(builtinBundleManifestSchema.safeParse(candidate).success).toBe(false);
  });
  test("changing defaults requires a new immutable bundle revision", () => {
    const b = library().bundle;
    expect(validateImmutableBuiltinBundle(b, { ...b, defaults: b.defaults.slice(1) }).map((i) => i.code)).toContain("immutable-bundle-overwrite");
    expect(validateImmutableBuiltinBundle(b, { ...b, identity: { ...b.identity, revision: builtinBundleRevisionIdSchema.parse("2") }, defaults: b.defaults.slice(1) })).toEqual([]);
  });
  test("pin set rejects duplicate slots except distinct capability restriction layers", () => {
    expect(behavioralPinsSchema.safeParse([pin(), pin("requirements-generation", "2")]).success).toBe(false);
    expect(behavioralPinsSchema.safeParse([pin("capability-profile"), pin("capability-profile", "2")]).success).toBe(true);
    expect(behavioralPinsSchema.safeParse([pin("capability-profile"), pin("capability-profile")]).success).toBe(false);
    expect(behavioralRoleSchema.safeParse("whatever-role").success).toBe(false);
    expect(behavioralAssetPinSchema.safeParse({ ...pin(), role: "requirements-analysis" }).success).toBe(false);
  });
  test("catalog rejects duplicate/reassigned identity independent of enumeration order", () => {
    const { catalog } = library();
    expect(behavioralAssetCatalogSchema.safeParse({ ...catalog, assets: [...catalog.assets, catalog.assets[0]] }).success).toBe(false);
    const old = available(pin()), changed = available(behavioralAssetPinSchema.parse({ ...pin("requirements-analysis", "2"), asset: { ...pin("requirements-analysis", "2").asset, id: old.revision.identity.id } }));
    expect(behavioralAssetCatalogSchema.safeParse({ assets: [old, changed], bundles: [] }).success).toBe(false);
  });
  test("missing pinned asset, bundle, membership, and bundle bytes fail closed", () => {
    const f = library(), p = { ...f.defaults[0]!, bundle: f.bundle.identity };
    expect(validatePinnedAssets([pin("clarification", "99")], f.catalog, f.environment).map((i) => i.code)).toContain("pinned-asset-unavailable");
    expect(validatePinnedAssets([p], { ...f.catalog, bundles: [] }, f.environment).map((i) => i.code)).toContain("pinned-bundle-unavailable");
    const changed = structuredClone(f.catalog); changed.bundles[0]!.verified_content_hash = hash(4);
    expect(validatePinnedAssets([p], changed, f.environment).map((i) => i.code)).toContain("pinned-bundle-hash-mismatch");
    const outsider = pin("clarification", "2"); f.catalog.assets.push(available(outsider));
    expect(validatePinnedAssets([{ ...outsider, bundle: f.bundle.identity }], f.catalog, f.environment).map((i) => i.code)).toContain("pinned-bundle-asset-mismatch");
  });
});

if (false) {
  // @ts-expect-error a path/string is not a validated asset identity
  const id: import("../../../src/builtins/identity").BuiltinAssetId = "builtin.test.x";
  // @ts-expect-error bundle revisions are not asset revisions
  const r: import("../../../src/builtins/identity").BuiltinAssetRevisionId = builtinBundleRevisionIdSchema.parse("1");
  const p: BehavioralAssetPin = pin();
  // @ts-expect-error execution pins are deeply readonly
  p.asset.hash = hash(2);
  const asset: BehavioralAssetRevision = revision();
  // @ts-expect-error published metadata is deeply readonly
  asset.metadata.labels.push("rewrite");
  void [id, r, p, asset];
}
