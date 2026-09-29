import { hashCanonical } from "../canonical-json";
import { compareText, exact } from "../spec/domain/primitives";
import { freeze } from "../workspace/domain";
import { workspaceFingerprintPolicySchema, workspacePathManifestV2Schema,
  type WorkspaceFingerprintPolicy, type WorkspaceManifestEntryV2 } from "../workspace/fingerprint-v2";
import { gitObservationSchema } from "../workspace-git/observation";
import { compareGitObservations } from "../workspace-git/comparison";
import { gitInspectionPolicy } from "../workspace-git/policy";
import type { GitObservation, GitChange, GitEntry } from "../workspace-git/types";
import { localInspectionPolicy } from "../workspace-local/policy";
import { localTreeObservationSchema, aliasKey } from "../workspace-local/manifest";
import type { LocalTreeCapture, LocalTreeEntry, LocalTreeObservation } from "../workspace-local/types";
import type { CaptureIssue, ClosureReport } from "./types";

const compareIssue = (a: CaptureIssue, b: CaptureIssue): number =>
  compareText(a.path ?? "", b.path ?? "") || compareText(a.code, b.code) || compareText(a.detail ?? "", b.detail ?? "");
export function report(mismatches: readonly CaptureIssue[] = [], localOnly: readonly string[] = [],
  excluded: readonly string[] = [], unsupported: readonly string[] = [],
  counts = { tracked: 0, staged: 0, tracked_dirty: 0, untracked: 0, ignored: 0, deletions: 0, local_only: 0 }): ClosureReport {
  return freeze({ schema: "aira.dev/workspace-git-local-closure/v1" as const, counts,
    local_only: [...localOnly].sort(compareText), excluded: [...excluded].sort(compareText),
    unsupported: [...unsupported].sort(compareText), mismatches: [...mismatches].sort(compareIssue) });
}
export interface CoherentInputs {
  readonly before: GitObservation; readonly after: GitObservation;
  readonly local: LocalTreeCapture & { readonly tree: LocalTreeObservation };
  readonly policy: WorkspaceFingerprintPolicy;
}
/** Validate hashes, versions, policy, roles and G1/G2 before composing any path. */
export function coherentInputs(gitBefore: unknown, gitAfter: unknown, localInput: unknown,
  capturePolicy: unknown): { readonly ok: true; readonly value: CoherentInputs } |
    { readonly ok: false; readonly status: "invalid-input" | "incompatible" | "unstable" | "incomplete" | "unsupported";
      readonly issue: CaptureIssue } {
  const before = gitObservationSchema.safeParse(gitBefore), after = gitObservationSchema.safeParse(gitAfter);
  const policy = workspaceFingerprintPolicySchema.safeParse(capturePolicy);
  if (!before.success || !after.success || !policy.success || !localInput || typeof localInput !== "object")
    return { ok: false, status: "invalid-input", issue: { code: "workspace-capture-invalid-input" } };
  const local = localInput as LocalTreeCapture;
  if (local.schema !== "aira.dev/workspace-local-tree-capture/v1" || local.status !== "complete" ||
      !local.tree || !local.root || !Array.isArray(local.diagnostics) || local.diagnostics.length !== 0)
    return { ok: false, status: "incomplete", issue: { code: "workspace-capture-source-incomplete", detail: "local-scan-incomplete" } };
  const parsedTree = localTreeObservationSchema.safeParse(local.tree);
  if (!parsedTree.success || !Array.isArray(local.excluded) ||
      local.policy?.hash !== localInspectionPolicy.hash ||
      !exact(local.policy, localInspectionPolicy) ||
      typeof local.root.path !== "string" || typeof local.root.device !== "string" ||
      typeof local.root.inode !== "string" || !Array.isArray(local.freshness))
    return { ok: false, status: "invalid-input", issue: { code: "workspace-capture-invalid-input", detail: "invalid-local-tree" } };
  const a = before.data, b = after.data, t = parsedTree.data;
  if (a.subject.state !== "normal" || b.subject.state !== "normal" ||
      a.subject.submodules.length || b.subject.submodules.length)
    return { ok: false, status: "unsupported", issue: { code: "workspace-capture-unsupported", detail: "unsupported-git-state" } };
  if (a.subject.policy_hash !== gitInspectionPolicy.hash || b.subject.policy_hash !== gitInspectionPolicy.hash ||
      a.subject.capture_policy_hash !== policy.data.hash || b.subject.capture_policy_hash !== policy.data.hash ||
      t.policy_hash !== localInspectionPolicy.hash || t.capture_policy_hash !== policy.data.hash ||
      !exact(a.subject.exclusions.paths, [...policy.data.configuration.exclusions,
        ...policy.data.configuration.additional_exclusions].map((e) => e.path).sort(compareText)))
    return { ok: false, status: "incompatible", issue: { code: "workspace-capture-policy-incompatible" } };
  if (a.audit.root !== b.audit.root || a.audit.root !== local.root.path ||
      a.audit.git_dir !== b.audit.git_dir || a.audit.common_dir !== b.audit.common_dir ||
      !a.subject.base_commit || !b.subject.base_commit)
    return { ok: false, status: "unstable", issue: { code: "workspace-capture-git-unstable", detail: "root-or-base-changed" } };
  if (compareGitObservations(a, b).status !== "identical")
    return { ok: false, status: "unstable", issue: { code: "workspace-capture-git-unstable", detail: "semantic-state-changed" } };
  // Zod has detached Git, tree and policy data. Detach the local operational
  // envelope as well: freezing a result must never freeze caller-owned input.
  let detached: LocalTreeCapture;
  try { detached = structuredClone(local); }
  catch { return { ok: false, status: "invalid-input", issue: { code: "workspace-capture-invalid-input" } }; }
  return { ok: true, value: { before: a, after: b, local: { ...detached, tree: t as LocalTreeObservation }, policy: policy.data } };
}
const gitMode = (state: LocalTreeEntry["state"]): string | undefined => state.kind === "regular" ?
  state.executable ? "100755" : "100644" : state.kind === "symlink" ? "120000" : undefined;
const gitIndex = (entry: GitEntry, format: "sha1" | "sha256") => ({ stage: 0 as const, state: {
  kind: "git-object" as const, schema: "aira.dev/workspace-git-index-state/v1" as const,
  object_format: format, oid: entry.oid, mode: entry.mode as "100644" | "100755" | "120000",
} });
const tombstone = { stage: 0 as const, state: { kind: "deleted" as const } };
export interface ClosedPaths { readonly entries: readonly WorkspaceManifestEntryV2[];
  readonly report: ClosureReport; readonly overlay: {
    readonly dirty: boolean; readonly staged: ReturnType<typeof hashCanonical>;
    readonly tracked: ReturnType<typeof hashCanonical>; readonly untracked: ReturnType<typeof hashCanonical>;
    readonly ignored: ReturnType<typeof hashCanonical>; readonly manifest_hash: ReturnType<typeof hashCanonical>;
    readonly exclusions: readonly string[] };
  readonly repository_components: readonly { readonly kind: "git-index" | "git-tree"; readonly hash: ReturnType<typeof hashCanonical> }[] }
/** Exact one-to-one path closure. It does not read a path or dereference a symlink. */
export function closeGitPaths(git: GitObservation, tree: LocalTreeObservation,
  policy: WorkspaceFingerprintPolicy): ClosedPaths {
  const s = git.subject;
  const local = new Map(tree.entries.map((e) => [e.path, e]));
  const index = new Map(s.index.map((e) => [e.path, e]));
  const staged = new Map(s.staged.map((e) => [e.path, e]));
  const tracked = new Map(s.tracked.map((e) => [e.path, e]));
  const untracked = new Set(s.untracked), ignored = new Set(s.ignored);
  const entries: WorkspaceManifestEntryV2[] = [], mismatches: CaptureIssue[] = [];
  const covered = new Set<string>(); const localOnly: string[] = [];
  const add = (code: CaptureIssue["code"], path: string, detail?: string) => mismatches.push({ code, path, ...(detail ? { detail } : {}) });
  const allAliases = new Map<string, string>();
  for (const path of new Set([...local.keys(), ...index.keys(), ...staged.keys(), ...tracked.keys(), ...untracked, ...ignored])) {
    const alias = aliasKey(path), existing = allAliases.get(alias);
    if (existing && existing !== path) add("workspace-capture-git-local-mismatch", path, "alias-collision");
    allAliases.set(alias, path);
  }
  const trackedPaths = new Set([...index.keys(), ...staged.keys(), ...tracked.keys()]);
  for (const path of [...trackedPaths].sort(compareText)) {
    const i = index.get(path), stage = staged.get(path), change = tracked.get(path), item = local.get(path);
    const category = untracked.has(path) ? "untracked" as const : ignored.has(path) ? "ignored" as const : "tracked" as const;
    if (untracked.has(path) && ignored.has(path) || i && category !== "tracked")
      add("workspace-capture-index-mismatch", path, "overlapping-index-and-other-category");
    if (!i && (stage?.kind !== "deletion" || stage.after)) add("workspace-capture-index-mismatch", path, "missing-stage-zero");
    if (i && i.mode === "160000") add("workspace-capture-unsupported", path, "gitlink");
    if (stage) {
      if (i ? !stage.after || stage.after.mode !== i.mode || stage.after.oid !== i.oid :
          stage.kind !== "deletion" || !!stage.after) add("workspace-capture-index-mismatch", path, "staged-after-vs-index");
    }
    if (change && (!i || !change.before || change.before.mode !== i.mode || change.before.oid !== i.oid))
      add("workspace-capture-index-mismatch", path, "tracked-before-vs-index");
    if (!i && change) add("workspace-capture-index-mismatch", path, "tracked-without-index");
    if (!item) {
      if (i && change?.kind !== "deletion" || !i && category !== "tracked")
        add("workspace-capture-path-missing", path);
      entries.push({ path, worktree: { category: "tracked", state: { kind: "deleted" } },
        index: i ? gitIndex(i, s.object_format) : tombstone });
    } else {
      covered.add(path);
      if (item.state.kind === "empty-directory") {
        add("workspace-capture-type-mismatch", path, "directory-at-git-path");
        continue;
      }
      if (change?.kind === "deletion") add("workspace-capture-git-local-mismatch", path, "reported-deleted-but-present");
      if (!i && category === "tracked") add("workspace-capture-path-unclassified", path);
      const expectedMode = change?.after?.mode ?? i?.mode;
      if (expectedMode && gitMode(item.state) !== expectedMode)
        add(item.state.kind === "symlink" || expectedMode === "120000" ?
          "workspace-capture-type-mismatch" : "workspace-capture-mode-mismatch", path);
      entries.push({ path, worktree: { category, state: item.state }, index: i ? gitIndex(i, s.object_format) : tombstone });
    }
  }
  for (const [category, paths] of [["untracked", s.untracked], ["ignored", s.ignored]] as const) {
    for (const path of paths) {
      if (trackedPaths.has(path)) continue;
      const item = local.get(path);
      if (!item) { add("workspace-capture-path-missing", path); continue; }
      if (item.state.kind === "empty-directory") { add("workspace-capture-type-mismatch", path); continue; }
      covered.add(path); entries.push({ path, worktree: { category, state: item.state } });
    }
  }
  for (const item of tree.entries) if (!covered.has(item.path)) {
    if (item.state.kind !== "empty-directory") add("workspace-capture-path-unclassified", item.path);
    else if (trackedPaths.has(item.path) || untracked.has(item.path) || ignored.has(item.path))
      add("workspace-capture-git-local-mismatch", item.path, "empty-directory-classification");
    else { localOnly.push(item.path);
      entries.push({ path: item.path, worktree: { category: "local-only", state: item.state } }); }
  }
  entries.sort((a, b) => compareText(a.path, b.path));
  // A duplicate path, a physical ancestor collision or an invalid mode must not escape
  // the strict domain constructor even if our path sets were individually canonical.
  const subject = { schema: "aira.dev/workspace-path-manifest/v2" as const, entries };
  const parsed = workspacePathManifestV2Schema.safeParse({ ...subject, hash: hashCanonical(subject) });
  if (!parsed.success) add("workspace-capture-git-local-mismatch", ".", "manifest-structure");
  const counts = { tracked: trackedPaths.size, staged: s.staged.length, tracked_dirty: s.tracked.length,
    untracked: s.untracked.length, ignored: s.ignored.length,
    deletions: entries.filter((e) => e.worktree.state.kind === "deleted").length, local_only: localOnly.length };
  const excluded = [...s.exclusions.paths];
  const closure = report(mismatches, localOnly, excluded, [], counts);
  const localState = (path: string) => local.get(path)?.state ?? { kind: "deleted" as const };
  const digest = (category: string, values: unknown) => hashCanonical({ schema: "aira.dev/workspace-byte-overlay-component/v1", category, values });
  const stagedHash = digest("staged", s.staged);
  const trackedHash = digest("tracked", s.tracked.map((e) => ({ change: e, state: localState(e.path) })));
  const untrackedHash = digest("untracked", [...s.untracked.map((path) => ({ path, state: localState(path) })),
    ...localOnly.map((path) => ({ path, category: "local-only", state: localState(path) }))]);
  const ignoredHash = digest("ignored", s.ignored.map((path) => ({ path, state: localState(path) })));
  const dirty = !!(s.staged.length || s.tracked.length || s.untracked.length || s.ignored.length || localOnly.length);
  const overlay = { dirty, staged: stagedHash, tracked: trackedHash, untracked: untrackedHash, ignored: ignoredHash,
    exclusions: excluded, manifest_hash: hashCanonical({ schema: "aira.dev/workspace-byte-overlay/v1",
      staged: stagedHash, tracked: trackedHash, untracked: untrackedHash, ignored: ignoredHash,
      exclusions: excluded, local_tree: tree.hash }) };
  const repository_components = [
    { kind: "git-index" as const, hash: hashCanonical({ schema: "aira.dev/workspace-git-index-component/v1",
      format: s.object_format, index: s.index, staged: s.staged }) },
    { kind: "git-tree" as const, hash: hashCanonical({ schema: "aira.dev/workspace-git-tree-component/v1",
      format: s.object_format, base: s.base_commit, worktree: s.worktree,
      local_tree: tree.hash, tracked: s.tracked, untracked: s.untracked, ignored: s.ignored }) },
  ];
  return freeze({ entries, report: closure, overlay, repository_components });
}
