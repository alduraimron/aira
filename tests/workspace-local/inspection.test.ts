import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, rename, rm, chmod, truncate } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes, hashCanonical } from "../../src/canonical-json";
import { createWorkspaceHandle } from "../../src/workspace/handle";
import { createWorkspaceProviderCapabilities } from "../../src/workspace/provider";
import { createWorkspaceFingerprintPolicy } from "../../src/workspace/fingerprint-v2";
import { createSourceObservation } from "../../src/workspace/source";
import { compareLocalInspections, inspectWorkspaceLocal, localInspectionPolicy } from "../../src/workspace-local";
import type { InspectWorkspaceLocalOptions } from "../../src/workspace-local";
import { handle, audit } from "../workspace-domain/fixtures";

const temp: string[] = [];
afterEach(async () => { for (const path of temp.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(snapshot = true) {
  const parent = await mkdtemp(join(tmpdir(), "aira-ws-local-")); temp.push(parent);
  const control = join(parent, "control"), root = join(parent, "execution");
  await mkdir(control); await mkdir(root);
  const original = handle(snapshot ? { snapshot: true, topology: "copied-snapshot" } : {});
  const h = createWorkspaceHandle({ ...original, roots: { control: { kind: "local-absolute", path: control },
    execution: { kind: "local-absolute", path: root }, relationship: "separate-root" } });
  const options: InspectWorkspaceLocalOptions = { handle: h, executionRoot: root, observeSource: async () => h.source };
  const categories = (paths: string[]) => paths.map((path) => ({ path, category: "untracked" as const }));
  const evidence = (paths: string[]) => ({ kind: "snapshot" as const, categories: categories(paths),
    verifyRetainedBase: async () => h.source.subject.source.base });
  return { parent, root, control, h, options, evidence };
}
const codes = (result: Awaited<ReturnType<typeof inspectWorkspaceLocal>>) => result.diagnostics.map((d) => d.code);
const inspect = (options: InspectWorkspaceLocalOptions, paths?: string[]) => inspectWorkspaceLocal({ ...options,
  ...(paths ? { snapshotEvidence: { kind: "snapshot", categories: paths.map((path) => ({ path, category: "untracked" as const })),
    verifyRetainedBase: async () => (options.handle as ReturnType<typeof handle>).source.subject.source.base } } : {}) });

describe("06-2A root and read-only boundaries", () => {
  test("trusted absolute execution root matches handle role; missing, file and symlink roots fail", async () => {
    const f = await fixture();
    expect((await inspect(f.options)).status).toBe("complete");
    expect(codes(await inspect({ ...f.options, executionRoot: f.control }))).toContain("workspace-inspection-root-invalid");
    await rm(f.root, { recursive: true });
    expect(codes(await inspect(f.options))).toContain("workspace-inspection-root-invalid");
    await writeFile(f.root, "not-directory");
    expect(codes(await inspect(f.options))).toContain("workspace-inspection-root-unsafe");
    await rm(f.root); await symlink(f.control, f.root);
    expect(codes(await inspect(f.options))).toContain("workspace-inspection-root-unsafe");
    expect(codes(await inspect({ ...f.options, executionRoot: "relative" }))).toContain("workspace-inspection-root-invalid");
  });
  test("replaced root detected; source drift at either boundary fails without a fingerprint", async () => {
    const f = await fixture();
    const result = await inspectWorkspaceLocal(f.options, { beforeFinalCheck: async () => {
      await rename(f.root, `${f.root}-old`); await mkdir(f.root);
    } });
    expect(codes(result)).toContain("workspace-inspection-root-changed");
    expect(result.fingerprint).toBeUndefined();
    const c = await fixture();
    const controlReplacement = await inspectWorkspaceLocal(c.options, { beforeFinalCheck: async () => {
      await rename(c.control, `${c.control}-old`); await mkdir(c.control);
    } });
    expect(codes(controlReplacement)).toContain("workspace-inspection-root-changed");
    const sourceDrift = await inspectWorkspaceLocal({ ...f.options, observeSource: async () => ({ ...f.h.source,
      subject: { ...f.h.source.subject, registered_root_association: hashCanonical("different") } }) });
    expect(codes(sourceDrift)).toContain("workspace-inspection-policy-incompatible");
    let calls = 0;
    const late = await inspectWorkspaceLocal({ ...f.options, observeSource: async () => ++calls === 1 ? f.h.source :
      ({ ...f.h.source, subject: { ...f.h.source.subject, registered_root_association: hashCanonical("different") } }) });
    expect(codes(late)).toContain("workspace-inspection-entry-changed");
  });
  test("inspection never writes, creates state or changes file mtime/ctime", async () => {
    const f = await fixture(); await writeFile(join(f.root, "file"), "hello");
    const before = await lstat(join(f.root, "file"), { bigint: true });
    const result = await inspect(f.options, ["file"]);
    const after = await lstat(join(f.root, "file"), { bigint: true });
    expect(result.fingerprint?.schema).toBe("aira.dev/workspace-fingerprint/v2");
    expect(await readFile(join(f.root, "file"), "utf8")).toBe("hello");
    expect(before.mtimeNs).toBe(after.mtimeNs); expect(before.ctimeNs).toBe(after.ctimeNs);
    expect(await readdir(f.control)).toEqual([]);
    expect(await readdir(f.root)).toEqual(["file"]);
  });
});

describe("06-2A local tree", () => {
  test("exact SHA-256, empty and large streamed files, executable semantics, drift", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "a"), "");
    const large = Buffer.alloc(6 * 1024 * 1024, 0x71);
    await writeFile(join(f.root, "big"), large);
    const a = await inspect(f.options, ["a", "big"]);
    expect(a.tree?.entries).toEqual([
      { path: "a", state: { kind: "regular", hash: hashBytes(Buffer.alloc(0)), bytes: 0, executable: false } },
      { path: "big", state: { kind: "regular", hash: hashBytes(large), bytes: large.length, executable: false } },
    ]);
    expect(a.fingerprint?.subject.manifest.hash).toBeDefined();
    await chmod(join(f.root, "a"), 0o755);
    const b = await inspect(f.options, ["a", "big"]);
    expect(compareLocalInspections(a, b).reasons).toContainEqual({ code: "executable-changed", path: "a" });
    await writeFile(join(f.root, "big"), "different");
    expect(compareLocalInspections(b, await inspect(f.options, ["a", "big"])).reasons).toContainEqual({ code: "content-changed", path: "big" });
  });
  test("nested files, physical and policy-empty directories, ordering and audit-independent hash", async () => {
    const a = await fixture(), b = await fixture();
    for (const f of [a, b]) { await mkdir(join(f.root, "nested")); await mkdir(join(f.root, "empty")); }
    await writeFile(join(a.root, "z"), "z"); await writeFile(join(a.root, "nested", "a"), "a");
    await writeFile(join(b.root, "nested", "a"), "a"); await writeFile(join(b.root, "z"), "z");
    const x = await inspect(a.options, ["empty", "nested/a", "z"]);
    const y = await inspect(b.options, ["z", "nested/a", "empty"]);
    expect(x.tree?.entries.map((e) => e.path)).toEqual(["empty", "nested/a", "z"]);
    expect(x.tree?.entries[0]?.state.kind).toBe("empty-directory");
    expect(x.tree?.hash).toBe(y.tree?.hash);
    expect(x.fingerprint?.id).toBe(y.fingerprint?.id);
    expect(x.root?.inode).not.toBe(y.root?.inode);
    expect(compareLocalInspections(x, y).reasons.map((r) => r.code)).toEqual(["root-replaced"]);
  });
  test("symlink target bytes, internal/external/broken never followed; target change is drift", async () => {
    const f = await fixture();
    await symlink("inside", join(f.root, "a")); await symlink("/etc/passwd", join(f.root, "b"));
    await symlink("missing", join(f.root, "c"));
    const a = await inspect(f.options, ["a", "b", "c"]);
    expect(a.tree?.entries.map((entry) => entry.state.kind)).toEqual(["symlink", "symlink", "symlink"]);
    expect(a.tree?.entries[1]?.state).toEqual({ kind: "symlink", target_hash: hashBytes(Buffer.from("/etc/passwd")), target_bytes: 11 });
    await rm(join(f.root, "b")); await symlink("/etc/group", join(f.root, "b"));
    expect(compareLocalInspections(a, await inspect(f.options, ["a", "b", "c"])).reasons)
      .toContainEqual({ code: "symlink-changed", path: "b" });
  });
  test("FIFO and sockets fail closed; no special content is read", async () => {
    const f = await fixture();
    const proc = Bun.spawnSync(["mkfifo", join(f.root, "pipe")]);
    if (proc.exitCode !== 0) return;
    const result = await inspect(f.options);
    expect(codes(result)).toContain("workspace-inspection-nonregular");
    expect(result.tree).toBeUndefined(); expect(result.fingerprint).toBeUndefined();
  });
  test("socket, sparse huge file, hardlink and invalid UTF-8 name fail closed", async () => {
    const f = await fixture();
    const socket = join(f.root, "socket");
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    try { expect(codes(await inspect(f.options))).toContain("workspace-inspection-nonregular"); }
    finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(socket, { force: true }); }
    const huge = join(f.root, "sparse");
    await writeFile(huge, ""); await truncate(huge, localInspectionPolicy.bounds.max_hashed_bytes + 1);
    expect(codes(await inspect(f.options))).toContain("workspace-inspection-byte-budget");
    await rm(huge);
    await writeFile(join(f.root, "source"), "data");
    const { link } = await import("node:fs/promises");
    await link(join(f.root, "source"), join(f.root, "alias"));
    expect(codes(await inspect(f.options))).toContain("workspace-inspection-entry-unsafe");
    await rm(join(f.root, "alias")); await rm(join(f.root, "source"));
    await writeFile(Buffer.from(`${f.root}/bad\xff`, "latin1"), "invalid");
    expect((await inspect(f.options)).status).toBe("incomplete");
  });
  test("bounded directory enumeration rejects >50,000 names without hashing them", async () => {
    const f = await fixture();
    const cap = localInspectionPolicy.bounds.max_directory_entries;
    for (let start = 0; start <= cap; start += 256) {
      const end = Math.min(start + 256, cap + 1);
      await Promise.all(Array.from({ length: end - start }, (_, i) => symlink("missing", join(f.root, `p${start + i}`))));
    }
    const result = await inspect(f.options);
    expect(codes(result)).toContain("workspace-inspection-entry-limit");
    expect(result.tree).toBeUndefined();
  }, 120000);
  test("depth, directory and global entry limits, invalid logical paths and alias collisions", async () => {
    const f = await fixture();
    let path = f.root;
    for (let i = 0; i <= localInspectionPolicy.bounds.max_depth; i++) { path = join(path, "d"); await mkdir(path); }
    expect(codes(await inspect(f.options))).toContain("workspace-inspection-depth-limit");
    const other = await fixture();
    await writeFile(join(other.root, "bad\\name"), "bad");
    expect(codes(await inspect(other.options))).toContain("workspace-inspection-path-invalid");
    await rm(join(other.root, "bad\\name"));
    await writeFile(join(other.root, "A"), "A"); await writeFile(join(other.root, "a"), "a");
    expect(codes(await inspect(other.options))).toContain("workspace-inspection-path-invalid");
  });
  test(".git dir/file, whole top-level .aira, declared cache only; ignored ordinary content included", async () => {
    const f = await fixture();
    await mkdir(join(f.root, ".git")); await writeFile(join(f.root, ".git", "HEAD"), "secret");
    await mkdir(join(f.root, ".aira")); await mkdir(join(f.root, ".aira", "state"));
    await writeFile(join(f.root, ".aira", "steering.md"), "authoring");
    await writeFile(join(f.root, ".aira", "state", "HEAD"), "control");
    await writeFile(join(f.root, ".gitignore"), "ignored\n"); await writeFile(join(f.root, "ignored"), "included");
    let result = await inspect(f.options, [".gitignore", "ignored"]);
    expect(result.tree?.entries.map((e) => e.path)).toEqual([".gitignore", "ignored"]);
    expect(result.excluded.map((e) => e.path)).toEqual([".aira", ".git"]);
    await rm(join(f.root, ".git"), { recursive: true }); await writeFile(join(f.root, ".git"), "gitdir: ../out");
    result = await inspect(f.options, [".gitignore", "ignored"]);
    expect(result.status).toBe("complete"); expect(result.excluded[1]?.reason).toBe("git-metadata");
    await rm(join(f.root, ".git")); await symlink("/etc", join(f.root, ".git"));
    expect((await inspect(f.options, [".gitignore", "ignored"])).excluded[1]?.path).toBe(".git");
    const policy = createWorkspaceFingerprintPolicy({ ...f.h.fingerprint_policy.configuration,
      additional_exclusions: [{ path: "cache", reason: "declared-provider-cache", affected_consumers: ["verification"] }] });
    const h = createWorkspaceHandle({ ...f.h, fingerprint_policy: policy,
      capabilities: createWorkspaceProviderCapabilities({ ...f.h.capabilities, fingerprint_policies: [policy.hash] }) });
    await mkdir(join(f.root, "cache")); await writeFile(join(f.root, "cache", "generated"), "skip");
    await writeFile(join(f.root, "cache-other"), "include");
    result = await inspect({ ...f.options, handle: h, observeSource: async () => h.source }, [".gitignore", "cache-other", "ignored"]);
    expect(result.excluded.map((e) => e.path)).toEqual([".aira", ".git", "cache"]);
    expect(result.tree?.entries.map((e) => e.path)).toContain("cache-other");
    await mkdir(join(f.root, "CACHE"));
    expect(codes(await inspect({ ...f.options, handle: h, observeSource: async () => h.source })))
      .toContain("workspace-inspection-path-invalid");
    await rm(join(f.root, "CACHE"), { recursive: true });
    await mkdir(join(f.root, "nested")); await mkdir(join(f.root, "nested", ".git"));
    expect(codes(await inspect(f.options))).toContain("workspace-inspection-entry-unsafe");
  });
  test("file replacement, content mutation, directory substitution and late entry changes are detected", async () => {
    const f = await fixture(); await writeFile(join(f.root, "file"), "original");
    const replaced = await inspectWorkspaceLocal(f.options, { afterFileOpen: async () => {
      await rename(join(f.root, "file"), join(f.root, "previous")); await writeFile(join(f.root, "file"), "original");
    } });
    expect(codes(replaced)).toContain("workspace-inspection-entry-changed");
    await rm(join(f.root, "previous"));
    const mutated = await inspectWorkspaceLocal(f.options, { afterFileOpen: async () => {
      await writeFile(join(f.root, "file"), "changed!");
    } });
    expect(codes(mutated)).toContain("workspace-inspection-entry-changed");
    const d = await fixture(); await mkdir(join(d.root, "child")); await writeFile(join(d.root, "child", "f"), "ok");
    const outside = join(d.parent, "outside"); await mkdir(outside); await writeFile(join(outside, "f"), "secret");
    const substituted = await inspectWorkspaceLocal(d.options, { afterDirectory: async (logical) => {
      if (logical === ".") { await rename(join(d.root, "child"), join(d.root, "old")); await symlink(outside, join(d.root, "child")); }
    } });
    expect(codes(substituted)).toContain("workspace-inspection-entry-changed");
    expect(substituted.fingerprint).toBeUndefined();
  });
});

describe("06-2A fingerprint gating and comparison", () => {
  test("retained snapshot + exhaustive classification produces strict v2; unverified base and absent categories never do", async () => {
    const f = await fixture(); await writeFile(join(f.root, "source"), "data");
    const good = await inspect(f.options, ["source"]);
    expect(good.status).toBe("complete"); expect(good.fingerprint_status).toBe("constructed");
    expect(good.fingerprint?.subject.manifest.entries[0]?.worktree.category).toBe("untracked");
    expect(good.fingerprint?.subject.repository_components).toEqual([]);
    expect(good.fingerprint?.digest).toBe(hashCanonical(good.fingerprint?.subject));
    const missing = await inspect(f.options);
    expect(missing.fingerprint).toBeUndefined();
    expect(codes(missing)).toContain("workspace-inspection-fingerprint-incomplete");
    const falseBase = await inspectWorkspaceLocal({ ...f.options, snapshotEvidence: {
      ...f.evidence(["source"]), verifyRetainedBase: async () => ({ kind: "unmaterialized", reason: "non-git-tree", tree_hash: hashCanonical("mutable") }),
    } });
    expect(falseBase.fingerprint).toBeUndefined();
    expect((await inspect(f.options, ["nonexistent"])).fingerprint).toBeUndefined();
  });
  test("snapshot evidence is detached before async observation; mutable unretained tree is not a base", async () => {
    const f = await fixture(); await writeFile(join(f.root, "file"), "x");
    const categories = [{ path: "file", category: "untracked" as "tracked" | "untracked" }];
    const captured = await inspectWorkspaceLocal({ ...f.options, snapshotEvidence: {
      kind: "snapshot", categories, verifyRetainedBase: f.evidence(["file"]).verifyRetainedBase,
    }, observeSource: async () => { categories[0]!.category = "tracked"; return f.h.source; } });
    expect(captured.fingerprint?.subject.manifest.entries[0]?.worktree.category).toBe("untracked");
    const source = createSourceObservation({ subject: { ...f.h.source.subject, source: {
      kind: "snapshot", base: { kind: "unmaterialized", reason: "non-git-tree", tree_hash: hashCanonical("tree") },
      observed_tree: hashCanonical("tree"),
    } }, audit: audit() });
    expect(() => createWorkspaceHandle({ ...f.h, source })).toThrow();
  });
  test("clean same-root snapshot binds actual local digest to reviewed tree", async () => {
    const f = await fixture(); await writeFile(join(f.root, "file"), "x");
    const observed = await inspect(f.options, ["file"]);
    const base = f.h.source.subject.source.base;
    if (base.kind !== "snapshot") throw new Error("snapshot fixture");
    const source = createSourceObservation({ subject: { ...f.h.source.subject, source: {
      kind: "snapshot", base: { ...base, captured_tree_hash: observed.tree!.hash }, observed_tree: observed.tree!.hash,
    } }, audit: audit() });
    const h = createWorkspaceHandle({ ...f.h, topology: "in-place", source,
      roots: { control: { kind: "local-absolute", path: f.root }, execution: { kind: "local-absolute", path: f.root },
        relationship: "same-root" } });
    const options = { handle: h, executionRoot: f.root, observeSource: async () => h.source,
      snapshotEvidence: { kind: "snapshot" as const, categories: [{ path: "file", category: "untracked" as const }],
        verifyRetainedBase: async () => h.source.subject.source.base } };
    expect((await inspectWorkspaceLocal(options)).fingerprint).toBeDefined();
    await writeFile(join(f.root, "file"), "changed");
    expect((await inspectWorkspaceLocal(options)).fingerprint).toBeUndefined();
  });
  test("Git has local manifest but no complete Git semantic fingerprint", async () => {
    const f = await fixture(false); await writeFile(join(f.root, "maybe-tracked"), "contents");
    const value = await inspect(f.options);
    expect(value.status).toBe("complete"); expect(value.tree?.entries[0]?.path).toBe("maybe-tracked");
    expect(value.fingerprint).toBeUndefined(); expect(value.fingerprint_status).toBe("incomplete");
    expect(codes(value)).toContain("workspace-inspection-fingerprint-incomplete");
  });
  test("drift detects addition, removal, content, root and policy; timestamps do not identify tree", async () => {
    const f = await fixture(); await writeFile(join(f.root, "a"), "one");
    const a = await inspect(f.options, ["a"]);
    expect(compareLocalInspections(a, await inspect(f.options, ["a"])).status).toBe("match");
    await writeFile(join(f.root, "b"), "two");
    const b = await inspect(f.options, ["a", "b"]);
    expect(compareLocalInspections(a, b).reasons).toContainEqual({ code: "file-added", path: "b" });
    await rm(join(f.root, "a"));
    expect(compareLocalInspections(b, await inspect(f.options, ["b"])).reasons).toContainEqual({ code: "file-removed", path: "a" });
    expect(compareLocalInspections(a, { ...a, tree: { ...a.tree!, policy_hash: hashCanonical("new") } }).status).toBe("incomplete");
    expect(Object.isFrozen(a) && Object.isFrozen(a.tree?.entries) && Object.isFrozen(a.fingerprint?.subject.manifest.entries)).toBe(true);
  });
});
