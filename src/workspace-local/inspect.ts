import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, readlink, realpath, statfs } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { hashBytes } from "../canonical-json";
import { contentHashSchema, compareText, exact } from "../spec/domain/primitives";
import { freeze } from "../workspace/domain";
import { validateWorkspaceHandle, type WorkspaceHandleV2 } from "../workspace/handle";
import { sourceObservationSchema } from "../workspace/source";
import { localInspectionPolicy, excludedByPolicy, type ExclusionReason } from "./policy";
import { aliasKey, makeLocalTree, validLogicalPath } from "./manifest";
import { constructLocalFingerprint } from "./fingerprint";
import type { InspectWorkspaceLocalOptions, InspectionIssue, InspectionIssueCode, LocalTreeEntry,
  WorkspaceLocalInspection, RootAudit } from "./types";

type Stat = BigIntStats;
interface Directory { path: string; logical: string; stat: Stat }
interface Root { path: string; stat: Stat }
interface State {
  entries: LocalTreeEntry[]; excluded: { path: string; reason: ExclusionReason }[];
  rejected: string[]; diagnostics: InspectionIssue[]; directories: Directory[]; observed: { logical: string; stat: Stat }[];
  aliases: Set<string>; visited: number; hashed: bigint;
}
/** Hooks are trusted test instrumentation, not part of the semantic policy or public index. */
export interface InspectionTestHooks {
  afterDirectory?: (logical: string) => Promise<void> | void;
  afterFileOpen?: (logical: string) => Promise<void> | void;
  beforeFinalCheck?: () => Promise<void> | void;
}
class InspectionFailure extends Error {
  constructor(readonly code: InspectionIssueCode, readonly logical: string, readonly detail?: string) { super(code); }
}
const fail = (code: InspectionIssueCode, logical: string, detail?: string): never => { throw new InspectionFailure(code, logical, detail); };
const errno = (error: unknown): string | undefined => typeof error === "object" && error !== null && "code" in error &&
  typeof error.code === "string" ? error.code : undefined;
const issue = (code: InspectionIssueCode, path: string, detail?: string): InspectionIssue =>
  ({ code, path, ...(detail ? { detail } : {}) });
const diagnostic = (error: unknown, path: string): InspectionIssue => error instanceof InspectionFailure ?
  issue(error.code, error.logical, error.detail) :
  issue(errno(error) === "ENOENT" || errno(error) === "ENOTDIR" ? "workspace-inspection-entry-changed" :
    "workspace-inspection-entry-unsafe", path, errno(error) ?? "io-failed");
const sameIdentity = (a: Stat, b: Stat) => a.dev === b.dev && a.ino === b.ino;
const sameStat = (a: Stat, b: Stat) => sameIdentity(a, b) && a.mode === b.mode && a.nlink === b.nlink &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const rootAudit = (r: Root): RootAudit => ({ path: r.path, device: r.stat.dev.toString(), inode: r.stat.ino.toString() });
const inside = (root: string, target: string): boolean => {
  const part = relative(root, target);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};

async function rootAt(path: string, checkFilesystem = true): Promise<Root> {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path.length > 4096)
    fail("workspace-inspection-root-invalid", ".", "canonical-absolute-root-required");
  const parts = relative(parse(path).root, path).split(sep).filter(Boolean);
  let cursor = parse(path).root;
  for (const part of parts) {
    cursor = join(cursor, part);
    let st!: Stat;
    try { st = await lstat(cursor, { bigint: true }); }
    catch (error) { fail("workspace-inspection-root-invalid", ".", errno(error) ?? "root-unreadable"); }
    if (!st.isDirectory() || st.isSymbolicLink()) fail("workspace-inspection-root-unsafe", ".", "symlink-or-nondirectory-ancestor");
  }
  let stat!: Stat;
  try { stat = await lstat(path, { bigint: true });
    if (await realpath(path) !== path) fail("workspace-inspection-root-unsafe", ".", "noncanonical-root");
  } catch (error) {
    if (error instanceof InspectionFailure) throw error;
    fail("workspace-inspection-root-invalid", ".", errno(error) ?? "root-unreadable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("workspace-inspection-root-unsafe", ".", "not-a-real-directory");
  if (checkFilesystem) {
    let type: number;
    try { type = (await statfs(path)).type >>> 0; }
    catch (error) { fail("workspace-inspection-root-unsafe", ".", errno(error) ?? "statfs-unavailable"); }
    // Local Linux filesystems only. Network/FUSE mount semantics are not certified.
    if ([0x6969, 0xff534d42, 0xfe534d42, 0x517b, 0x01021997, 0x00c36400, 0x5346414f, 0x65735546].includes(type!))
      fail("workspace-inspection-policy-incompatible", ".", "network-or-fuse-filesystem");
  }
  return { path, stat };
}
async function checkRoot(root: Root): Promise<void> {
  let now!: Root;
  try { now = await rootAt(root.path, false); }
  catch { fail("workspace-inspection-root-changed", "."); }
  if (!sameIdentity(root.stat, now.stat)) fail("workspace-inspection-root-changed", ".", "root-replaced");
}
/** Pathname checks are best-effort, not kernel dirfd confinement. The final symlink itself is allowed. */
async function checkPath(root: Root, logical: string, expected?: Stat): Promise<Stat> {
  await checkRoot(root);
  const target = logical === "." ? root.path : join(root.path, logical);
  if (!inside(root.path, target)) fail("workspace-inspection-path-invalid", logical);
  let cursor = root.path;
  const segments = logical === "." ? [] : logical.split("/");
  let stat = root.stat;
  if (!segments.length) {
    try { stat = await lstat(root.path, { bigint: true }); }
    catch (error) { fail("workspace-inspection-root-changed", ".", errno(error) ?? "root-lstat-failed"); }
  }
  for (const [index, part] of segments.entries()) {
    cursor = join(cursor, part);
    try { stat = await lstat(cursor, { bigint: true }); }
    catch (error) { fail("workspace-inspection-entry-changed", logical, errno(error) ?? "lstat-failed"); }
    if (stat.dev !== root.stat.dev) fail("workspace-inspection-entry-unsafe", logical, "cross-device");
    if (index < segments.length - 1 && !stat.isDirectory())
      fail("workspace-inspection-entry-unsafe", logical, "symlink-or-nondirectory-ancestor");
  }
  if (expected && !sameStat(stat, expected)) fail("workspace-inspection-entry-changed", logical, "path-substituted");
  if (stat.isDirectory() || stat.isFile()) {
    try { if (await realpath(target) !== target) fail("workspace-inspection-entry-unsafe", logical, "noncanonical-path"); }
    catch (error) {
      if (error instanceof InspectionFailure) throw error;
      fail("workspace-inspection-entry-changed", logical, errno(error) ?? "realpath-failed");
    }
  }
  return stat;
}
const policyBounds = localInspectionPolicy.bounds;
async function directoryNames(root: Root, logical: string, previous: Stat, state: State): Promise<string[]> {
  const absolute = logical === "." ? root.path : join(root.path, logical);
  await checkPath(root, logical, previous);
  if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK)
    fail("workspace-inspection-policy-incompatible", logical, "no-follow-unavailable");
  const fd = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK);
  let names: string[] = [];
  try {
    if (!sameStat(previous, await fd.stat({ bigint: true }))) fail("workspace-inspection-entry-changed", logical, "directory-open-race");
    // Bounded streaming enumeration: never allocate/sort an unbounded directory listing.
    const dir = await opendir(absolute, { encoding: "utf8" });
    try {
      for await (const entry of dir) {
        if (names.length >= policyBounds.max_directory_entries || state.visited >= policyBounds.max_total_entries)
          fail("workspace-inspection-entry-limit", logical);
        state.visited++;
        // A lossy decoded native name cannot be opened by its logical UTF-8 path;
        // subsequent lstat fails closed. An alias of a valid U+FFFD name is rejected.
        names.push(entry.name);
      }
    } finally { try { await dir.close(); } catch { /* for-await may already have closed it */ } }
    names.sort(compareText);
    await checkPath(root, logical, previous);
    if (!sameStat(previous, await fd.stat({ bigint: true }))) fail("workspace-inspection-entry-changed", logical, "directory-mutated");
  } finally { await fd.close(); }
  state.directories.push({ path: absolute, logical, stat: previous });
  return names;
}
async function fileState(root: Root, logical: string, before: Stat, state: State, hooks: InspectionTestHooks) {
  if (!before.isFile() || before.nlink !== 1n) fail("workspace-inspection-entry-unsafe", logical, "file-hardlink-or-type");
  const limit = BigInt(policyBounds.max_hashed_bytes);
  if (before.size < 0n || state.hashed + before.size > limit || before.size > BigInt(Number.MAX_SAFE_INTEGER))
    fail("workspace-inspection-byte-budget", logical);
  const absolute = join(root.path, logical);
  await checkPath(root, logical, before);
  const fd = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await fd.stat({ bigint: true });
    if (!opened.isFile() || !sameStat(before, opened)) fail("workspace-inspection-entry-changed", logical, "file-open-race");
    await hooks.afterFileOpen?.(logical);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(65536);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (state.hashed + BigInt(bytes) > limit || !Number.isSafeInteger(bytes))
        fail("workspace-inspection-byte-budget", logical);
      hash.update(chunk.subarray(0, bytesRead));
    }
    const final = await fd.stat({ bigint: true });
    await checkPath(root, logical, before);
    if (!sameStat(opened, final) || BigInt(bytes) !== final.size)
      fail("workspace-inspection-entry-changed", logical, "file-mutated-during-read");
    state.hashed += BigInt(bytes);
    return { kind: "regular" as const, hash: contentHashSchema.parse(`sha256:${hash.digest("hex")}`),
      bytes, executable: (Number(final.mode) & 0o111) !== 0 };
  } finally { await fd.close(); }
}
async function linkState(root: Root, logical: string, before: Stat) {
  if (before.size > BigInt(policyBounds.max_symlink_target_bytes)) fail("workspace-inspection-byte-budget", logical, "link-target-too-large");
  await checkPath(root, logical, before);
  const target = await readlink(join(root.path, logical), { encoding: "buffer" });
  if (target.length > policyBounds.max_symlink_target_bytes) fail("workspace-inspection-byte-budget", logical, "link-target-too-large");
  await checkPath(root, logical, before);
  return { kind: "symlink" as const, target_hash: hashBytes(target), target_bytes: target.length };
}

async function scan(root: Root, handle: WorkspaceHandleV2, state: State, hooks: InspectionTestHooks): Promise<void> {
  const stack: { logical: string; depth: number; stat: Stat }[] = [{ logical: ".", depth: 0, stat: root.stat }];
  const policy = handle.fingerprint_policy.configuration;
  const exclusions = [...policy.exclusions, ...policy.additional_exclusions];
  while (stack.length) {
    const dir = stack.pop()!;
    const names = await directoryNames(root, dir.logical, dir.stat, state);
    await hooks.afterDirectory?.(dir.logical);
    let visible = 0;
    for (const name of names) {
      const logical = dir.logical === "." ? name : `${dir.logical}/${name}`;
      if (!validLogicalPath(logical, policyBounds.max_path_bytes)) fail("workspace-inspection-path-invalid", logical);
      const alias = aliasKey(logical);
      if (state.aliases.has(alias)) fail("workspace-inspection-path-invalid", logical, "ambiguous-path-alias");
      state.aliases.add(alias);
      // Never interpret an alias of an exclusion as an unexcluded content path.
      if (exclusions.some((item) => (alias === aliasKey(item.path) || alias.startsWith(`${aliasKey(item.path)}/`)) &&
          logical !== item.path && !logical.startsWith(`${item.path}/`)))
        fail("workspace-inspection-path-invalid", logical, "excluded-path-alias");
      const excluded = excludedByPolicy(logical, exclusions);
      if (excluded) {
        state.excluded.push({ path: logical, reason: excluded });
        continue;
      }
      if (dir.logical === "." && [".git", ".aira"].includes(alias) ||
          dir.logical !== "." && aliasKey(name) === ".git")
        fail("workspace-inspection-entry-unsafe", logical, "reserved-alias-or-nested-repository");
      visible++;
      if (dir.depth + 1 > policyBounds.max_depth) fail("workspace-inspection-depth-limit", logical);
      const stat = await checkPath(root, logical);
      if (stat.isDirectory()) stack.push({ logical, depth: dir.depth + 1, stat });
      else if (stat.isFile()) {
        state.entries.push({ path: logical, state: await fileState(root, logical, stat, state, hooks) });
        state.observed.push({ logical, stat });
      } else if (stat.isSymbolicLink()) {
        state.entries.push({ path: logical, state: await linkState(root, logical, stat) });
        state.observed.push({ logical, stat });
      }
      else fail("workspace-inspection-nonregular", logical);
      if (state.entries.length > policyBounds.max_manifest_entries)
        fail("workspace-inspection-entry-limit", logical, "manifest-limit");
    }
    if (!visible && dir.logical !== ".") {
      state.entries.push({ path: dir.logical, state: { kind: "empty-directory" } });
      if (state.entries.length > policyBounds.max_manifest_entries) fail("workspace-inspection-entry-limit", dir.logical, "manifest-limit");
    }
    await checkPath(root, dir.logical, dir.stat);
  }
}

/** Read-only observation. A partial scan is never given a semantic tree hash or a fingerprint. */
export async function inspectWorkspaceLocal(options: InspectWorkspaceLocalOptions, hooks: InspectionTestHooks = {}): Promise<WorkspaceLocalInspection> {
  const parsed = validateWorkspaceHandle(options?.handle);
  const h = parsed.ok ? parsed.value : undefined;
  // Detach caller-owned classification before the first asynchronous filesystem/source boundary.
  const evidence = options?.snapshotEvidence;
  const pinnedEvidence = evidence && evidence.kind === "snapshot" && Array.isArray(evidence.categories) &&
    evidence.categories.length <= policyBounds.max_manifest_entries &&
    evidence.categories.every((item) => item && typeof item.path === "string" &&
      ["tracked", "untracked", "ignored"].includes(item.category)) &&
    typeof evidence.verifyRetainedBase === "function" ? {
      kind: "snapshot" as const, categories: evidence.categories.map((item) => ({ path: item.path, category: item.category })),
      verifyRetainedBase: evidence.verifyRetainedBase,
    } : undefined;
  const state: State = { entries: [], excluded: [], rejected: [], diagnostics: [], directories: [], observed: [], aliases: new Set(), visited: 0, hashed: 0n };
  const result = (root?: Root, fingerprint?: WorkspaceLocalInspection["fingerprint"]): WorkspaceLocalInspection => {
    const diagnostics = [...state.diagnostics];
    if (diagnostics.length) diagnostics.push(issue("workspace-inspection-incomplete", "."));
    const sorted = diagnostics.sort((a, b) => compareText(a.path, b.path) || compareText(a.code, b.code));
    return freeze({ schema: "aira.dev/workspace-local-inspection-result/v1" as const, policy: localInspectionPolicy,
      workspace_id: h?.id ?? "<invalid>", incarnation: h?.incarnation ?? "<invalid>",
      ...(root ? { root: rootAudit(root) } : {}), status: diagnostics.length ? "incomplete" as const : "complete" as const,
      fingerprint_status: fingerprint && !diagnostics.length ? "constructed" as const : "incomplete" as const,
      ...(!diagnostics.length && h ? { tree: makeLocalTree(state.entries, localInspectionPolicy, h.fingerprint_policy) } : {}),
      excluded: state.excluded.sort((a, b) => compareText(a.path, b.path)),
      rejected: state.rejected.sort(compareText), diagnostics: sorted,
      ...(fingerprint && !diagnostics.length ? { fingerprint } : {}),
    });
  };
  if (!h || h.roots.execution.kind !== "local-absolute" || options.executionRoot !== (h.roots.execution.kind === "local-absolute" ? h.roots.execution.path : undefined) ||
      process.platform !== "linux" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK) {
    state.diagnostics.push(issue(!h || options.executionRoot !== (h?.roots.execution.kind === "local-absolute" ? h.roots.execution.path : undefined) || h?.roots.execution.kind !== "local-absolute" ?
      "workspace-inspection-root-invalid" : "workspace-inspection-policy-incompatible", "."));
    return result();
  }
  let root: Root | undefined;
  let control: Root | undefined;
  try {
    root = await rootAt(options.executionRoot);
    // Both local roles are observed. A physical alias cannot masquerade as separate-root.
    if (h.roots.control.kind === "local-absolute") {
      control = await rootAt(h.roots.control.path);
      if (h.roots.relationship === "separate-root" &&
          (sameIdentity(root.stat, control.stat) || inside(root.path, control.path) || inside(control.path, root.path)))
        fail("workspace-inspection-root-unsafe", ".", "control-execution-overlap");
    }
    if (typeof options.observeSource !== "function")
      fail("workspace-inspection-policy-incompatible", ".", "trusted-source-observer-required");
    const before = sourceObservationSchema.safeParse(await options.observeSource());
    if (!before.success || !exact(before.data.subject, h.source.subject) || before.data.id !== h.source.id)
      fail("workspace-inspection-policy-incompatible", ".", "source-stale-or-unavailable");
    await scan(root, h, state, hooks);
    await hooks.beforeFinalCheck?.();
    for (const dir of state.directories) await checkPath(root, dir.logical, dir.stat);
    for (const entry of state.observed) await checkPath(root, entry.logical, entry.stat);
    await checkRoot(root);
    const fingerprint = await constructLocalFingerprint(h, makeLocalTree(state.entries, localInspectionPolicy, h.fingerprint_policy),
      pinnedEvidence);
    // Evidence callbacks can take time; all filesystem and source rechecks come after them.
    for (const dir of state.directories) await checkPath(root, dir.logical, dir.stat);
    for (const entry of state.observed) await checkPath(root, entry.logical, entry.stat);
    await checkRoot(root);
    if (control) await checkRoot(control);
    const after = sourceObservationSchema.safeParse(await options.observeSource());
    if (!after.success || !exact(after.data.subject, h.source.subject) || after.data.id !== h.source.id)
      fail("workspace-inspection-entry-changed", ".", "source-changed-during-capture");
    if (!fingerprint) state.diagnostics.push(issue("workspace-inspection-fingerprint-incomplete", "."));
    // An incomplete semantic fingerprint is not an incomplete filesystem scan.
    if (state.diagnostics.length === 1 && state.diagnostics[0]?.code === "workspace-inspection-fingerprint-incomplete") {
      const only = state.diagnostics.pop()!;
      const observed = result(root);
      return freeze({ ...observed, diagnostics: [only] });
    }
    return result(root, fingerprint);
  } catch (error) {
    const value = diagnostic(error, ".");
    state.diagnostics.push(value);
    state.rejected.push(value.path);
    if (root) {
      try { await checkRoot(root); }
      catch { if (value.code !== "workspace-inspection-root-changed") state.diagnostics.push(issue("workspace-inspection-root-changed", ".")); }
    }
    return result(root);
  }
}
