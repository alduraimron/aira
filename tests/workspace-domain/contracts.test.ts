import { describe, expect, test } from "bun:test";
import { hashCanonical } from "../../src/canonical-json";
import { workspaceIdSchema } from "../../src/spec/domain/ids";
import { controlProjectIdSchema, projectIdentitySchema, repositoryIdentitySchema, workspaceIncarnationSchema,
  workspaceFenceEpochSchema, workspaceProviderIdSchema, workspaceProviderVersionSchema, sourceObservationIdSchema,
  workspaceFingerprintIdSchema, workspaceClaimIdSchema } from "../../src/workspace/ids";
import { createWorkspaceProviderCapabilities, workspaceProviderCapabilitiesSchema } from "../../src/workspace/provider";
import { createSourceObservation, sourceObservationSchema, sourceDecisionIssues } from "../../src/workspace/source";
import { createWorkspaceHandle, validateWorkspaceHandle, workspaceHandleV2Schema, workspaceClaimReferenceSchema } from "../../src/workspace/handle";
import { createWorkspaceFingerprint, defaultWorkspaceFingerprintPolicy, createWorkspaceFingerprintPolicy, fingerprintHandleIssues,
  workspaceFingerprintV2Schema, workspacePathManifestSchema, type WorkspaceManifestEntry } from "../../src/workspace/fingerprint-v2";
import { compareWorkspaceFingerprints, workspaceFingerprintApplicable, compareSourceObservations } from "../../src/workspace/comparison";
import { hash, audit, provider, policy, caps, source, handle, fingerprint, entry, overlay, gitBase } from "./fixtures";

const fails = (fn: () => unknown, code: string) => {
  try { fn(); throw new Error("expected rejection"); }
  catch (error) { expect((error as { code?: string }).code).toBe(code); }
};
type Mutable<T> = T extends string | number | boolean | null | undefined ? T :
  T extends readonly (infer V)[] ? Mutable<V>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const mutable = <T>(x: T): Mutable<T> => structuredClone(x) as Mutable<T>;
const gitSource = () => {
  const value = source().subject.source;
  if (value.kind !== "git") throw new Error("expected Git fixture");
  return value;
};

describe("06-1 identities and legacy versions", () => {
  test("distinct branded identities, canonical positive u64, no path-derived identity", () => {
    for (const [schema, good, bad] of [
      [workspaceIdSchema, "workspace_w1", "/project/workspace_w1"],
      [controlProjectIdSchema, "control_project_w1", "project_w1"],
      [projectIdentitySchema, "project_w1", "workspace_w1"],
      [repositoryIdentitySchema, "repository_w1", "commit_w1"],
      [workspaceProviderIdSchema, "provider_w1", "Provider_W1"],
      [workspaceClaimIdSchema, "workspace_claim_w1", "claim_w1"],
      [workspaceIncarnationSchema, "18446744073709551615", "18446744073709551616"],
      [workspaceFenceEpochSchema, "2", "02"],
      [workspaceProviderVersionSchema, "1.2.3-pinned", "latest"],
      [sourceObservationIdSchema, `source_observation_${"a".repeat(64)}`, "source_observation_latest"],
      [workspaceFingerprintIdSchema, `workspace_fingerprint_${"b".repeat(64)}`, "workspace_fingerprint_latest"],
    ] as const) { expect(schema.safeParse(good).success).toBe(true); expect(schema.safeParse(bad).success).toBe(false); }
    expect(workspaceIncarnationSchema.safeParse("0").success).toBe(true);
    expect(workspaceFenceEpochSchema.safeParse("18446744073709551616").success).toBe(false);
    expect(workspaceClaimReferenceSchema.safeParse({ claim: "workspace_claim_one", workspace_id: "workspace_one",
      incarnation: "1", epoch: "2" }).success).toBe(true);
  });
  test("legacy v1 remains historical, new contracts do not guess missing fields", () => {
    for (const [schema, old] of [[workspaceHandleV2Schema, "aira.dev/workspace-handle/v1"],
      [workspaceFingerprintV2Schema, "aira.dev/workspace-fingerprint/v1"],
      [sourceObservationSchema, "aira.dev/workspace-source-observation/v9"]] as const)
      expect(schema.safeParse({ schema: old }).success).toBe(false);
    expect(workspaceHandleV2Schema.safeParse({ ...handle(), schema: "aira.dev/workspace-handle/v3" }).success).toBe(false);
    expect(workspaceFingerprintV2Schema.safeParse({ ...fingerprint(), schema: "aira.dev/workspace-fingerprint/v3" }).success).toBe(false);
    expect(sourceObservationSchema.safeParse({ ...source(), extra: true }).success).toBe(false);
    expect(workspaceHandleV2Schema.safeParse({ ...handle(), location: "/project" }).success).toBe(false);
  });
});

describe("source provenance and dirty decisions", () => {
  test("clean Git commit, linked worktree, detached HEAD, snapshot retained base", () => {
    const normal = source(), detached = source({ detached: true }), snap = source({ snapshot: true });
    expect(normal.subject.source.kind).toBe("git");
    expect(normal.subject.source.base).toEqual(gitBase);
    expect(normal.subject.source.kind === "git" && normal.subject.source.worktree.kind).toBe("linked");
    expect(detached.subject.source.kind === "git" && detached.subject.source.head.kind).toBe("detached");
    expect(detached.id).not.toBe(normal.id);
    expect(snap.subject.source.base.kind).toBe("snapshot");
    expect(snap.subject.source.kind).toBe("snapshot");
    expect(snap.subject.source.base.kind === "snapshot" && snap.subject.source.base.retained_reference).toBe(hash("retained"));
    const snapshotFingerprint = fingerprint({ source: snap, entries: [{ path: "file", worktree: {
      category: "tracked", state: { kind: "regular", hash: hash("snapshot-content"), bytes: 16, executable: false },
    } }] });
    expect(snapshotFingerprint.subject.repository_components).toEqual([]);
    expect(source({ time: "2026-02-01T00:00:00Z" }).id).toBe(normal.id);
    expect(createSourceObservation({ subject: normal.subject, audit: audit(),
      diagnostics: { git_branch: "renamed" } }).id).toBe(normal.id);
    const snapshotSource = snap.subject.source;
    if (snapshotSource.kind !== "snapshot" || snapshotSource.base.kind !== "snapshot") throw new Error("fixture");
    const snapshotBase = snapshotSource.base;
    fails(() => createSourceObservation({ subject: { ...snap.subject, source: {
      ...snapshotSource, base: { ...snapshotBase, captured_tree_hash: hash("wrong") },
    } }, audit: audit() }), "workspace-source-invalid");
  });
  test("dirty state cannot hide in base or omit exact observed overlay", () => {
    const dirty = source({ dirty: true });
    expect(dirty.subject.overlay.kind).toBe("observed");
    expect(sourceDecisionIssues(dirty, "require-clean", "isolated-local").map((i) => i.code)).toContain("workspace-dirty-policy-invalid");
    expect(sourceDecisionIssues(dirty, "base-only", "isolated-local")).toEqual([]);
    expect(sourceDecisionIssues(dirty, "base-only", "in-place").map((i) => i.code)).toContain("workspace-dirty-policy-invalid");
    expect(sourceDecisionIssues(dirty, "include-observed-overlay", "isolated-local")).toEqual([]);
    const snapshot = source({ snapshot: true });
    const snapshotBase = snapshot.subject.source;
    if (snapshotBase.kind !== "snapshot" || snapshotBase.base.kind !== "snapshot") throw new Error("fixture");
    const snapshotOverlay = createSourceObservation({ subject: { ...snapshot.subject, dirty_state: "dirty",
      overlay, source: { ...snapshotBase, base: { ...snapshotBase.base, captured_tree_hash: hash("older-tree") } } }, audit: audit() });
    expect(sourceDecisionIssues(snapshotOverlay, "include-observed-overlay", "isolated-local")).toEqual([]);
    expect(sourceDecisionIssues(source(), "require-clean", "in-place")).toEqual([]);
    expect(sourceDecisionIssues(source(), "include-observed-overlay", "in-place").map((i) => i.code)).toContain("workspace-dirty-policy-invalid");
    fails(() => createSourceObservation({ subject: { ...dirty.subject, overlay: { kind: "none" } }, audit: audit() }), "workspace-source-invalid");
    fails(() => createSourceObservation({ subject: { ...source().subject, overlay }, audit: audit() }), "workspace-source-invalid");
  });
  test("unborn Git, unmaterialized non-Git, missing commit and inconsistent repository fail closed for prepare", () => {
    const git = source();
    const unborn = createSourceObservation({ subject: { ...git.subject, source: {
      ...gitSource(), head: { kind: "unborn" }, base: { kind: "unmaterialized", reason: "unborn-head", tree_hash: hash("tree") },
    } }, audit: audit() });
    expect(sourceDecisionIssues(unborn, "require-clean", "isolated-local")).toContainEqual({ code: "workspace-source-invalid" });
    const snap = source({ snapshot: true });
    const unmaterialized = createSourceObservation({ subject: { ...snap.subject, source: {
      kind: "snapshot", base: { kind: "unmaterialized", reason: "non-git-tree", tree_hash: hash("tree") }, observed_tree: hash("tree"),
    } }, audit: audit() });
    expect(sourceDecisionIssues(unmaterialized, "require-clean", "isolated-local")).toContainEqual({ code: "workspace-source-invalid" });
    const submodules = [{ path: "z", gitlink: "b".repeat(40) }, { path: "a", gitlink: "a".repeat(40) }];
    const subject = { ...git.subject, source: { ...gitSource(), state: "submodules" as const,
      submodule_policy: { schema: "aira.dev/workspace-submodules/reject/v1" as const, observations: submodules } } };
    const sorted = createSourceObservation({ subject, audit: audit() });
    const reordered = createSourceObservation({ subject: { ...subject, source: { ...subject.source,
      submodule_policy: { ...subject.source.submodule_policy, observations: [...submodules].reverse() } } }, audit: audit() });
    expect(sorted.id).toBe(reordered.id);
    expect(sourceDecisionIssues(sorted, "require-clean", "isolated-local")).toContainEqual({ code: "workspace-source-invalid" });
    expect(sourceObservationSchema.safeParse({ ...sorted, subject: { ...sorted.subject, source: {
      ...subject.source, submodule_policy: { ...subject.source.submodule_policy, observations: submodules } } } }).success).toBe(false);
    expect(sourceObservationSchema.safeParse({ ...git, subject: { ...git.subject, source: {
      ...git.subject.source, base: { ...gitBase, commit: "" },
    } } }).success).toBe(false);
    fails(() => createSourceObservation({ subject: { ...git.subject, source: {
      ...gitSource(), base: { ...gitBase, repository: "repository_other" },
    } }, audit: audit() }), "workspace-source-invalid");
    expect(sourceObservationSchema.safeParse({ ...git, id: `source_observation_${"0".repeat(64)}` }).success).toBe(false);
  });
});

describe("capabilities, topology and immutable handles", () => {
  test("canonical unordered capabilities pin exact provider, no backend-security promises", () => {
    expect(caps().topologies).toEqual(["copied-snapshot", "in-place", "isolated-local"]);
    const reversed = createWorkspaceProviderCapabilities({ ...caps(), topologies: [...caps().topologies].reverse(),
      dirty_policies: [...caps().dirty_policies].reverse(), project_kinds: [...caps().project_kinds].reverse() });
    expect(reversed).toEqual(caps());
    expect(createWorkspaceHandle({ ...handle(), capabilities: { ...caps(), topologies: [...caps().topologies].reverse() } })).toEqual(handle());
    expect(workspaceHandleV2Schema.safeParse({ ...handle(), capabilities: {
      ...caps(), topologies: [...caps().topologies].reverse() } }).success).toBe(false);
    expect(caps().retention && caps().disposal && caps().recoverable_abandoned_lifecycle).toBe(true);
    expect(workspaceProviderCapabilitiesSchema.safeParse({ ...caps(), network_confinement: true }).success).toBe(false);
    expect(workspaceProviderCapabilitiesSchema.safeParse({ ...caps(), observed_dirty_overlay_reproduction: false }).success).toBe(false);
    expect(workspaceProviderCapabilitiesSchema.safeParse({ ...caps(), topologies: ["in-place", "in-place"] }).success).toBe(false);
    const inspectionOnly = createWorkspaceProviderCapabilities({ ...caps(), deterministic_fingerprinting: false,
      fingerprint_policies: [] });
    expect(inspectionOnly.deterministic_fingerprinting).toBe(false);
    expect(validateWorkspaceHandle({ ...handle(), capabilities: inspectionOnly }).ok).toBe(false);
  });
  test("in-place and isolated have distinct roles, even if same local root", () => {
    expect(handle({ topology: "in-place" }).roots.control).toEqual(handle({ topology: "in-place" }).roots.execution);
    expect(handle().roots.control).not.toEqual(handle().roots.execution);
    expect(handle({ snapshot: true, topology: "copied-snapshot" }).repository).toBeUndefined();
    fails(() => createWorkspaceHandle({ ...handle(), roots: { ...handle().roots, execution: handle().roots.control } }), "workspace-topology-incompatible");
    fails(() => createWorkspaceHandle({ ...handle(), roots: { ...handle().roots,
      execution: { kind: "local-absolute", path: "/project/inside" } } }), "workspace-topology-incompatible");
    fails(() => createWorkspaceHandle({ ...handle(), roots: { ...handle().roots,
      execution: { kind: "local-absolute", path: "../outside" } } }), "workspace-topology-incompatible");
    expect(validateWorkspaceHandle({ ...handle(), incarnation: "0" }).ok).toBe(false); // lifecycle key still names incarnation 1
  });
  test("reject contradictory source/provider/dirty/lifecycle declarations", () => {
    const h = handle({ dirty: true });
    expect(validateWorkspaceHandle({ ...h, dirty_policy: "base-only" }).ok).toBe(false);
    expect(validateWorkspaceHandle({ ...h, repository: "repository_other" }).ok).toBe(false);
    expect(validateWorkspaceHandle({ ...h, lifecycle: { ...h.lifecycle, workspace_id: "workspace_two" } }).ok).toBe(false);
    expect(validateWorkspaceHandle({ ...h, capabilities: { ...h.capabilities, topologies: ["in-place"] } }).ok).toBe(false);
    expect(validateWorkspaceHandle({ ...h, capabilities: { ...h.capabilities, observed_dirty_overlay_reproduction: false,
      dirty_policies: ["require-clean"] } }).ok).toBe(false);
    expect(validateWorkspaceHandle({ ...h, provider: { ...provider, version: "1.2.4" } }).ok).toBe(false);
    expect(validateWorkspaceHandle({ ...h, dirty_decision: { kind: "included", overlay_hash: hash("different") } }).ok).toBe(false);
  });
  test("deep detachment from mutable input at every nested level", () => {
    const input = mutable(handle());
    const saved = createWorkspaceHandle(input);
    input.capabilities.topologies.splice(0, 1);
    input.source.subject.source.kind === "git" && (input.source.subject.source.worktree.identity = hash("mutation"));
    input.roots.control.kind === "local-absolute" && (input.roots.control.path = "/other");
    expect(saved).toEqual(handle());
    expect(Object.isFrozen(saved) && Object.isFrozen(saved.source.subject) && Object.isFrozen(saved.capabilities.topologies)).toBe(true);
    expect(fingerprintHandleIssues(fingerprint(), saved)).toEqual([]);
  });
});

describe("fingerprint identity, manifest and policy", () => {
  test("canonical SHA-256 identity and detached, frozen entries; audit timestamp excluded", () => {
    const entries = mutable([entry("z.ts"), entry("a.ts")]);
    const a = fingerprint({ entries }), b = fingerprint({ entries: [...entries].reverse(), time: "2026-02-01T00:00:00Z" });
    expect(a.subject.manifest.entries.map((e) => e.path)).toEqual(["a.ts", "z.ts"]);
    expect(a.subject).toEqual(b.subject); expect(a.id).toBe(b.id); expect(a.digest).toBe(b.digest);
    expect(a.digest).toBe(hashCanonical(a.subject));
    expect(String(a.id)).toBe(`workspace_fingerprint_${a.digest.slice(7)}`);
    entries[0]!.worktree.state.kind === "regular" && (entries[0]!.worktree.state.hash = hash("changed"));
    expect(a.id).toBe(b.id);
    expect(Object.isFrozen(a.subject.manifest.entries[0]?.worktree.state)).toBe(true);
    expect(workspaceFingerprintV2Schema.safeParse({ ...a, digest: hash("fraud") }).success).toBe(false);
    expect(workspacePathManifestSchema.safeParse({ ...a.subject.manifest, hash: hash("fraud") }).success).toBe(false);
  });
  test("semantic changes: bytes, base, incarnation, provider, policy", () => {
    const a = fingerprint();
    expect(fingerprint({ entries: [entry("src/main.ts", "new")] }).id).not.toBe(a.id);
    const changedBase = source();
    const nextSource = createSourceObservation({ subject: { ...changedBase.subject, source: {
      ...gitSource(), base: { ...gitBase, commit: "b".repeat(40) },
    } }, audit: audit() });
    expect(fingerprint({ source: nextSource }).id).not.toBe(a.id);
    expect(fingerprint({ incarnation: "2" }).id).not.toBe(a.id);
    expect(fingerprint({ providerVersion: "2.0.0" }).id).not.toBe(a.id);
    expect(defaultWorkspaceFingerprintPolicy().hash).toBe(policy.hash);
    const configuration = { ...policy.configuration, additional_exclusions: [{ path: "cache", reason: "declared-provider-cache" as const,
      affected_consumers: ["verification"] }] };
    const changedPolicy = { ...policy, configuration, hash: hashCanonical({ schema: policy.schema, configuration }) };
    const underNewPolicy = createWorkspaceFingerprint({ binding: { ...a.subject, policy: changedPolicy },
      entries: a.subject.manifest.entries, repository_components: a.subject.repository_components });
    expect(underNewPolicy.id).not.toBe(a.id);
    expect(compareWorkspaceFingerprints(a, underNewPolicy).status).toBe("incompatible-policy");
  });
  test("staged, unstaged, ignored/untracked, symlink, deletion, executable, empty dir are separate path states", () => {
    const entries: readonly WorkspaceManifestEntry[] = [entry("tracked"), { path: "new", worktree: { category: "untracked", state: { kind: "regular", hash: hash("new"), bytes: 3, executable: false } } },
      { path: "generated", worktree: { category: "ignored", state: { kind: "regular", hash: hash("ignored"), bytes: 7, executable: false } } },
      { path: "link", worktree: { category: "tracked", state: { kind: "symlink", target_hash: hash("../other"), target_bytes: 8 } },
        index: { stage: 0, state: { kind: "symlink", target_hash: hash("../other"), target_bytes: 8 } } },
      { path: "removed", worktree: { category: "tracked", state: { kind: "deleted" } }, index: { stage: 0, state: { kind: "deleted" } } },
      { path: "empty", worktree: { category: "untracked", state: { kind: "empty-directory" } } }];
    const f = fingerprint({ entries });
    expect(f.subject.state_components.map((c) => c.category)).toEqual(["staged", "tracked", "untracked", "ignored"]);
    expect(f.subject.manifest.entries).toHaveLength(6);
    expect(() => fingerprint({ entries: [{ path: "tracked", worktree: { category: "tracked",
      state: { kind: "regular", hash: hash("data"), bytes: 4, executable: false } } }] })).toThrow();
    const edited = mutable(f.subject.manifest.entries);
    const tracked = edited.find((e) => e.path === "tracked")!;
    if (tracked.worktree.state.kind === "regular") tracked.worktree.state.executable = true;
    expect(compareWorkspaceFingerprints(f, fingerprint({ entries: edited })).reasons).toContainEqual({ code: "mode-changed", subject: "tracked" });
    const staged = mutable(f.subject.manifest.entries);
    const trackedStage = staged.find((e) => e.path === "tracked")!;
    if (trackedStage.index?.state.kind === "regular") trackedStage.index.state.hash = hash("other-staged");
    const stagedCompare = compareWorkspaceFingerprints(f, fingerprint({ entries: staged }));
    expect(stagedCompare.reasons.map((r) => r.code)).toContain("staged-state-changed");
    expect(stagedCompare.reasons.map((r) => r.code)).not.toContain("tracked-content-changed");
  });
  test("manifest rejects duplicates, ambiguous aliases, reserved/excluded paths, unsafe paths and nested repos", () => {
    for (const paths of [["same", "same"], ["A.ts", "a.ts"], ["caf\u00e9", "cafe\u0301"]])
      fails(() => fingerprint({ entries: paths.map((path) => entry(path)) }), "workspace-manifest-duplicate-path");
    for (const path of ["/absolute", "../escape", "a/./b", "a//b", "C:/drive", ".git/HEAD", ".aira/state/x", ".AIRA/x"])
      expect(() => fingerprint({ entries: [entry(path)] })).toThrow();
    expect(() => fingerprint({ entries: [entry("dir"), entry("dir/child")] })).toThrow();
    expect(() => fingerprint({ entries: [{ path: "submodule", worktree: { category: "tracked", state: {
      kind: "nested-repository", repository: repositoryIdentitySchema.parse("repository_nested"), gitlink_commit: "a".repeat(40), observation_hash: hash("nested") } } }] })).toThrow();
    expect(() => fingerprint({ entries: Array.from({ length: 250001 }, (_, i) => entry(`p${i}`)) })).toThrow();
  });
  test("deterministic permutations of entries, components, exclusions and capabilities", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const extras = [{ path: "cache", reason: "declared-provider-cache" as const, affected_consumers: ["verification", "context"] },
      { path: "output", reason: "declared-provider-cache" as const, affected_consumers: ["context", "verification"] }];
    const aPolicy = createWorkspaceFingerprintPolicy({ ...policy.configuration,
      exclusions: [...policy.configuration.exclusions], additional_exclusions: extras });
    const bPolicy = createWorkspaceFingerprintPolicy({ ...policy.configuration,
      exclusions: [...policy.configuration.exclusions].reverse(), additional_exclusions: [...extras].reverse() });
    expect(aPolicy).toEqual(bPolicy);
    expect(createWorkspaceProviderCapabilities({ ...caps(), topologies: [...caps().topologies].reverse(),
      fingerprint_policies: [aPolicy.hash] }).topologies).toEqual(caps().topologies);
    const base = fingerprint();
    const binding = { ...base.subject, policy: aPolicy };
    const components = base.subject.repository_components;
    const expected = createWorkspaceFingerprint({ binding, entries, repository_components: components });
    for (const permutation of [[entries[2]!, entries[0]!, entries[1]!], [...entries].reverse(), entries]) {
      const actual = createWorkspaceFingerprint({ binding: { ...binding, policy: bPolicy }, entries: permutation,
        repository_components: [...components].reverse() });
      expect(actual.id).toBe(expected.id);
      expect(actual.subject).toEqual(expected.subject);
    }
  });
  test("policy declarations cannot silently broaden control/Git exclusions or weaken coverage", () => {
    expect(policy.configuration.exclusions.map((e) => e.path)).toEqual([".aira", ".git"]);
    expect(defaultWorkspaceFingerprintPolicy()).toEqual(policy);
    expect(() => createWorkspaceFingerprintPolicy({ ...policy.configuration, additional_exclusions: [
      { path: ".AIRA/state", reason: "declared-provider-cache", affected_consumers: ["verification"] }] })).toThrow();
    const cachePolicy = createWorkspaceFingerprintPolicy({ ...policy.configuration, additional_exclusions: [
      { path: "cache", reason: "declared-provider-cache", affected_consumers: ["verification"] }] });
    expect(() => createWorkspaceFingerprint({ binding: { ...fingerprint().subject, policy: cachePolicy },
      entries: [entry("CACHE/output")], repository_components: fingerprint().subject.repository_components })).toThrow();
    expect(() => createWorkspaceFingerprint({ binding: { ...fingerprint().subject,
      policy: { ...policy, configuration: { ...policy.configuration, exclusions: [
        { path: ".aira/state", reason: "control-state", scope: "both-roots" }, policy.configuration.exclusions[1]! ] } } },
      entries: [entry("safe")], repository_components: fingerprint().subject.repository_components })).toThrow();
  });
});

describe("pure comparison and exact-only applicability", () => {
  test("structured statuses and reasons, not digest-only or heuristic equality", () => {
    const a = fingerprint();
    expect(compareWorkspaceFingerprints(a, fingerprint({ time: "2026-03-01T00:00:00Z" })).status).toBe("identical");
    expect(compareWorkspaceFingerprints(a, fingerprint({ entries: [entry("src/main.ts", "edited")] })).status).toBe("changed");
    const other = fingerprint({ incarnation: "2" });
    expect(compareWorkspaceFingerprints(a, other).status).toBe("different-incarnation");
    const differentWorkspace = createWorkspaceFingerprint({ binding: { ...a.subject, workspace_id: workspaceIdSchema.parse("workspace_two") },
      entries: a.subject.manifest.entries, repository_components: a.subject.repository_components });
    expect(compareWorkspaceFingerprints(a, differentWorkspace).status).toBe("different-workspace");
    expect(compareWorkspaceFingerprints(a, fingerprint({ providerVersion: "2.0.0" })).status).toBe("incompatible-policy");
    const previous = source(), originalGit = gitSource();
    const changedSource = createSourceObservation({ subject: { ...previous.subject,
      source: { ...originalGit, base: { ...gitBase, commit: "b".repeat(40) } } }, audit: audit() });
    const differentBase = compareWorkspaceFingerprints(a, fingerprint({ source: changedSource }));
    expect(differentBase.status).toBe("different-base");
    expect(differentBase.reasons.map((reason) => reason.code)).toContain("base-changed");
    expect(compareWorkspaceFingerprints(a, { schema: "aira.dev/workspace-fingerprint/v1" }).status).toBe("invalid-input");
    expect(workspaceFingerprintApplicable(a, fingerprint()).applicable).toBe(true);
    expect(workspaceFingerprintApplicable(a, other).applicable).toBe(false);
    expect(workspaceFingerprintApplicable(a, { ...a, digest: hash("fraud") }).applicable).toBe(false);
    const symlink = fingerprint({ entries: [{ path: "src/main.ts", worktree: { category: "tracked",
      state: { kind: "symlink", target_hash: hash("target"), target_bytes: 6 } },
      index: { stage: 0, state: { kind: "symlink", target_hash: hash("target"), target_bytes: 6 } } }] });
    expect(compareWorkspaceFingerprints(a, symlink).reasons.map((r) => r.code)).toContain("symlink-changed");
    const deletion = fingerprint({ entries: [{ path: "src/main.ts", worktree: { category: "tracked", state: { kind: "deleted" } },
      index: { stage: 0, state: { kind: "deleted" } } }] });
    expect(compareWorkspaceFingerprints(a, deletion).reasons.map((r) => r.code)).toContain("deletion-changed");
    expect(fingerprintHandleIssues(other, handle()).map((r) => r.code)).toContain("workspace-fingerprint-incarnation-mismatch");
  });
  test("source comparison detects base/overlay/policy/association independently of audit", () => {
    const a = source();
    expect(compareSourceObservations(a, source({ time: "2026-03-01T00:00:00Z" }), "require-clean", "require-clean").status).toBe("identical");
    expect(compareSourceObservations(a, source({ dirty: true }), "require-clean", "base-only").reasons.map((i) => i.code))
      .toEqual(expect.arrayContaining(["overlay-changed", "dirty-policy-incompatible"]));
    const another = createSourceObservation({ subject: { ...a.subject, source: {
      ...gitSource(), base: { ...gitBase, commit: "b".repeat(40) },
    } }, audit: audit() });
    expect(compareSourceObservations(a, another, "require-clean", "require-clean").status).toBe("different-base");
    const policyChanged = createSourceObservation({ subject: { ...a.subject,
      inspection_policy: { ...a.subject.inspection_policy, hash: hash("new-policy") } }, audit: audit() });
    expect(compareSourceObservations(a, policyChanged, "require-clean", "require-clean").status).toBe("incompatible-policy");
    const repo = createSourceObservation({ subject: { ...a.subject, source: {
      ...gitSource(), repository: "repository_other", base: { ...gitBase, repository: "repository_other" },
    } }, audit: audit() });
    expect(compareSourceObservations(a, repo, "require-clean", "require-clean").status).toBe("different-repository");
  });
});
