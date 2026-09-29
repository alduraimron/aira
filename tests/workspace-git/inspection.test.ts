import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashCanonical } from "../../src/canonical-json";
import { defaultWorkspaceFingerprintPolicy } from "../../src/workspace/fingerprint-v2";
import { inspectWorkspaceLocal } from "../../src/workspace-local";
import { compareGitObservations, createGitObservation, gitDirtyPolicyIssues, gitInspectionPolicy,
  gitIsClean, gitOverlayDescriptor, gitSourceObservation, inspectWorkspaceGit } from "../../src/workspace-git";
import { GitInspectionError, runReadOnlyGit } from "../../src/workspace-git/runner";
import { audit, handle } from "../workspace-domain/fixtures";
const provider = handle().provider;
import type { GitObservation, InspectGitOptions } from "../../src/workspace-git";

const dirs: string[] = [];
afterEach(async () => { for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
async function fixture(committed = true) {
  const parent = await mkdtemp(join(tmpdir(), "aira-git-")); dirs.push(parent);
  const root = join(parent, "repo"); await mkdir(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Aira Test"); git(root, "config", "user.email", "test@example.invalid");
  if (committed) { await writeFile(join(root, "file"), "base\n"); git(root, "add", "file"); git(root, "commit", "-qm", "base"); }
  const options: InspectGitOptions = { executionRoot: root, controlProject: "control_project_one" as InspectGitOptions["controlProject"],
    project: "project_one" as InspectGitOptions["project"], registeredRootAssociation: hashCanonical("registration"),
    capturePolicy: defaultWorkspaceFingerprintPolicy() };
  const observe = () => inspectWorkspaceGit(options);
  const complete = async () => {
    const result = await observe();
    if (result.status !== "complete" || !result.observation) throw new Error(JSON.stringify(result.diagnostics));
    return result.observation;
  };
  return { parent, root, options, observe, complete };
}
const codes = (result: Awaited<ReturnType<typeof inspectWorkspaceGit>>) => result.diagnostics.map((e) => e.code);

describe("06-2B1 root, HEAD and identity", () => {
  test("ordinary root, clean full commit, same hash without audit, source projection is inspection-only", async () => {
    const f = await fixture(); const a = await f.complete(), b = await f.complete();
    expect(a.subject.head).toEqual({ kind: "attached", ref: "refs/heads/main", commit: git(f.root, "rev-parse", "HEAD") });
    expect(a.subject.base_commit).toHaveLength(40);
    expect(a.subject.repository).toStartWith("repository_");
    expect(a.subject.worktree.kind).toBe("main");
    expect(a.subject.index).toHaveLength(1);
    expect(gitIsClean(a)).toBe(true);
    expect(a.hash).toBe(b.hash);
    expect(compareGitObservations(a, b).status).toBe("identical");
    expect(Object.isFrozen(a.subject.index)).toBe(true);
    const source = gitSourceObservation(a, provider, audit());
    expect(source.subject.source.kind).toBe("git");
    expect(source.subject.consistency).toBe("unknown");
    expect(source.subject.overlay).toEqual({ kind: "none" });
    expect(source.subject.source.base.kind === "git" ? source.subject.source.base.commit : undefined).toBe(a.subject.base_commit);
    expect(gitSourceObservation(b, provider, audit("2026-02-01T00:00:00Z")).id).toBe(source.id);
  });
  test("linked worktree shares repository but has independent worktree, index and overlay", async () => {
    const f = await fixture(); const linked = join(f.parent, "linked");
    git(f.root, "worktree", "add", "-qb", "other", linked);
    const main = await f.complete();
    const other = await inspectWorkspaceGit({ ...f.options, executionRoot: linked });
    expect(other.status).toBe("complete");
    expect(other.observation?.subject.repository).toBe(main.subject.repository);
    expect(other.observation?.subject.worktree.kind).toBe("linked");
    expect(other.observation?.subject.worktree.identity).not.toBe(main.subject.worktree.identity);
    expect(compareGitObservations(main, other.observation).reasons).toContain("worktree-changed");
    await writeFile(join(linked, "file"), "other");
    expect((await inspectWorkspaceGit({ ...f.options, executionRoot: linked })).observation?.subject.tracked).toHaveLength(1);
    expect((await f.complete()).subject.tracked).toEqual([]);
  });
  test("non-Git, parent Git, bare, detached, unborn and corrupt HEAD are distinguished", async () => {
    const f = await fixture(); const child = join(f.root, "child"); await mkdir(child);
    expect(codes(await inspectWorkspaceGit({ ...f.options, executionRoot: child }))).toContain("workspace-git-not-repository");
    const outside = join(f.parent, "outside"); await mkdir(outside);
    expect((await inspectWorkspaceGit({ ...f.options, executionRoot: outside })).status).toBe("not-repository");
    const bare = join(f.parent, "bare"); git(f.root, "init", "--bare", "-q", bare);
    expect(codes(await inspectWorkspaceGit({ ...f.options, executionRoot: bare }))).toContain("workspace-git-bare-unsupported");
    git(f.root, "checkout", "-q", "--detach");
    expect((await f.complete()).subject.head.kind).toBe("detached");
    const u = await fixture(false);
    const unborn = await u.observe();
    expect(codes(unborn)).toContain("workspace-git-unborn-unsupported");
    expect(unborn.observation?.subject.head.kind).toBe("unborn");
    await writeFile(join(f.root, ".git", "HEAD"), "corrupt\n");
    expect(codes(await f.observe())).toContain("workspace-git-head-invalid");
  });
  test("new repository at the same path does not inherit the old provisional repository association", async () => {
    const f = await fixture(); const before = await f.complete();
    await rm(join(f.root, ".git"), { recursive: true });
    git(f.root, "init", "-qb", "main");
    git(f.root, "config", "user.name", "Aira Test"); git(f.root, "config", "user.email", "test@example.invalid");
    git(f.root, "add", "file"); git(f.root, "commit", "-qm", "base");
    const after = await f.complete();
    expect(after.subject.base_commit).toBe(before.subject.base_commit);
    expect(compareGitObservations(before, after).reasons).toContain("repository-changed");
  });
  test("SHA-256 OIDs remain Git OIDs and are never Aira file hashes", async () => {
    const f = await fixture(false);
    await rm(join(f.root, ".git"), { recursive: true });
    git(f.root, "init", "-q", "-b", "main", "--object-format=sha256");
    git(f.root, "config", "user.name", "Aira Test"); git(f.root, "config", "user.email", "test@example.invalid");
    await writeFile(join(f.root, "file"), "sha256\n"); git(f.root, "add", "file"); git(f.root, "commit", "-qm", "base");
    const o = await f.complete();
    expect(o.subject.object_format).toBe("sha256");
    expect(o.subject.base_commit).toHaveLength(64);
    expect(o.subject.index[0]?.oid).toHaveLength(64);
    expect(gitSourceObservation(o, provider, audit()).subject.source.base.kind).toBe("git");
  });
});

describe("06-2B1 path-state classification", () => {
  test("staged add, modify, delete, mode, staged plus unstaged; mode and symlink transitions", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "added"), "new"); git(f.root, "add", "added");
    expect((await f.complete()).subject.staged.find((e) => e.path === "added")?.kind).toBe("addition");
    await writeFile(join(f.root, "file"), "staged"); git(f.root, "add", "file");
    await writeFile(join(f.root, "file"), "unstaged");
    let o = await f.complete();
    expect(o.subject.staged.find((e) => e.path === "file")?.kind).toBe("modification");
    expect(o.subject.tracked.find((e) => e.path === "file")?.kind).toBe("modification");
    await chmod(join(f.root, "file"), 0o755);
    o = await f.complete();
    expect(o.subject.tracked.find((e) => e.path === "file")?.kind).toBe("mode-change");
    git(f.root, "add", "file");
    o = await f.complete();
    expect(o.subject.staged.find((e) => e.path === "file")?.kind).toBe("mode-change");
    await rm(join(f.root, "file"));
    expect((await f.complete()).subject.tracked.find((e) => e.path === "file")?.kind).toBe("deletion");
    git(f.root, "add", "-u");
    expect((await f.complete()).subject.staged.find((e) => e.path === "file")?.kind).toBe("deletion");
    await symlink("target", join(f.root, "added-link")); git(f.root, "add", "added-link");
    expect((await f.complete()).subject.index.find((e) => e.path === "added-link")?.mode).toBe("120000");
  });
  test("rename heuristics cannot change two-path staged truth", async () => {
    const f = await fixture(); git(f.root, "mv", "file", "renamed");
    const observation = await f.complete();
    expect(observation.subject.staged.map((e) => [e.path, e.kind])).toEqual([
      ["file", "deletion"], ["renamed", "addition"],
    ]);
  });
  test("untracked nested names, ignored ordinary files and .aira are classified/excluded", async () => {
    const f = await fixture();
    await writeFile(join(f.root, ".gitignore"), "ignored\n");
    await mkdir(join(f.root, "dir")); await writeFile(join(f.root, "dir", "a space"), "hi");
    await writeFile(join(f.root, "dir", "é"), "hi");
    await writeFile(join(f.root, "ignored"), "ignore");
    await mkdir(join(f.root, ".aira")); await writeFile(join(f.root, ".aira", "control"), "out");
    let o = await f.complete();
    expect(o.subject.untracked).toEqual([".gitignore", "dir/a space", "dir/é"]);
    expect(o.subject.ignored).toEqual(["ignored"]);
    expect(o.subject.untracked).not.toContain(".aira/control");
    git(f.root, "add", "-f", ".aira/control");
    o = await f.complete();
    expect(o.subject.index.map((e) => e.path)).not.toContain(".aira/control");
    expect(o.audit.tracked_aira).toContain(".aira/control");
    expect(gitIsClean(o)).toBe(false);
    expect(gitDirtyPolicyIssues(o, "require-clean", "isolated-local")).toHaveLength(1);
    expect(gitDirtyPolicyIssues(o, "base-only", "isolated-local")).toHaveLength(0);
    expect(gitDirtyPolicyIssues(o, "base-only", "in-place")).toHaveLength(1);
    expect(gitDirtyPolicyIssues(o, "include-observed-overlay", "isolated-local")).toHaveLength(0);
    const overlay = gitOverlayDescriptor(o);
    expect(overlay.manifest_hash).toStartWith("sha256:");
    expect(gitSourceObservation(o, provider, audit()).subject.overlay.kind).toBe("observed");
  });
  test("unsupported filenames reject instead of mangling; local adapter shares path grammar", async () => {
    const f = await fixture(); await writeFile(join(f.root, "bad\nname"), "bad");
    expect(codes(await f.observe())).toContain("workspace-git-path-unsupported");
    await rm(join(f.root, "bad\nname")); await writeFile(join(f.root, "ok file"), "ok");
    const o = await f.complete();
    const h = handle();
    const localHandle = { ...h, roots: { ...h.roots, control: { kind: "local-absolute", path: f.root },
      execution: { kind: "local-absolute", path: f.root }, relationship: "same-root" }, topology: "in-place" };
    // Local observation must see a canonical path with the same exact spelling, not the Git status encoding.
    const local = await inspectWorkspaceLocal({ handle: localHandle, executionRoot: f.root, observeSource: async () => h.source });
    expect(local.tree?.entries.map((e) => e.path)).toContain("ok file");
    expect(o.subject.untracked).toContain("ok file");
  });
});
