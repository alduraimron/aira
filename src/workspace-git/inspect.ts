import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { hashCanonical } from "../canonical-json";
import { contentHashSchema, compareText, exact, type ContentHash } from "../spec/domain/primitives";
import { freeze } from "../workspace/domain";
import { controlProjectIdSchema, projectIdentitySchema } from "../workspace/ids";
import { workspaceFingerprintPolicySchema } from "../workspace/fingerprint-v2";
import { aliasKey, validLogicalPath } from "../workspace-local/manifest";
import { gitInspectionPolicy } from "./policy";
import { createGitObservation } from "./observation";
import { GitInspectionError, runReadOnlyGit, type GitReader } from "./runner";
import type { GitChange, GitEntry, GitHead, GitInspection, GitInspectionHooks, GitIssue,
  GitIssueCode, GitMode, GitObjectFormat, GitObservationSubject, InspectGitOptions } from "./types";

const bounds = gitInspectionPolicy.bounds;
const decoder = new TextDecoder("utf-8", { fatal: true });
const fail = (code: GitIssueCode, detail?: string, path?: string): never => { throw new GitInspectionError(code, detail, path); };
const decode = (bytes: Uint8Array): string => {
  try { return decoder.decode(bytes); } catch { return fail("workspace-git-path-unsupported", "invalid-utf8"); }
};
const text = (buffer: Buffer): string => {
  if (buffer.length > 4096) fail("workspace-git-output-limit", "metadata-line");
  return decode(buffer).trimEnd();
};
const mode = (value: string): GitMode => {
  if (value === "100644" || value === "100755" || value === "120000" || value === "160000") return value;
  return fail("workspace-git-command-failed", "unsupported-git-mode");
};
const oid = (value: string, format: GitObjectFormat): string => {
  if (!new RegExp(`^[a-f0-9]{${format === "sha1" ? 40 : 64}}$`).test(value))
    fail("workspace-git-command-failed", "invalid-object-id");
  return value;
};
const inside = (root: string, target: string): boolean => {
  const part = relative(root, target);
  return part === "" || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
const sameStat = (a: import("node:fs").BigIntStats, b: import("node:fs").BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Only the supplied root may contain .git; Git's usual parent-directory discovery is not authority. */
async function checkedRoot(root: string) {
  if (process.platform !== "linux" || !constants.O_NOFOLLOW || !isAbsolute(root) || resolve(root) !== root || root.length > 4096)
    fail("workspace-git-root-mismatch", "canonical-linux-root-required");
  let cursor = parse(root).root;
  for (const part of relative(cursor, root).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const st = await lstat(cursor);
    if (!st.isDirectory() || st.isSymbolicLink()) fail("workspace-git-root-mismatch", "unsafe-ancestor");
  }
  if (await realpath(root) !== root) fail("workspace-git-root-mismatch", "noncanonical-root");
  const st = await lstat(root, { bigint: true });
  if (!st.isDirectory()) fail("workspace-git-root-mismatch", "not-directory");
  return st;
}
async function checkedGitDirectory(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) fail("workspace-git-root-mismatch", "gitdir-alias");
  const st = await lstat(path, { bigint: true });
  if (!st.isDirectory() || st.isSymbolicLink()) fail("workspace-git-root-mismatch", "gitdir-replaced");
  return st;
}
async function indexAnchor(path: string): Promise<{ digest: ContentHash | "absent"; stat?: import("node:fs").BigIntStats }> {
  let before: import("node:fs").BigIntStats;
  try { before = await lstat(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { digest: "absent" }; throw error; }
  if (!before.isFile() || before.size > BigInt(bounds.index_bytes) || before.size < 0n)
    fail("workspace-git-output-limit", "index-size-or-type");
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameStat(before, await fd.stat({ bigint: true }))) fail("workspace-git-index-changed");
    const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(65536);
    let count = 0;
    for (;;) {
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > bounds.index_bytes) fail("workspace-git-output-limit", "index-size");
      hash.update(chunk.subarray(0, bytesRead));
    }
    if (count !== Number(before.size) || !sameStat(before, await fd.stat({ bigint: true })) ||
        !sameStat(before, await lstat(path, { bigint: true }))) fail("workspace-git-index-changed");
    return { digest: contentHashSchema.parse(`sha256:${hash.digest("hex")}`), stat: before };
  } finally { await fd.close(); }
}
interface Anchor {
  readonly rootStat: import("node:fs").BigIntStats;
  readonly markerStat?: import("node:fs").BigIntStats;
  readonly marker: string;
  readonly gitdir: string; readonly common: string;
  readonly gitStat: import("node:fs").BigIntStats;
  readonly commonStat: import("node:fs").BigIntStats;
  readonly index: Awaited<ReturnType<typeof indexAnchor>>;
  readonly format: GitObjectFormat; readonly head: GitHead;
  readonly bare: boolean;
}
async function anchor(root: string, run: GitReader): Promise<Anchor> {
  const rootStat = await checkedRoot(root);
  let markerStat: import("node:fs").BigIntStats | undefined;
  try { markerStat = await lstat(join(root, ".git"), { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (markerStat?.isSymbolicLink() || markerStat && !markerStat.isFile() && !markerStat.isDirectory())
    fail("workspace-git-root-mismatch", "unsafe-git-marker");
  // A bare repository has no .git marker; any other marker-less root is NOT discovered in its parents.
  if (!markerStat) {
    try {
      if (text(await run(["rev-parse", "--is-bare-repository"], root)) === "true")
        fail("workspace-git-bare-unsupported");
    } catch (error) { if (error instanceof GitInspectionError && error.code === "workspace-git-bare-unsupported") throw error; }
    fail("workspace-git-not-repository");
  }
  const foundMarker = markerStat!;
  if (foundMarker.isFile() && foundMarker.size > 4096n) fail("workspace-git-output-limit", "git-marker");
  let marker = "directory";
  if (foundMarker.isFile()) {
    const fd = await open(join(root, ".git"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameStat(foundMarker, await fd.stat({ bigint: true }))) fail("workspace-git-state-changed");
      const data = Buffer.alloc(4097);
      const { bytesRead } = await fd.read(data, 0, data.length, 0);
      if (bytesRead > 4096 || !sameStat(foundMarker, await fd.stat({ bigint: true }))) fail("workspace-git-state-changed");
      marker = decode(data.subarray(0, bytesRead));
    } finally { await fd.close(); }
  }
  let bare: boolean;
  try { bare = text(await run(["rev-parse", "--is-bare-repository"], root)) === "true"; }
  catch (error) {
    if (error instanceof GitInspectionError && error.code === "workspace-git-command-failed") {
      const dir = foundMarker.isDirectory() ? join(root, ".git") : marker.startsWith("gitdir: ") ?
        resolve(root, marker.slice(8).trim()) : undefined;
      if (dir) {
        try {
          await checkedGitDirectory(dir);
          const headFile = join(dir, "HEAD");
          const stat = await lstat(headFile, { bigint: true });
          if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096n) {
            const fd = await open(headFile, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const data = Buffer.alloc(Number(stat.size));
              await fd.read(data, 0, data.length, 0);
              if (!/^(?:ref: refs\/heads\/[^\s\u0000-\u001f\u007f]+|[a-f0-9]{40}|[a-f0-9]{64})\n?$/.test(decode(data)))
                fail("workspace-git-head-invalid", "invalid-head-syntax");
            } finally { await fd.close(); }
          }
        } catch (headError) { if (headError instanceof GitInspectionError) throw headError; }
      }
    }
    throw error;
  }
  if (bare) fail("workspace-git-bare-unsupported");
  const top = text(await run(["rev-parse", "--show-toplevel"], root));
  if (top !== root) fail("workspace-git-root-mismatch", "git-toplevel-is-not-execution-root");
  const gitdir = text(await run(["rev-parse", "--absolute-git-dir"], root));
  const common = resolve(root, text(await run(["rev-parse", "--path-format=absolute", "--git-common-dir"], root)));
  const gitStat = await checkedGitDirectory(gitdir), commonStat = await checkedGitDirectory(common);
  if (foundMarker.isDirectory() ? gitdir !== join(root, ".git") : !marker.startsWith("gitdir: ") ||
      resolve(root, marker.slice(8).trim()) !== gitdir) fail("workspace-git-root-mismatch", "git-marker-does-not-match");
  const reportedFormat = text(await run(["rev-parse", "--show-object-format=storage"], root));
  if (reportedFormat !== "sha1" && reportedFormat !== "sha256") fail("workspace-git-command-failed", "unsupported-object-format");
  const format = reportedFormat as GitObjectFormat;
  const indexPath = text(await run(["rev-parse", "--path-format=absolute", "--git-path", "index"], root));
  if (indexPath !== join(gitdir, "index")) fail("workspace-git-policy-incompatible", "external-index");
  const index = await indexAnchor(indexPath);
  let ref: string | undefined;
  try { ref = text(await run(["symbolic-ref", "-q", "HEAD"], root)); } catch { /* detached or malformed */ }
  if (ref && (!/^refs\/heads\/[^\u0000-\u001f\u007f\\:]+$/.test(ref) || ref.length > 1024 ||
      ref.split("/").some((part) => !part || part === "." || part === "..")))
    fail("workspace-git-head-invalid", "invalid-head-ref");
  let head: GitHead;
  try {
    const commit = oid(text(await run(["rev-parse", "--verify", "HEAD^{commit}"], root)), format);
    if (text(await run(["cat-file", "-t", commit], root)) !== "commit") fail("workspace-git-head-invalid", "non-commit");
    head = ref ? { kind: "attached", ref, commit } : { kind: "detached", commit };
  } catch (error) {
    if (error instanceof GitInspectionError && ["workspace-git-timeout", "workspace-git-output-limit"].includes(error.code)) throw error;
    if (!ref) fail("workspace-git-head-invalid", "unresolvable-head");
    const headRef = ref!;
    // An attached, missing ref is unborn; a present but invalid ref is corruption.
    const refPath = join(common, headRef);
    let exists = false;
    try { await lstat(refPath); exists = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (exists) fail("workspace-git-head-invalid", "unresolvable-ref");
    head = { kind: "unborn", ref: headRef };
  }
  return { rootStat, markerStat, marker, gitdir, common, gitStat, commonStat, index, format, head, bare };
}
function sameAnchor(a: Anchor, b: Anchor): GitIssueCode | undefined {
  if (JSON.stringify(a.head) !== JSON.stringify(b.head) || a.format !== b.format)
    return "workspace-git-state-changed";
  if (a.index.digest !== b.index.digest || !!a.index.stat !== !!b.index.stat ||
      a.index.stat && b.index.stat && !sameStat(a.index.stat, b.index.stat)) return "workspace-git-index-changed";
  if (!sameStat(a.rootStat, b.rootStat) || a.gitdir !== b.gitdir || a.common !== b.common ||
      !sameStat(a.gitStat, b.gitStat) || !sameStat(a.commonStat, b.commonStat) ||
      a.marker !== b.marker || !a.markerStat || !b.markerStat ||
      !sameStat(a.markerStat, b.markerStat))
    return "workspace-git-state-changed";
  return undefined;
}
/** Buffers are bounded at the subprocess boundary; individual records are NUL-delimited. */
function records(bytes: Buffer, limit: number): Buffer[] {
  if (bytes.length && bytes[bytes.length - 1] !== 0) fail("workspace-git-command-failed", "unterminated-nul-record");
  const result: Buffer[] = []; let start = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) {
    if (result.length >= limit) fail("workspace-git-output-limit", "path-count");
    result.push(bytes.subarray(start, i)); start = i + 1;
  }
  return result;
}
/** Separate fixed ASCII fields without splitting (or quoting) the possibly space-containing path. */
function fields(record: Buffer, count: number): { header: string[]; path: Buffer } {
  const header: string[] = []; let from = 0;
  for (let i = 0; i < count; i++) {
    const end = record.indexOf(32, from);
    if (end < 0) fail("workspace-git-command-failed", "malformed-porcelain");
    header.push(decode(record.subarray(from, end))); from = end + 1;
  }
  return { header, path: record.subarray(from) };
}
class Paths {
  readonly aliases = new Map<string, string>();
  readonly trackedAira = new Set<string>();
  constructor(readonly exclusions: readonly string[]) {}
  path(bytes: Buffer, tracked = false): string | undefined {
    const path = decode(bytes);
    if (path.endsWith("/")) fail("workspace-git-nested-repository", "untracked-repository-directory", path.slice(0, 256));
    if (!validLogicalPath(path, bounds.max_path_bytes)) fail("workspace-git-path-unsupported", "invalid-logical-path", path.slice(0, 256));
    const alias = aliasKey(path);
    if (alias === ".git" || alias.startsWith(".git/") || alias === ".aira" && path !== ".aira" ||
        alias.startsWith(".aira/") && !path.startsWith(".aira/"))
      fail("workspace-git-path-unsupported", "reserved-alias", path);
    for (const exclusion of this.exclusions) {
      const key = aliasKey(exclusion);
      if ((alias === key || alias.startsWith(`${key}/`)) && path !== exclusion && !path.startsWith(`${exclusion}/`))
        fail("workspace-git-path-unsupported", "excluded-path-alias", path);
    }
    const prior = this.aliases.get(alias);
    if (prior && prior !== path) fail("workspace-git-path-unsupported", "ambiguous-alias", path);
    if (!prior && this.aliases.size >= bounds.max_paths) fail("workspace-git-output-limit", "total-path-count");
    this.aliases.set(alias, path);
    if (path === ".aira" || path.startsWith(".aira/")) {
      if (tracked) this.trackedAira.add(path);
      return undefined;
    }
    if (this.exclusions.some((item) => path === item || path.startsWith(`${item}/`))) return undefined;
    if (path === ".git" || path.startsWith(".git/") || path.split("/").slice(1).includes(".git"))
      fail("workspace-git-nested-repository", "nested-git-path", path);
    return path;
  }
}
function listIndex(data: Buffer, paths: Paths, format: GitObjectFormat) {
  const index: GitEntry[] = [], submodules: GitEntry[] = [];
  for (const record of records(data, bounds.max_paths)) {
    const tab = record.indexOf(9);
    if (tab < 0) fail("workspace-git-command-failed", "malformed-index-entry");
    const header = decode(record.subarray(0, tab)).split(" ");
    if (header.length !== 3) fail("workspace-git-command-failed", "malformed-index-entry");
    if (header[2] !== "0") fail("workspace-git-unmerged-unsupported");
    const path = paths.path(record.subarray(tab + 1), true);
    if (!path) continue;
    const objectId = oid(header[1]!, format);
    if (/^0+$/.test(objectId)) fail("workspace-git-policy-incompatible", "intent-to-add-index-entry", path);
    const entry = { path, mode: mode(header[0]!), oid: objectId };
    if (entry.mode === "160000") {
      if (submodules.length >= bounds.max_submodules) fail("workspace-git-output-limit", "submodule-count");
      submodules.push(entry);
    }
    index.push(entry);
  }
  index.sort((a, b) => compareText(a.path, b.path));
  if (index.some((entry, i) => i > 0 && entry.path === index[i - 1]!.path)) fail("workspace-git-command-failed", "duplicate-index-path");
  return { index, submodules };
}
const stateKind = (code: string, before?: { mode: GitMode }, after?: { mode: GitMode }): GitChange["kind"] => {
  if (code === "A" || !before && after) return "addition";
  if (code === "D" || before && !after) return "deletion";
  if (code === "R") return "rename";
  if (code === "C") return "copy";
  if (before && after && (before.mode === "120000" || after.mode === "120000") && before.mode !== after.mode) return "type-change";
  if (before && after && before.mode !== after.mode) return "mode-change";
  return "modification";
};
function statusChanges(data: Buffer, paths: Paths, format: GitObjectFormat) {
  const staged: GitChange[] = [], tracked: GitChange[] = [];
  const parts = records(data, bounds.max_paths * 2);
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i]!;
    if (item[0] === 117) fail("workspace-git-unmerged-unsupported"); // 'u'
    if (item[0] !== 49 && item[0] !== 50) fail("workspace-git-command-failed", "unexpected-status-record");
    const rename = item[0] === 50;
    const { header, path: raw } = fields(item, rename ? 9 : 8);
    const path = paths.path(raw, true);
    const from = rename ? paths.path(parts[++i] ?? fail("workspace-git-command-failed", "missing-rename-origin"), true) : undefined;
    if (!path) continue;
    const xy = header[1]!;
    if (!/^[.MADRCUT]{2}$/.test(xy)) fail("workspace-git-command-failed", "unexpected-status-code");
    const gitMode = (n: number) => header[n] === "000000" ? undefined : mode(header[n]!);
    const mH = gitMode(3), mI = gitMode(4), mW = gitMode(5);
    const hH = header[6]!, hI = header[7]!;
    const beforeBase = mH ? { mode: mH, oid: oid(hH, format) } : undefined;
    const afterIndex = mI ? { mode: mI, oid: oid(hI, format) } : undefined;
    if (xy[0] !== ".") staged.push({ path, kind: stateKind(xy[0]!, beforeBase, afterIndex),
      ...(from ? { from } : {}), ...(beforeBase ? { before: beforeBase } : {}), ...(afterIndex ? { after: afterIndex } : {}) });
    if (xy[1] !== ".") tracked.push({ path, kind: stateKind(xy[1]!, afterIndex, mW ? { mode: mW } : undefined),
      ...(afterIndex ? { before: afterIndex } : {}), ...(mW ? { after: { mode: mW } } : {}) });
  }
  staged.sort((a, b) => compareText(a.path, b.path)); tracked.sort((a, b) => compareText(a.path, b.path));
  return { staged, tracked };
}
function stagedDiff(data: Buffer, paths: Paths, format: GitObjectFormat): GitChange[] {
  const parts = records(data, bounds.max_paths * 2), staged: GitChange[] = [];
  if (parts.length % 2) fail("workspace-git-command-failed", "malformed-cached-diff");
  for (let i = 0; i < parts.length; i += 2) {
    const match = decode(parts[i]!).match(/^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]+) ([a-f0-9]+) ([AMDT])$/);
    if (!match) fail("workspace-git-command-failed", "malformed-cached-diff");
    const header = match!;
    const path = paths.path(parts[i + 1]!, true);
    if (!path) continue;
    const before = header[1] === "000000" ? undefined : { mode: mode(header[1]!), oid: oid(header[3]!, format) };
    const after = header[2] === "000000" ? undefined : { mode: mode(header[2]!), oid: oid(header[4]!, format) };
    staged.push({ path, kind: stateKind(header[5]!, before, after),
      ...(before ? { before } : {}), ...(after ? { after } : {}) });
  }
  staged.sort((a, b) => compareText(a.path, b.path));
  return staged;
}
function indexFlags(data: Buffer, paths: Paths): string[] {
  const found: string[] = [];
  for (const record of records(data, bounds.max_paths)) {
    const tag = record[0];
    if (record[1] !== 32 || tag === undefined) fail("workspace-git-command-failed", "index-flags-format");
    const path = paths.path(record.subarray(2), true);
    if (!path) continue;
    if (tag === 83) fail("workspace-git-sparse-unsupported", "skip-worktree-entry", path); // S
    if (tag !== 72) fail("workspace-git-policy-incompatible", "assume-unchanged-or-unknown-index-flag", path); // H
    found.push(path);
  }
  return found.sort(compareText);
}
function pathList(data: Buffer, paths: Paths, bound: number): string[] {
  const found: string[] = [];
  for (const raw of records(data, bound)) {
    const path = paths.path(raw);
    if (path) found.push(path);
  }
  found.sort(compareText);
  if (found.some((path, i) => i > 0 && found[i - 1] === path)) fail("workspace-git-command-failed", "duplicate-path");
  return found;
}
const absentConfig = (error: unknown): boolean => error instanceof GitInspectionError &&
  error.code === "workspace-git-command-failed" && error.detail?.startsWith("git config exited 1;") === true;
async function config(run: GitReader, root: string, name: string): Promise<string> {
  try { return text(await run(["config", "--local", "--get", name], root)); }
  catch (error) { if (absentConfig(error)) return ""; throw error; }
}
async function unsafeConfig(run: GitReader, root: string): Promise<GitIssueCode | undefined> {
  if ((await config(run, root, "core.sparseCheckout")) === "true" ||
      (await config(run, root, "core.sparseCheckoutCone")) === "true") return "workspace-git-sparse-unsupported";
  if ((await config(run, root, "core.splitIndex")) === "true") return "workspace-git-policy-incompatible";
  // Status can invoke configured clean/process filters. Reject those (and external
  // diff drivers) before invoking it, not merely after inspecting its output.
  try {
    const lines = text(await run(["config", "--local", "--no-includes", "--get-regexp",
      "^(extensions\\.(partialclone|worktreeconfig)|remote\\..*\\.promisor|filter\\..*\\.(clean|process|smudge)|diff\\..*\\.(command|textconv)|include\\.path|includeif\\..*\\.path)$"], root));
    if (lines) return lines.split("\n").some((line) => /^(extensions\.partialclone|remote\..*\.promisor) /i.test(line)) ?
      "workspace-git-partial-unsupported" : "workspace-git-policy-incompatible";
  } catch (error) { if (!absentConfig(error)) throw error; }
  return undefined;
}
async function submoduleConfig(root: string): Promise<boolean> {
  // Reject even an untracked .gitmodules rather than parse a symlink or an include
  // directive capable of reading external config. An inert file is conservatively unsupported.
  try { await lstat(join(root, ".gitmodules")); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
const issue = (error: unknown): GitIssue => error instanceof GitInspectionError ?
  { code: error.code, ...(error.detail ? { detail: error.detail } : {}), ...(error.path ? { path: error.path } : {}) } :
  { code: "workspace-git-command-failed", detail: error instanceof Error ? (error as NodeJS.ErrnoException).code ?? "io-error" : "io-error" };

/** Read-only, bounded best-effort observation; not an atomic or verification-stable snapshot. */
export async function inspectWorkspaceGit(options: InspectGitOptions, hooks: GitInspectionHooks = {}, reader: GitReader = runReadOnlyGit): Promise<GitInspection> {
  const run: GitReader = async (args, cwd) => {
    const bytes = await reader(args, cwd);
    if (!Buffer.isBuffer(bytes) || bytes.length > bounds.stdout_bytes) fail("workspace-git-output-limit", "stdout");
    return bytes;
  };
  const result = (status: GitInspection["status"], diagnostics: GitIssue[], observation?: GitInspection["observation"]): GitInspection =>
    freeze({ status, policy: gitInspectionPolicy, diagnostics, ...(observation ? { observation } : {}) });
  const capture = workspaceFingerprintPolicySchema.safeParse(options?.capturePolicy);
  if (!capture.success || !controlProjectIdSchema.safeParse(options.controlProject).success ||
      !projectIdentitySchema.safeParse(options.project).success ||
      !contentHashSchema.safeParse(options.registeredRootAssociation).success ||
      typeof options.executionRoot !== "string") return result("unsupported", [{ code: "workspace-git-policy-incompatible" }]);
  const started = new Date().toISOString();
  try {
    const root = options.executionRoot;
    const a = await anchor(root, run);
    const incompat = await unsafeConfig(run, root);
    if (incompat) fail(incompat);
    if ((await readdir(a.gitdir)).some((name) => name.startsWith("sharedindex.")))
      fail("workspace-git-policy-incompatible", "split-index");
    await hooks.afterAnchor?.();
    const exclusions = [...capture.data.configuration.exclusions.map((e) => e.path),
      ...capture.data.configuration.additional_exclusions.map((e) => e.path)].sort(compareText);
    const paths = new Paths(exclusions);
    const { index, submodules: indexedSubmodules } = listIndex(await run(["ls-files", "--stage", "-z"], root), paths, a.format);
    if (!exact(index.map((e) => e.path), indexFlags(await run(["ls-files", "-v", "-z"], root), paths)))
      fail("workspace-git-state-changed", "index-flags-paths-changed");
    const status = statusChanges(await run(["status", "--porcelain=v2", "-z", "--no-renames", "--no-ahead-behind",
      "--untracked-files=no", "--ignored=no", "--ignore-submodules=all"], root), paths, a.format);
    const changes = { staged: a.head.kind === "attached" || a.head.kind === "detached" ?
      stagedDiff(await run(["diff-index", "--cached", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
        a.head.commit], root), paths, a.format) : status.staged, tracked: status.tracked };
    if (status.staged.some((e) => !changes.staged.some((diff) => diff.path === e.path)))
      fail("workspace-git-state-changed", "porcelain-cached-diff-disagreement");
    const submoduleMap = new Map(indexedSubmodules.map((e) => [e.path, e]));
    for (const change of [...changes.staged, ...changes.tracked]) {
      for (const state of [change.before, change.after]) if (state?.mode === "160000" && state.oid && !submoduleMap.has(change.path))
        submoduleMap.set(change.path, { path: change.path, mode: "160000", oid: state.oid });
    }
    const submodules = [...submoduleMap.values()].sort((x, y) => compareText(x.path, y.path));
    if (submodules.length > bounds.max_submodules) fail("workspace-git-output-limit", "submodule-count");
    const untracked = pathList(await run(["ls-files", "--others", "--exclude-standard", "-z"], root), paths, bounds.max_untracked);
    const ignored = pathList(await run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], root), paths, bounds.max_ignored);
    const ignoredSet = new Set(ignored);
    if (untracked.some((p) => ignoredSet.has(p))) fail("workspace-git-command-failed", "overlapping-classifications");
    // An untracked nested repository is emitted as a directory by ls-files. Local inspection
    // independently rejects included nested .git entries, including inside ignored directories.
    if ([...untracked, ...ignored].some((p) => p.endsWith("/"))) fail("workspace-git-nested-repository");
    const hasModules = index.some((e) => e.path === ".gitmodules") ||
      [...changes.staged, ...changes.tracked].some((e) => e.path === ".gitmodules") || await submoduleConfig(root);
    await hooks.beforeFinalAnchor?.();
    // Re-run classification so a tracked file edit or ignore-rule change between
    // commands does not quietly combine states from different capture points.
    const again = new Paths(exclusions);
    const secondIndex = listIndex(await run(["ls-files", "--stage", "-z"], root), again, a.format);
    if (!exact(secondIndex.index.map((e) => e.path), indexFlags(await run(["ls-files", "-v", "-z"], root), again)))
      fail("workspace-git-state-changed", "index-flags-paths-changed");
    const secondStatus = statusChanges(await run(["status", "--porcelain=v2", "-z", "--no-renames", "--no-ahead-behind",
      "--untracked-files=no", "--ignored=no", "--ignore-submodules=all"], root), again, a.format);
    const secondChanges = { staged: a.head.kind === "attached" || a.head.kind === "detached" ?
      stagedDiff(await run(["diff-index", "--cached", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
        a.head.commit], root), again, a.format) : secondStatus.staged, tracked: secondStatus.tracked };
    if (secondStatus.staged.some((e) => !secondChanges.staged.some((diff) => diff.path === e.path)))
      fail("workspace-git-state-changed", "porcelain-cached-diff-disagreement");
    const secondUntracked = pathList(await run(["ls-files", "--others", "--exclude-standard", "-z"], root), again, bounds.max_untracked);
    const secondIgnored = pathList(await run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], root), again, bounds.max_ignored);
    const b = await anchor(root, run);
    const changed = sameAnchor(a, b);
    if (changed) fail(changed);
    if (!exact(index, secondIndex.index) || !exact(changes, secondChanges) ||
        !exact(untracked, secondUntracked) || !exact(ignored, secondIgnored) ||
        hasModules !== (secondIndex.index.some((e) => e.path === ".gitmodules") ||
          [...secondChanges.staged, ...secondChanges.tracked].some((e) => e.path === ".gitmodules") || await submoduleConfig(root)) ||
        incompat !== await unsafeConfig(run, root)) fail("workspace-git-state-changed", "classification-drift");
    const repository = `repository_${hashCanonical({ schema: "aira.dev/workspace-git-repository-association/v1",
      common: a.common, device: a.commonStat.dev.toString(), inode: a.commonStat.ino.toString(), format: a.format }).slice(7)}` as GitObservationSubject["repository"];
    const worktree = { kind: (a.gitdir === a.common ? "main" : "linked") as "main" | "linked",
      identity: hashCanonical({ schema: "aira.dev/workspace-git-worktree-association/v1", repository,
        gitdir: a.gitdir, device: a.gitStat.dev.toString(), inode: a.gitStat.ino.toString() }) };
    const state = a.head.kind === "unborn" ? "unborn" : submodules.length || hasModules ? "submodules" : "normal";
    const subject: GitObservationSubject = { schema: "aira.dev/workspace-git-observation-subject/v1",
      control_project: options.controlProject, project: options.project,
      registered_root_association: options.registeredRootAssociation, repository, worktree, object_format: a.format,
      head: a.head, ...(a.head.kind === "attached" || a.head.kind === "detached" ? { base_commit: a.head.commit } : {}),
      state, index, staged: changes.staged, tracked: changes.tracked, untracked, ignored, submodules,
      exclusions: { paths: exclusions }, policy_hash: gitInspectionPolicy.hash, capture_policy_hash: capture.data.hash };
    const observation = createGitObservation(subject, { root, git_dir: a.gitdir, common_dir: a.common,
      index_byte_hash: a.index.digest, tracked_aira: [...paths.trackedAira].sort(compareText),
      started_at: started, ended_at: new Date().toISOString() });
    const unsupported = state === "unborn" ? "workspace-git-unborn-unsupported" :
      state === "submodules" ? "workspace-git-submodule-unsupported" : undefined;
    return result(unsupported ? "unsupported" : "complete", unsupported ? [{ code: unsupported }] : [], observation);
  } catch (error) {
    const diagnostic = issue(error);
    return result(diagnostic.code === "workspace-git-not-repository" ? "not-repository" :
      ["workspace-git-state-changed", "workspace-git-index-changed"].includes(diagnostic.code) ? "unstable" : "unsupported", [diagnostic]);
  }
}
