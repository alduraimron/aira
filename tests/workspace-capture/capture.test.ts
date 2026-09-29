import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes, hashCanonical } from "../../src/canonical-json";
import { createWorkspaceHandle } from "../../src/workspace/handle";
import { workspaceFingerprintApplicable, compareWorkspaceFingerprints } from "../../src/workspace/comparison";
import { captureGitWorkspaceSource, captureGitWorkspaceFingerprint, composeGitWorkspaceFingerprint } from "../../src/workspace-capture";
import { handle as domainHandle } from "../workspace-domain/fixtures";
import type { QuiescenceEvidence } from "../../src/workspace-capture";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): string {
  const result = spawnSync("/usr/bin/git", args, { cwd: root, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
const proof: QuiescenceEvidence = { schema: "aira.dev/workspace-capture-quiescence/v1", token: "host-test-quiescent", held: true };
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "aira-capture-")); dirs.push(parent);
  const root = join(parent, "project"); await mkdir(root);
  git(root, "init", "-qb", "main"); git(root, "config", "user.name", "Aira Test");
  git(root, "config", "user.email", "test@example.invalid");
  await writeFile(join(root, "file"), "base\n"); git(root, "add", "file"); git(root, "commit", "-qm", "base");
  const template = domainHandle({ topology: "in-place" });
  const bootstrap = async () => captureGitWorkspaceSource({ executionRoot: root, controlRoot: root, relationship: "same-root",
    controlProject: template.control_project, project: template.project,
    registeredRootAssociation: hashCanonical("registered-root"), provider: template.provider,
    capturePolicy: template.fingerprint_policy, audit: template.created, observeQuiescence: async () => proof });
  const makeHandle = async (dirtyPolicy?: "require-clean" | "include-observed-overlay") => {
    const reviewed = await bootstrap();
    if (reviewed.status !== "complete" || !reviewed.source) throw new Error(JSON.stringify(reviewed.diagnostics));
    const source = reviewed.source, policy = dirtyPolicy ?? (source.subject.dirty_state === "dirty" ? "include-observed-overlay" : "require-clean");
    const overlay = source.subject.overlay;
    const h = createWorkspaceHandle({ ...template,
      roots: { control: { kind: "local-absolute", path: root }, execution: { kind: "local-absolute", path: root },
        relationship: "same-root" }, repository: source.subject.source.kind === "git" ? source.subject.source.repository : undefined,
      source, dirty_policy: policy,
      dirty_decision: policy === "include-observed-overlay" && overlay.kind === "observed" ?
        { kind: "included", overlay_hash: overlay.manifest_hash } : { kind: "clean" },
    });
    return { reviewed, h, capture: () => captureGitWorkspaceFingerprint({ handle: h, executionRoot: root,
      observeQuiescence: async () => proof }) };
  };
  return { parent, root, template, bootstrap, makeHandle };
}
const codes = (result: Awaited<ReturnType<typeof captureGitWorkspaceSource>>) => result.diagnostics.map((d) => d.code);

describe("06-2B2 exact source and final fingerprint", () => {
  test("clean repo: bootstrap, complete source, manifest v2, deterministic ID and exact evidence applicability", async () => {
    const f = await fixture(); const { h, capture } = await f.makeHandle();
    const preserved = await Promise.all([".git/index", ".git/HEAD", ".git/config", ".git/refs/heads/main", "file"]
      .map((p) => readFile(join(f.root, p))));
    const a = await capture(), b = await capture();
    for (const [i, path] of [".git/index", ".git/HEAD", ".git/config", ".git/refs/heads/main", "file"].entries())
      expect(await readFile(join(f.root, path))).toEqual(preserved[i]!);
    expect(a.status).toBe("complete"); expect(a.fingerprint?.schema).toBe("aira.dev/workspace-fingerprint/v2");
    expect(a.fingerprint?.subject.manifest.schema).toBe("aira.dev/workspace-path-manifest/v2");
    expect(a.source?.subject.source.kind === "git" && a.source.subject.source.byte_closure?.status).toBe("byte-complete");
    expect(a.source?.id).toBe(h.source.id);
    expect(a.fingerprint?.id).toBe(b.fingerprint?.id);
    expect(a.report.counts.tracked).toBe(1);
    expect(a.fingerprint?.subject.manifest.entries.map((e) => e.path)).toEqual(["file"]);
    expect(workspaceFingerprintApplicable(a.fingerprint, b.fingerprint).applicable).toBe(true);
    expect(Object.isFrozen(a.fingerprint?.subject.manifest.entries)).toBe(true);
    expect(Object.isFrozen(a.report)).toBe(true);
    const file = a.fingerprint?.subject.manifest.entries[0];
    expect(file?.worktree.state.kind === "regular" && file.worktree.state.hash).toBe(hashBytes(Buffer.from("base\n")));
    expect(file?.index?.state.kind).toBe("git-object");
    expect(file?.index?.state.kind === "git-object" && file.index.state.oid).toBe(git(f.root, "rev-parse", "HEAD:file"));
  });
  test("a new full base commit changes completed source and fingerprint comparison", async () => {
    const f = await fixture(); const first = await (await f.makeHandle()).capture();
    await writeFile(join(f.root, "file"), "next base\n"); git(f.root, "add", "file"); git(f.root, "commit", "-qm", "next");
    const second = await (await f.makeHandle()).capture();
    expect(first.status).toBe("complete"); expect(second.status).toBe("complete");
    expect(first.source?.subject.source.base).not.toEqual(second.source?.subject.source.base);
    expect(compareWorkspaceFingerprints(first.fingerprint, second.fingerprint).status).toBe("different-base");
  });
  test("tracked modification changes exact source and fingerprint despite identical Git classification", async () => {
    const f = await fixture(); await writeFile(join(f.root, "file"), "first\n");
    const first = await f.makeHandle(); const a = await first.capture();
    expect(a.status).toBe("complete"); expect(a.report.counts.tracked_dirty).toBe(1);
    expect(a.fingerprint?.subject.manifest.entries[0]?.worktree.category).toBe("tracked");
    await writeFile(join(f.root, "file"), "second\n");
    const next = await f.bootstrap();
    expect(next.git_before?.subject.tracked).toEqual(first.reviewed.git_before?.subject.tracked);
    expect(next.source?.id).not.toBe(first.reviewed.source?.id);
    expect(next.source?.subject.overlay.kind).toBe("observed");
    expect(codes(await first.capture())).toContain("workspace-capture-source-incomplete");
    const second = await (await f.makeHandle()).capture();
    expect(compareWorkspaceFingerprints(a.fingerprint, second.fingerprint).status).toBe("changed");
    expect(workspaceFingerprintApplicable(a.fingerprint, second.fingerprint).applicable).toBe(false);
  });
  test("index B and worktree C remain distinct for staged plus unstaged same path", async () => {
    const f = await fixture(); await writeFile(join(f.root, "file"), "B\n"); git(f.root, "add", "file");
    await writeFile(join(f.root, "file"), "C\n");
    const { capture } = await f.makeHandle(); const result = await capture();
    expect(result.status).toBe("complete");
    const entry = result.fingerprint?.subject.manifest.entries[0];
    expect(entry?.index?.state.kind === "git-object" && entry.index.state.oid).toBe(git(f.root, "rev-parse", ":file"));
    expect(entry?.worktree.state.kind === "regular" && entry.worktree.state.hash).toBe(hashBytes(Buffer.from("C\n")));
    expect(result.report.counts.staged).toBe(1); expect(result.report.counts.tracked_dirty).toBe(1);
    expect(result.source?.subject.overlay.kind).toBe("observed");
    git(f.root, "add", "file");
    const later = await (await f.makeHandle()).capture();
    expect(later.fingerprint?.subject.manifest.entries[0]?.worktree.state).toEqual(entry?.worktree.state);
    expect(later.fingerprint?.subject.manifest.entries[0]?.index).not.toEqual(entry?.index);
    expect(later.fingerprint?.id).not.toBe(result.fingerprint?.id);
    expect(later.source?.id).not.toBe(result.source?.id);
  });
  test("staged addition, worktree deletion and staged deletion retain explicit index/tombstone states", async () => {
    const f = await fixture(); await writeFile(join(f.root, "new"), "staged"); git(f.root, "add", "new");
    let result = await (await f.makeHandle()).capture();
    expect(result.status).toBe("complete");
    expect(result.fingerprint?.subject.manifest.entries.find((e) => e.path === "new")?.index?.state.kind).toBe("git-object");
    await rm(join(f.root, "file"));
    result = await (await f.makeHandle()).capture();
    expect(result.status).toBe("complete");
    expect(result.fingerprint?.subject.manifest.entries.find((e) => e.path === "file")?.worktree.state.kind).toBe("deleted");
    git(f.root, "add", "-u");
    result = await (await f.makeHandle()).capture();
    expect(result.status).toBe("complete");
    const deleted = result.fingerprint?.subject.manifest.entries.find((e) => e.path === "file");
    expect(deleted?.index?.state.kind).toBe("deleted");
    expect(deleted?.worktree.state.kind).toBe("deleted");
  });
  test("ignored and untracked byte changes update source identity even when Git classifications do not", async () => {
    const f = await fixture(); await writeFile(join(f.root, ".gitignore"), "ignored\n");
    await writeFile(join(f.root, "ignored"), "one"); await writeFile(join(f.root, "untracked"), "one");
    const a = await f.bootstrap();
    await writeFile(join(f.root, "ignored"), "two");
    const b = await f.bootstrap();
    expect(a.git_before?.subject.ignored).toEqual(b.git_before?.subject.ignored);
    expect(a.source?.id).not.toBe(b.source?.id);
    await writeFile(join(f.root, "untracked"), "two");
    const c = await f.bootstrap();
    expect(b.git_before?.subject.untracked).toEqual(c.git_before?.subject.untracked);
    expect(b.source?.id).not.toBe(c.source?.id);
  });
  test("tracked symlink transition retains Git mode and exact raw local link target", async () => {
    const f = await fixture(); await rm(join(f.root, "file")); await symlink("../target", join(f.root, "file"));
    git(f.root, "add", "file");
    const result = await (await f.makeHandle()).capture();
    expect(result.status).toBe("complete");
    const entry = result.fingerprint?.subject.manifest.entries[0];
    expect(entry?.index?.state.kind === "git-object" && entry.index.state.mode).toBe("120000");
    expect(entry?.worktree.state).toEqual({ kind: "symlink", target_hash: hashBytes(Buffer.from("../target")), target_bytes: 9 });
  });
  test("an otherwise Git-clean empty directory is local overlay, not fabricated Git untracked classification", async () => {
    const f = await fixture(); await mkdir(join(f.root, "empty"));
    const bootstrap = await f.bootstrap();
    expect(bootstrap.git_before?.subject.untracked).toEqual([]);
    expect(bootstrap.source?.subject.dirty_state).toBe("dirty");
    const result = await (await f.makeHandle()).capture();
    expect(result.status).toBe("complete");
    expect(result.fingerprint?.subject.manifest.entries.find((e) => e.path === "empty")?.worktree.category).toBe("local-only");
  });
  test("staged deletion followed by untracked recreation retains both index tombstone and exact local bytes", async () => {
    const f = await fixture(); await rm(join(f.root, "file")); git(f.root, "add", "-u");
    await writeFile(join(f.root, "file"), "recreated");
    const result = await (await f.makeHandle()).capture();
    expect(result.status).toBe("complete");
    const entry = result.fingerprint?.subject.manifest.entries[0];
    expect(entry?.index?.state.kind).toBe("deleted");
    expect(entry?.worktree.category).toBe("untracked");
    expect(entry?.worktree.state.kind === "regular" && entry.worktree.state.hash).toBe(hashBytes(Buffer.from("recreated")));
  });
  test("physically empty parent remains local-only beside its absent tracked child", async () => {
    const f = await fixture(); await mkdir(join(f.root, "dir"));
    git(f.root, "mv", "file", "dir/file"); git(f.root, "commit", "-qm", "nested");
    await rm(join(f.root, "dir", "file"));
    const result = await (await f.makeHandle()).capture();
    expect(result.status).toBe("complete");
    expect(result.fingerprint?.subject.manifest.entries.map((e) => [e.path, e.worktree.state.kind]))
      .toEqual([["dir", "empty-directory"], ["dir/file", "deleted"]]);
  });
  test("untracked, ignored, symlink, executable, empty directory and control exclusions", async () => {
    const f = await fixture();
    await writeFile(join(f.root, ".gitignore"), "ignored\n"); git(f.root, "add", ".gitignore");
    await writeFile(join(f.root, "untracked"), "ordinary"); await writeFile(join(f.root, "ignored"), "generated");
    await symlink("target", join(f.root, "link")); await mkdir(join(f.root, "empty"));
    await chmod(join(f.root, "file"), 0o755);
    await mkdir(join(f.root, ".aira")); await writeFile(join(f.root, ".aira", "control"), "control");
    git(f.root, "add", "-f", ".aira/control");
    const result = await (await f.makeHandle()).capture();
    expect(result.status).toBe("complete");
    const entries = result.fingerprint?.subject.manifest.entries ?? [];
    expect(entries.map((e) => e.path)).toEqual([".gitignore", "empty", "file", "ignored", "link", "untracked"]);
    expect(entries.find((e) => e.path === "untracked")?.worktree.category).toBe("untracked");
    expect(entries.find((e) => e.path === "ignored")?.worktree.category).toBe("ignored");
    expect(entries.find((e) => e.path === "empty")?.worktree.category).toBe("local-only");
    expect(entries.find((e) => e.path === "file")?.worktree.state.kind === "regular" &&
      entries.find((e) => e.path === "file")?.worktree.state.kind === "regular" &&
      (entries.find((e) => e.path === "file")!.worktree.state as { executable: boolean }).executable).toBe(true);
    expect(entries.find((e) => e.path === "link")?.worktree.state.kind).toBe("symlink");
    expect(result.report.local_only).toEqual(["empty"]);
    expect(result.report.excluded).toContain(".aira"); expect(result.report.excluded).toContain(".git");
  });
  test("Git bracketing rejects HEAD, index and untracked classification changes", async () => {
    const f = await fixture(); const { h } = await f.makeHandle();
    const request = { handle: h, executionRoot: f.root, observeQuiescence: async () => proof };
    const index = await captureGitWorkspaceFingerprint(request, { afterLocal: async () => {
      await writeFile(join(f.root, "new"), "new"); git(f.root, "add", "new");
    } });
    expect(index.status).toBe("unstable"); expect(index.fingerprint).toBeUndefined();
    git(f.root, "commit", "-qm", "next");
    const head = await captureGitWorkspaceFingerprint(request, { afterGitBefore: async () => {
      await writeFile(join(f.root, "file"), "changed"); git(f.root, "add", "file"); git(f.root, "commit", "-qm", "new-base");
    } });
    expect(head.status).toBe("unstable");
    const fresh = await f.makeHandle();
    const untracked = await captureGitWorkspaceFingerprint({ handle: fresh.h, executionRoot: f.root,
      observeQuiescence: async () => proof }, { afterLocal: async () => { await writeFile(join(f.root, "appeared"), "x"); } });
    expect(untracked.status).toBe("unstable");
  });
  test("replacing the execution root between local scan and G2 is unstable", async () => {
    const f = await fixture(); const { h } = await f.makeHandle();
    const result = await captureGitWorkspaceFingerprint({ handle: h, executionRoot: f.root,
      observeQuiescence: async () => proof }, { afterLocal: async () => {
      await rename(f.root, `${f.root}-old`); await mkdir(f.root);
    } });
    expect(result.status).toBe("unstable"); expect(result.fingerprint).toBeUndefined();
  });
  test("post-G2 local stat recheck rejects a byte edit with unchanged Git dirty classification", async () => {
    const f = await fixture(); await writeFile(join(f.root, "file"), "dirty-one");
    const { h } = await f.makeHandle();
    const result = await captureGitWorkspaceFingerprint({ handle: h, executionRoot: f.root,
      observeQuiescence: async () => proof }, { afterLocal: async () => {
      await writeFile(join(f.root, "file"), "dirty-two");
    } });
    expect(result.git_before?.hash).toBe(result.git_after?.hash);
    expect(result.status).toBe("unstable");
    expect(result.fingerprint).toBeUndefined();
    expect(codes(result)).toContain("workspace-capture-git-local-mismatch");
  });
  test("require-clean rejects a dirty execution tree and dirty in-place base-only cannot form a handle", async () => {
    const f = await fixture(); await writeFile(join(f.root, "untracked"), "dirty");
    const boot = await f.bootstrap();
    expect(boot.source?.subject.dirty_state).toBe("dirty");
    const dirty = await f.makeHandle();
    expect(() => createWorkspaceHandle({ ...dirty.h, dirty_policy: "require-clean", dirty_decision: { kind: "clean" } })).toThrow();
    expect(() => createWorkspaceHandle({ ...dirty.h, dirty_policy: "base-only", dirty_decision: {
      kind: "omitted", reviewed_overlay_hash: dirty.h.source.subject.overlay.kind === "observed" ?
        dirty.h.source.subject.overlay.manifest_hash : hashCanonical("none"), reason: "base-only",
    } })).toThrow();
    await rm(join(f.root, "untracked"));
    const cleanHandle = await f.makeHandle(); await writeFile(join(f.root, "untracked"), "dirty-again");
    const denied = await captureGitWorkspaceFingerprint({ handle: cleanHandle.h, executionRoot: f.root,
      observeQuiescence: async () => proof });
    expect(denied.status).not.toBe("complete"); expect(denied.fingerprint).toBeUndefined();
  });
  test("isolated base-only describes clean execution tree while preserving dirty reviewed control source", async () => {
    const f = await fixture(); await writeFile(join(f.root, "discarded"), "control overlay");
    const reviewed = await f.bootstrap(); if (!reviewed.source || reviewed.source.subject.overlay.kind !== "observed") throw new Error("fixture");
    const linked = join(f.parent, "linked"); git(f.root, "worktree", "add", "-qb", "other", linked);
    const template = domainHandle();
    const h = createWorkspaceHandle({ ...template, source: reviewed.source,
      repository: reviewed.source.subject.source.kind === "git" ? reviewed.source.subject.source.repository : undefined,
      roots: { control: { kind: "local-absolute", path: f.root }, execution: { kind: "local-absolute", path: linked },
        relationship: "separate-root" }, dirty_policy: "base-only", dirty_decision: {
          kind: "omitted", reviewed_overlay_hash: reviewed.source.subject.overlay.manifest_hash, reason: "base-only",
        } });
    const result = await captureGitWorkspaceFingerprint({ handle: h, executionRoot: linked,
      observeQuiescence: async () => proof, observeReviewedSource: async () => reviewed.source });
    expect(result.status).toBe("complete");
    expect(result.source?.subject.dirty_state).toBe("clean");
    expect(result.fingerprint?.subject.source_observation).toBe(reviewed.source.id);
    expect(result.fingerprint?.subject.manifest.entries.map((e) => e.path)).toEqual(["file"]);
    const missing = await captureGitWorkspaceFingerprint({ handle: h, executionRoot: linked,
      observeQuiescence: async () => proof });
    expect(missing.status).toBe("incomplete"); expect(missing.fingerprint).toBeUndefined();
  });
  test("isolated included overlay must match reviewed exact paths, not the linked worktree locator", async () => {
    const f = await fixture(); await writeFile(join(f.root, "file"), "observed dirty");
    const reviewed = await f.bootstrap(); if (!reviewed.source || reviewed.source.subject.overlay.kind !== "observed") throw new Error("fixture");
    const linked = join(f.parent, "linked"); git(f.root, "worktree", "add", "-qb", "other", linked);
    await writeFile(join(linked, "file"), "observed dirty");
    const template = domainHandle();
    const h = createWorkspaceHandle({ ...template, source: reviewed.source,
      repository: reviewed.source.subject.source.kind === "git" ? reviewed.source.subject.source.repository : undefined,
      roots: { control: { kind: "local-absolute", path: f.root }, execution: { kind: "local-absolute", path: linked },
        relationship: "separate-root" }, dirty_policy: "include-observed-overlay", dirty_decision: {
          kind: "included", overlay_hash: reviewed.source.subject.overlay.manifest_hash,
        } });
    const result = await captureGitWorkspaceFingerprint({ handle: h, executionRoot: linked,
      observeQuiescence: async () => proof, observeReviewedSource: async () => reviewed.source });
    expect(result.status).toBe("complete");
    expect(result.source?.id).not.toBe(reviewed.source.id);
    await writeFile(join(linked, "file"), "different dirty");
    const mismatch = await captureGitWorkspaceFingerprint({ handle: h, executionRoot: linked,
      observeQuiescence: async () => proof, observeReviewedSource: async () => reviewed.source });
    expect(mismatch.status).toBe("incompatible"); expect(mismatch.fingerprint).toBeUndefined();
  });
  test("local read mutation and lost host quiescence never return a complete fingerprint", async () => {
    const f = await fixture(); const { h } = await f.makeHandle();
    const changed = await captureGitWorkspaceFingerprint({ handle: h, executionRoot: f.root,
      observeQuiescence: async () => proof }, { local: { afterFileOpen: async () => {
      await writeFile(join(f.root, "file"), "changed-in-scan");
    } } });
    expect(changed.status).toBe("incomplete"); expect(changed.fingerprint).toBeUndefined();
    const next = await f.makeHandle(); let calls = 0;
    const lost = await captureGitWorkspaceFingerprint({ handle: next.h, executionRoot: f.root,
      observeQuiescence: async () => ({ ...proof, token: ++calls === 1 ? "before" : "after" }) });
    expect(lost.status).toBe("unstable"); expect(lost.fingerprint).toBeUndefined();
  });
});
