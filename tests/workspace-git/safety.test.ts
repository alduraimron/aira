import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashCanonical } from "../../src/canonical-json";
import { defaultWorkspaceFingerprintPolicy, createWorkspaceFingerprintPolicy } from "../../src/workspace/fingerprint-v2";
import { compareGitObservations, createGitObservation, gitInspectionPolicy, inspectWorkspaceGit } from "../../src/workspace-git";
import { GitInspectionError, runReadOnlyGit, gitReadOnlyEnvironment } from "../../src/workspace-git/runner";
import type { GitObservation, InspectGitOptions } from "../../src/workspace-git";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): string {
  const r = spawnSync("/usr/bin/git", args, { cwd: root, encoding: "utf8", env: { ...process.env,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
async function repo() {
  const parent = await mkdtemp(join(tmpdir(), "aira-git-safety-")); dirs.push(parent);
  const root = join(parent, "repo"); await mkdir(root);
  git(root, "init", "-qb", "main"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  await writeFile(join(root, "f"), "base"); git(root, "add", "f"); git(root, "commit", "-qm", "base");
  const options: InspectGitOptions = { executionRoot: root, controlProject: "control_project_one" as InspectGitOptions["controlProject"],
    project: "project_one" as InspectGitOptions["project"], registeredRootAssociation: hashCanonical("registration"),
    capturePolicy: defaultWorkspaceFingerprintPolicy() };
  const observe = () => inspectWorkspaceGit(options);
  const complete = async () => {
    const result = await observe();
    if (!result.observation || result.status !== "complete") throw new Error(JSON.stringify(result.diagnostics));
    return result.observation;
  };
  return { parent, root, options, observe, complete };
}
const codes = (o: Awaited<ReturnType<typeof inspectWorkspaceGit>>) => o.diagnostics.map((d) => d.code);

describe("06-2B1 unsupported Git states", () => {
  test("sparse checkout, gitlink, .gitmodules and nested repo are never ordinary content", async () => {
    const f = await repo(); git(f.root, "config", "core.sparseCheckout", "true");
    expect(codes(await f.observe())).toContain("workspace-git-sparse-unsupported");
    git(f.root, "config", "core.sparseCheckout", "false");
    const sub = join(f.parent, "sub"); await mkdir(sub); git(sub, "init", "-q");
    const nested = join(f.root, "nested"); await mkdir(nested); git(nested, "init", "-q");
    expect(codes(await f.observe())).toContain("workspace-git-nested-repository");
    await rm(nested, { recursive: true });
    await writeFile(join(f.root, ".gitignore"), "ignored-nested/\n");
    const ignoredNested = join(f.root, "ignored-nested"); await mkdir(ignoredNested); git(ignoredNested, "init", "-q");
    expect(codes(await f.observe())).toContain("workspace-git-nested-repository");
    await rm(ignoredNested, { recursive: true }); await rm(join(f.root, ".gitignore"));
    const commit = git(f.root, "rev-parse", "HEAD");
    git(f.root, "update-index", "--add", "--cacheinfo", `160000,${commit},submodule`);
    const rejected = await f.observe();
    expect(codes(rejected)).toContain("workspace-git-submodule-unsupported");
    expect(rejected.observation?.subject.submodules).toEqual([{ path: "submodule", mode: "160000", oid: commit }]);
    git(f.root, "commit", "-qm", "gitlink-in-base");
    git(f.root, "update-index", "--force-remove", "submodule");
    const stagedDelete = await f.observe();
    expect(codes(stagedDelete)).toContain("workspace-git-submodule-unsupported");
    expect(stagedDelete.observation?.subject.submodules[0]?.oid).toBe(commit);
    await writeFile(join(f.root, ".gitmodules"), "[submodule \"x\"]\n path = sub\n");
    expect(codes(await f.observe())).toContain("workspace-git-submodule-unsupported");
  });
  test("external Git filters are rejected before status could run them", async () => {
    const f = await repo();
    await writeFile(join(f.root, ".gitattributes"), "f filter=unsafe\n");
    const sentinel = join(f.parent, "filter-ran");
    git(f.root, "config", "filter.unsafe.clean", `touch ${sentinel}`);
    await writeFile(join(f.root, "f"), "modified");
    expect(codes(await f.observe())).toContain("workspace-git-policy-incompatible");
    expect(await lstat(sentinel).then(() => true, () => false)).toBe(false);
    git(f.root, "config", "--unset", "filter.unsafe.clean");
    git(f.root, "config", "include.path", join(f.parent, "outside-config"));
    expect(codes(await f.observe())).toContain("workspace-git-policy-incompatible");
  });
  test("index skip-worktree and assume-unchanged flags cannot hide dirty worktree content", async () => {
    const f = await repo();
    git(f.root, "update-index", "--skip-worktree", "f");
    expect(codes(await f.observe())).toContain("workspace-git-sparse-unsupported");
    git(f.root, "update-index", "--no-skip-worktree", "f");
    git(f.root, "update-index", "--assume-unchanged", "f");
    await writeFile(join(f.root, "f"), "hidden-change");
    expect(codes(await f.observe())).toContain("workspace-git-policy-incompatible");
  });
  test("ignored directories enumerate individual files, cache exclusion is explicit and versioned", async () => {
    const f = await repo(); await writeFile(join(f.root, ".gitignore"), "ignored/\n");
    await mkdir(join(f.root, "ignored")); await mkdir(join(f.root, "ignored", "inner"));
    await writeFile(join(f.root, "ignored", "one"), "1"); await writeFile(join(f.root, "ignored", "inner", "two"), "2");
    const observed = await f.complete();
    expect(observed.subject.ignored).toEqual(["ignored/inner/two", "ignored/one"]);
    const capture = createWorkspaceFingerprintPolicy({ ...f.options.capturePolicy.configuration,
      additional_exclusions: [{ path: "ignored", reason: "declared-provider-cache", affected_consumers: ["verification"] }] });
    const excluded = await inspectWorkspaceGit({ ...f.options, capturePolicy: capture });
    expect(excluded.status).toBe("complete");
    expect(excluded.observation?.subject.ignored).toEqual([]);
    expect(compareGitObservations(observed, excluded.observation).status).toBe("incompatible-policy");
  });
  test("unicode aliases, byte-invalid name and symlink transition are explicit", async () => {
    const f = await repo();
    await writeFile(join(f.root, "A"), "x"); await writeFile(join(f.root, "a"), "y");
    expect(codes(await f.observe())).toContain("workspace-git-path-unsupported");
    await rm(join(f.root, "a")); await rm(join(f.root, "A"));
    await writeFile(Buffer.concat([Buffer.from(f.root + "/invalid"), Buffer.from([0xff])]), "bad");
    expect(codes(await f.observe())).toContain("workspace-git-path-unsupported");
    await rm(Buffer.concat([Buffer.from(f.root + "/invalid"), Buffer.from([0xff])]));
    await rm(join(f.root, "f")); await symlink("target", join(f.root, "f"));
    const link = await f.complete();
    expect(link.subject.tracked.find((e) => e.path === "f")?.kind).toBe("type-change");
  });
});

describe("06-2B1 coherence, read-only and bounded commands", () => {
  test("HEAD, index, tracked and ignored/untracked races fail instead of returning a hybrid observation", async () => {
    const f = await repo();
    const head = await inspectWorkspaceGit(f.options, { afterAnchor: async () => {
      await writeFile(join(f.root, "new"), "new"); git(f.root, "add", "new"); git(f.root, "commit", "-qm", "next");
    } });
    expect(codes(head)).toContain("workspace-git-state-changed");
    const index = await inspectWorkspaceGit(f.options, { afterAnchor: async () => {
      await writeFile(join(f.root, "newer"), "newer"); git(f.root, "add", "newer");
    } });
    expect(codes(index)).toContain("workspace-git-index-changed");
    const tracked = await inspectWorkspaceGit(f.options, { beforeFinalAnchor: async () => { await writeFile(join(f.root, "f"), "changed"); } });
    expect(codes(tracked)).toContain("workspace-git-state-changed");
    const ignored = await inspectWorkspaceGit(f.options, { beforeFinalAnchor: async () => { await writeFile(join(f.root, ".gitignore"), "new-file\n"); } });
    expect(codes(ignored)).toContain("workspace-git-state-changed");
  });
  test("index, HEAD, config, refs and worktree bytes do not change during repeated inspection", async () => {
    const f = await repo(); await writeFile(join(f.root, "new"), "untracked");
    const files = [".git/index", ".git/HEAD", ".git/config", ".git/refs/heads/main", "f", "new"];
    const before = await Promise.all(files.map((p) => readFile(join(f.root, p))));
    const indexStat = await lstat(join(f.root, ".git", "index"), { bigint: true });
    const first = await f.complete(), second = await f.complete();
    expect(first.hash).toBe(second.hash);
    for (const [i, path] of files.entries()) expect(await readFile(join(f.root, path))).toEqual(before[i]!);
    const after = await lstat(join(f.root, ".git", "index"), { bigint: true });
    expect(indexStat.mtimeNs).toBe(after.mtimeNs); expect(indexStat.ctimeNs).toBe(after.ctimeNs);
    expect(gitReadOnlyEnvironment(f.root).GIT_OPTIONAL_LOCKS).toBe("0");
    expect(gitReadOnlyEnvironment(f.root).GIT_TERMINAL_PROMPT).toBe("0");
    expect(gitInspectionPolicy.hash).toBe(hashCanonical(Object.fromEntries(Object.entries(gitInspectionPolicy).filter(([k]) => k !== "hash"))));
  });
  test("command errors, timeout and bounded output are structured; runner rejects write subcommands", async () => {
    const f = await repo();
    expect(codes(await inspectWorkspaceGit(f.options, {}, async () => {
      throw new GitInspectionError("workspace-git-timeout");
    }))).toContain("workspace-git-timeout");
    expect(codes(await inspectWorkspaceGit(f.options, {}, async () => {
      throw new Error("child failed");
    }))).toContain("workspace-git-command-failed");
    expect(codes(await inspectWorkspaceGit(f.options, {}, async () => Buffer.alloc(gitInspectionPolicy.bounds.stdout_bytes + 1))))
      .toContain("workspace-git-output-limit");
    const oversizedIgnored = Buffer.from("x\0".repeat(gitInspectionPolicy.bounds.max_ignored + 1));
    expect(codes(await inspectWorkspaceGit(f.options, {}, async (args, cwd) =>
      args[0] === "ls-files" && args.includes("--ignored") ? oversizedIgnored : runReadOnlyGit(args, cwd))))
      .toContain("workspace-git-output-limit");
    await writeFile(join(f.root, ".git", "config"), "not a config section\n");
    expect(codes(await f.observe())).toContain("workspace-git-command-failed");
    await expect(runReadOnlyGit(["checkout", "--force"], f.root)).rejects.toHaveProperty("code", "workspace-git-command-failed");
  });
  test("pure comparison distinguishes base, staged index, untracked, ignored, policy and invalid identity", async () => {
    const f = await repo(); const initial = await f.complete();
    await writeFile(join(f.root, "new"), "new"); const untracked = await f.complete();
    expect(compareGitObservations(initial, untracked).reasons).toContain("untracked-changed");
    git(f.root, "add", "new"); const staged = await f.complete();
    expect(compareGitObservations(untracked, staged).reasons).toContain("index-changed");
    await writeFile(join(f.root, ".gitignore"), "ignored*\n");
    await writeFile(join(f.root, "ignored"), "ignored"); await writeFile(join(f.root, "ignored2"), "ignored too");
    const ignored = await f.complete(); expect(compareGitObservations(staged, ignored).reasons).toContain("ignored-changed");
    git(f.root, "add", ".gitignore"); git(f.root, "commit", "-qm", "new");
    expect(compareGitObservations(ignored, await f.complete()).reasons).toContain("head-base-changed");
    const alternate = createGitObservation({ ...initial.subject, policy_hash: hashCanonical("other-policy") }, initial.audit);
    expect(compareGitObservations(initial, alternate).status).toBe("incompatible-policy");
    expect(compareGitObservations(initial, { ...initial, hash: hashCanonical("fake") }).status).toBe("invalid-input");
    const reordered = createGitObservation({ ...ignored.subject, ignored: [...ignored.subject.ignored].reverse() },
      { ...ignored.audit, started_at: "another", ended_at: "later" });
    expect(reordered.hash).toBe(ignored.hash);
  });
});
