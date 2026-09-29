import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes, hashCanonical } from "../../src/canonical-json";
import { createWorkspaceHandle } from "../../src/workspace/handle";
import { createWorkspaceProviderCapabilities } from "../../src/workspace/provider";
import { createWorkspaceFingerprintPolicy } from "../../src/workspace/fingerprint-v2";
import { captureGitWorkspaceSource, captureGitWorkspaceFingerprint, composeGitWorkspaceFingerprint } from "../../src/workspace-capture";
import { handle as domainHandle } from "../workspace-domain/fixtures";
import type { QuiescenceEvidence } from "../../src/workspace-capture";

const dirs: string[] = [];
afterEach(async () => { for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) {
  const result = spawnSync("/usr/bin/git", args, { cwd: root, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
const proof: QuiescenceEvidence = { schema: "aira.dev/workspace-capture-quiescence/v1", token: "trusted-test", held: true };
async function fixture(format: "sha1" | "sha256" = "sha1") {
  const parent = await mkdtemp(join(tmpdir(), "aira-policy-capture-")); dirs.push(parent);
  const root = join(parent, "project"); await mkdir(root);
  git(root, "init", "-qb", "main", `--object-format=${format}`);
  git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  await writeFile(join(root, "file"), "git bytes"); git(root, "add", "file"); git(root, "commit", "-qm", "base");
  const template = domainHandle({ topology: "in-place" });
  const boot = async (policy = template.fingerprint_policy) => captureGitWorkspaceSource({
    executionRoot: root, controlRoot: root, relationship: "same-root", controlProject: template.control_project,
    project: template.project, registeredRootAssociation: hashCanonical("association"), provider: template.provider,
    capturePolicy: policy, audit: template.created, observeQuiescence: async () => proof,
  });
  return { root, parent, template, boot };
}
const codes = (r: Awaited<ReturnType<typeof captureGitWorkspaceSource>>) => r.diagnostics.map((d) => d.code);

describe("06-2B2 policy, unsupported and OID domains", () => {
  test("SHA-256 Git OID is distinct from Aira SHA-256 content identity", async () => {
    const f = await fixture("sha256"); const source = await f.boot();
    expect(source.status).toBe("complete");
    expect(source.source?.subject.source.kind === "git" && source.source.subject.source.base.kind === "git" &&
      source.source.subject.source.base.object_format).toBe("sha256");
    const h = createWorkspaceHandle({ ...f.template, source: source.source,
      repository: source.source?.subject.source.kind === "git" ? source.source.subject.source.repository : undefined,
      roots: { control: { kind: "local-absolute", path: f.root }, execution: { kind: "local-absolute", path: f.root },
        relationship: "same-root" } });
    const captured = await captureGitWorkspaceFingerprint({ handle: h, executionRoot: f.root,
      observeQuiescence: async () => proof });
    expect(captured.status).toBe("complete");
    const entry = captured.fingerprint!.subject.manifest.entries[0]!;
    expect(entry.index?.state.kind).toBe("git-object");
    expect(entry.index?.state.kind === "git-object" && entry.index.state.oid).toHaveLength(64);
    expect(entry.index?.state.kind === "git-object" && entry.index.state.oid).toBe(git(f.root, "rev-parse", "HEAD:file"));
    expect(entry.worktree.state.kind === "regular" && entry.worktree.state.hash).toBe(hashBytes(Buffer.from("git bytes")));
    expect(entry.index?.state.kind === "git-object" && entry.index.state.oid).not.toBe(hashBytes(Buffer.from("git bytes")));
  });
  test("ignored content follows pinned capture exclusions, without hidden gitignore omission", async () => {
    const f = await fixture(); await writeFile(join(f.root, ".gitignore"), "cache/\n");
    await mkdir(join(f.root, "cache")); await writeFile(join(f.root, "cache", "file"), "generated");
    const included = await f.boot();
    expect(included.status).toBe("complete");
    expect(included.git_before?.subject.ignored).toContain("cache/file");
    const policy = createWorkspaceFingerprintPolicy({ ...f.template.fingerprint_policy.configuration,
      additional_exclusions: [{ path: "cache", reason: "declared-provider-cache", affected_consumers: ["verification"] }] });
    const excluded = await f.boot(policy);
    expect(excluded.status).toBe("complete");
    expect(excluded.git_before?.subject.ignored).toEqual([]);
    expect(excluded.local?.tree?.entries.map((e) => e.path)).not.toContain("cache/file");
    expect(excluded.source?.id).not.toBe(included.source?.id);
  });
  test("submodules, nested repository, sparse and conflicted index cannot return complete source or fingerprint", async () => {
    const sub = await fixture(); await writeFile(join(sub.root, ".gitmodules"), "[submodule \"x\"]\n path = x\n");
    expect(codes(await sub.boot())).toContain("workspace-capture-unsupported");
    const nested = await fixture(); const child = join(nested.root, "nested"); await mkdir(child); git(child, "init", "-q");
    expect(codes(await nested.boot())).toContain("workspace-capture-unsupported");
    const sparse = await fixture(); git(sparse.root, "config", "core.sparseCheckout", "true");
    expect(codes(await sparse.boot())).toContain("workspace-capture-unsupported");
    const conflicted = await fixture(); const oid = git(conflicted.root, "rev-parse", "HEAD:file");
    git(conflicted.root, "update-index", "--force-remove", "file");
    const info = spawnSync("/usr/bin/git", ["update-index", "--index-info"], { cwd: conflicted.root,
      input: `100644 ${oid} 1\tfile\n`, encoding: "utf8" });
    expect(info.status).toBe(0);
    expect(codes(await conflicted.boot())).toContain("workspace-capture-unsupported");
  });
  test("policy drift and missing quiescence never mint a complete result", async () => {
    const f = await fixture(); const noProof = await captureGitWorkspaceSource({
      executionRoot: f.root, controlRoot: f.root, relationship: "same-root",
      controlProject: f.template.control_project, project: f.template.project,
      registeredRootAssociation: hashCanonical("association"), provider: f.template.provider,
      capturePolicy: f.template.fingerprint_policy, audit: f.template.created,
    });
    expect(noProof.status).toBe("incomplete"); expect(noProof.source?.subject.consistency).toBe("unknown");
    expect(noProof.fingerprint).toBeUndefined();
    const complete = await f.boot();
    const h = createWorkspaceHandle({ ...f.template, source: complete.source,
      repository: complete.source?.subject.source.kind === "git" ? complete.source.subject.source.repository : undefined,
      roots: { control: { kind: "local-absolute", path: f.root }, execution: { kind: "local-absolute", path: f.root },
        relationship: "same-root" } });
    const other = createWorkspaceFingerprintPolicy({ ...h.fingerprint_policy.configuration,
      additional_exclusions: [{ path: "cache", reason: "declared-provider-cache", affected_consumers: ["verification"] }] });
    const comparison = composeGitWorkspaceFingerprint({ handle: h, git_before: complete.git_before,
      git_after: complete.git_after, local: complete.local, capture_policy: other,
      provider: h.provider, audit: h.created, quiescence: proof });
    expect(comparison.status).toBe("incompatible"); expect(comparison.fingerprint).toBeUndefined();
  });
});
