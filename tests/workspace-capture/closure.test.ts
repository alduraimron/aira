import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashCanonical } from "../../src/canonical-json";
import { createWorkspaceHandle } from "../../src/workspace/handle";
import { createGitObservation } from "../../src/workspace-git";
import { makeLocalTree } from "../../src/workspace-local/manifest";
import { localInspectionPolicy } from "../../src/workspace-local";
import { captureGitWorkspaceSource, captureGitWorkspaceFingerprint, composeGitWorkspaceFingerprint } from "../../src/workspace-capture";
import { handle as domainHandle } from "../workspace-domain/fixtures";
import type { LocalTreeEntry, LocalTreeCapture } from "../../src/workspace-local";
import type { QuiescenceEvidence } from "../../src/workspace-capture";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) {
  const r = spawnSync("/usr/bin/git", args, { cwd: root, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
const proof: QuiescenceEvidence = { schema: "aira.dev/workspace-capture-quiescence/v1", held: true, token: "trusted-test" };
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "aira-closure-")); dirs.push(parent);
  const root = join(parent, "repo"); await mkdir(root);
  git(root, "init", "-qb", "main"); git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  await writeFile(join(root, "a"), "base"); git(root, "add", "a"); git(root, "commit", "-qm", "base");
  const template = domainHandle({ topology: "in-place" });
  const boot = async () => captureGitWorkspaceSource({ executionRoot: root, controlRoot: root,
    relationship: "same-root", controlProject: template.control_project, project: template.project,
    registeredRootAssociation: hashCanonical("registered"), provider: template.provider,
    capturePolicy: template.fingerprint_policy, audit: template.created, observeQuiescence: async () => proof });
  const h = async () => {
    const b = await boot(); if (!b.source) throw new Error(JSON.stringify(b.diagnostics));
    const overlay = b.source.subject.overlay;
    return createWorkspaceHandle({ ...template, source: b.source,
      repository: b.source.subject.source.kind === "git" ? b.source.subject.source.repository : undefined,
      roots: { control: { kind: "local-absolute", path: root }, execution: { kind: "local-absolute", path: root },
        relationship: "same-root" },
      dirty_policy: overlay.kind === "observed" ? "include-observed-overlay" : "require-clean",
      dirty_decision: overlay.kind === "observed" ? { kind: "included", overlay_hash: overlay.manifest_hash } : { kind: "clean" },
    });
  };
  const observed = async () => {
    const handle = await h();
    const r = await captureGitWorkspaceFingerprint({ handle, executionRoot: root, observeQuiescence: async () => proof });
    if (r.status !== "complete" || !r.local || !r.git_before || !r.git_after) throw new Error(JSON.stringify(r.diagnostics));
    return { handle, r };
  };
  return { root, parent, template, boot, h, observed };
}
const codes = (result: ReturnType<typeof composeGitWorkspaceFingerprint>) => result.diagnostics.map((d) => d.code);
function compose(handle: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["h"]>>,
  r: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["observed"]>>["r"],
  overrides: Record<string, unknown> = {}) {
  return composeGitWorkspaceFingerprint({ handle, git_before: r.git_before, git_after: r.git_after,
    local: r.local, capture_policy: handle.fingerprint_policy, provider: handle.provider, audit: handle.created,
    quiescence: proof, ...overrides });
}
function changeLocal(capture: LocalTreeCapture, entries: readonly LocalTreeEntry[], policy: ReturnType<typeof domainHandle>["fingerprint_policy"]) {
  return { ...capture, tree: makeLocalTree(entries, localInspectionPolicy, policy) };
}

describe("06-2B2 pure closure and fail-closed inputs", () => {
  test("local-only regular file and missing Git expected path never acquire a guessed classification", async () => {
    const f = await fixture(); const { handle, r } = await f.observed();
    const entries = r.local!.tree!.entries;
    const extra = changeLocal(r.local!, [...entries, { path: "unknown", state: { kind: "regular",
      hash: hashCanonical("new"), bytes: 3, executable: false } }], handle.fingerprint_policy);
    expect(codes(compose(handle, r, { local: extra }))).toContain("workspace-capture-path-unclassified");
    const missing = changeLocal(r.local!, [], handle.fingerprint_policy);
    expect(codes(compose(handle, r, { local: missing }))).toContain("workspace-capture-path-missing");
    expect(r.local?.tree?.entries).toHaveLength(1);
  });
  test("Git index and local type/mode contradictions fail without a fingerprint", async () => {
    const f = await fixture(); await writeFile(join(f.root, "a"), "staged"); git(f.root, "add", "a");
    const { handle, r } = await f.observed();
    const local = r.local!.tree!.entries;
    const wrongType = changeLocal(r.local!, [{ path: "a", state: { kind: "symlink", target_hash: hashCanonical("target"), target_bytes: 6 } }], handle.fingerprint_policy);
    expect(codes(compose(handle, r, { local: wrongType }))).toContain("workspace-capture-type-mismatch");
    const wrongMode = changeLocal(r.local!, [{ path: "a", state: { ...local[0]!.state, executable: true } as LocalTreeEntry["state"] }], handle.fingerprint_policy);
    expect(codes(compose(handle, r, { local: wrongMode }))).toContain("workspace-capture-mode-mismatch");
    const a = r.git_before!; const staged = a.subject.staged[0]!;
    const tampered = createGitObservation({ ...a.subject, staged: [{ ...staged,
      after: { ...staged.after!, oid: "f".repeat(40) } }] }, a.audit);
    expect(codes(compose(handle, r, { git_before: tampered, git_after: tampered }))).toContain("workspace-capture-index-mismatch");
  });
  test("invalid, unsupported, policy-incompatible and missing quiescence do not yield a fingerprint", async () => {
    const f = await fixture(); const { handle, r } = await f.observed();
    expect(compose(handle, r, { quiescence: undefined }).status).toBe("incomplete");
    expect(compose(handle, r, { quiescence: undefined }).fingerprint).toBeUndefined();
    const unsupported = createGitObservation({ ...r.git_before!.subject, state: "submodules" }, r.git_before!.audit);
    expect(compose(handle, r, { git_before: unsupported, git_after: unsupported }).status).toBe("unsupported");
    const incompatible = { ...r.local!, tree: { ...r.local!.tree!, capture_policy_hash: hashCanonical("other") } };
    expect(compose(handle, r, { local: incompatible }).status).toBe("invalid-input");
    expect(compose(handle, r, { git_before: { ...r.git_before, hash: hashCanonical("fake") } }).status).toBe("invalid-input");
  });
  test("reordered local/Git semantic entries and audit timing do not alter the exact fingerprint", async () => {
    const f = await fixture(); await writeFile(join(f.root, "new1"), "one"); await writeFile(join(f.root, "new2"), "two");
    const { handle, r } = await f.observed(); const baseline = compose(handle, r);
    const a = r.git_before!, changedAudit = { ...a.audit, started_at: "different", ended_at: "different" };
    const gitReordered = createGitObservation({ ...a.subject, untracked: [...a.subject.untracked].reverse() }, changedAudit);
    const localReordered = changeLocal(r.local!, [...r.local!.tree!.entries].reverse(), handle.fingerprint_policy);
    const reordered = compose(handle, r, { git_before: gitReordered, git_after: gitReordered, local: localReordered });
    expect(reordered.status).toBe("complete");
    expect(reordered.fingerprint?.id).toBe(baseline.fingerprint?.id);
    expect(reordered.source?.id).toBe(baseline.source?.id);
  });
});
