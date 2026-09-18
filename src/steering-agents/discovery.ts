import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { compareText } from "../spec/domain/primitives";
import {
  AGENTS_FILENAME,
  agentsInteropDiscoveryPolicy,
  agentsSourcePathSchema,
  agentsTargetPathSchema,
  stableAgentsIssues,
  type AgentsFilesystemObservation,
  type AgentsInteropIssue,
  type AgentsInteropIssueCode,
  type AgentsSkippedSubtree,
} from "./types";

interface TrustedRoot {
  readonly path: string;
  readonly stat: BigIntStats;
}

interface Candidate {
  readonly absolute: string;
  readonly logical: string;
  readonly size: bigint;
}

interface DirectoryObservation {
  readonly absolute: string;
  readonly logical: string;
  readonly stat: BigIntStats;
}

export interface DiscoveredAgentsFile {
  readonly source_path: string;
  readonly bytes: Uint8Array;
  readonly filesystem: AgentsFilesystemObservation;
}

export interface AgentsFilesystemDiscovery {
  readonly complete: boolean;
  readonly root_status: "present" | "missing" | "unsafe" | "unreadable";
  readonly files: readonly DiscoveredAgentsFile[];
  readonly unsafe_paths: readonly AgentsInteropIssue[];
  readonly skipped_subtrees: readonly AgentsSkippedSubtree[];
  readonly diagnostics: readonly AgentsInteropIssue[];
}

class AgentsFilesystemError extends Error {
  constructor(
    readonly issueCode: AgentsInteropIssueCode,
    readonly logicalPath: string,
    readonly detail?: string,
  ) {
    super(issueCode);
    this.name = "AgentsFilesystemError";
  }
}

interface ScanState {
  entries: number;
  complete: boolean;
  root_status: "present" | "missing" | "unsafe" | "unreadable";
  candidates: Candidate[];
  directories: DirectoryObservation[];
  unsafe: AgentsInteropIssue[];
  skipped: AgentsSkippedSubtree[];
  diagnostics: AgentsInteropIssue[];
}

const nodeCode = (error: unknown): string | undefined => typeof error === "object" && error !== null && "code" in error &&
  typeof error.code === "string" ? error.code : undefined;

function issue(
  code: AgentsInteropIssueCode,
  path: string,
  severity: "error" | "warning" = "error",
  detail?: string,
): AgentsInteropIssue {
  return { code, severity, path, ...(detail === undefined ? {} : { detail }) };
}

function inside(root: string, target: string): boolean {
  const part = relative(root, target);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.mode === right.mode &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function safeEntryName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") &&
    !name.includes(":") && !/[\u0000-\u001f\u007f]/.test(name);
}

function logicalChild(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

function excludedName(name: string): boolean {
  return (agentsInteropDiscoveryPolicy.excluded_directories as readonly string[]).includes(name);
}

function record(state: ScanState, value: AgentsInteropIssue): void {
  state.diagnostics.push(value);
  if (value.code === "agents-source-unsafe" || value.code === "agents-root-unsafe") state.unsafe.push(value);
}

function incomplete(state: ScanState, value: AgentsInteropIssue): void {
  state.complete = false;
  record(state, value);
}

function filesystemObservation(stat: BigIntStats, size: number): AgentsFilesystemObservation {
  return {
    kind: "filesystem",
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    links: Number(stat.nlink),
    mode: Number(stat.mode),
    size,
    modified_ns: stat.mtimeNs.toString(),
    changed_ns: stat.ctimeNs.toString(),
  };
}

async function assertTrustedRoot(projectRootInput: string): Promise<TrustedRoot> {
  if (typeof projectRootInput !== "string" || !isAbsolute(projectRootInput) || resolve(projectRootInput) !== projectRootInput)
    throw new AgentsFilesystemError("agents-root-unsafe", ".", "absolute-canonical-root-required");
  let stat: BigIntStats;
  try { stat = await lstat(projectRootInput, { bigint: true }); }
  catch (error) {
    if (nodeCode(error) === "ENOENT") throw new AgentsFilesystemError("agents-root-unsafe", ".", "project-root-missing");
    throw new AgentsFilesystemError("agents-root-unsafe", ".", "project-root-lstat-failed");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new AgentsFilesystemError("agents-root-unsafe", ".", "project-root-not-real-directory");
  try {
    if (await realpath(projectRootInput) !== projectRootInput)
      throw new AgentsFilesystemError("agents-root-unsafe", ".", "project-root-noncanonical");
  } catch (error) {
    if (error instanceof AgentsFilesystemError) throw error;
    throw new AgentsFilesystemError("agents-root-unsafe", ".", "project-root-realpath-failed");
  }
  return { path: projectRootInput, stat };
}

/** Check every component under the explicit trusted root without following links. */
async function checkSafePath(root: TrustedRoot, target: string, logical: string, finalKind?: "file" | "directory"): Promise<void> {
  const absolute = resolve(target);
  if (!inside(root.path, absolute)) throw new AgentsFilesystemError("agents-source-unsafe", logical, "path-escaped-project-root");

  let rootStat: BigIntStats;
  try { rootStat = await lstat(root.path, { bigint: true }); }
  catch (error) {
    if (nodeCode(error) === "ENOENT") throw new AgentsFilesystemError("agents-root-unsafe", ".", "project-root-disappeared");
    throw new AgentsFilesystemError("agents-root-unsafe", ".", "project-root-recheck-failed");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || rootStat.dev !== root.stat.dev || rootStat.ino !== root.stat.ino)
    throw new AgentsFilesystemError("agents-root-unsafe", ".", "project-root-replaced");

  const parts = relative(root.path, absolute).split(/[\\/]/).filter(Boolean);
  let cursor = root.path;
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]!);
    let stat: BigIntStats;
    try { stat = await lstat(cursor, { bigint: true }); }
    catch (error) {
      if (nodeCode(error) === "ENOENT") throw error;
      throw new AgentsFilesystemError("agents-source-unreadable", logical, "path-lstat-failed");
    }
    if (stat.isSymbolicLink()) throw new AgentsFilesystemError("agents-source-unsafe", logical, "symlink");
    if (stat.dev !== root.stat.dev) throw new AgentsFilesystemError("agents-source-unsafe", logical, "cross-device");
    const last = index === parts.length - 1;
    if (!last && !stat.isDirectory()) throw new AgentsFilesystemError("agents-source-unsafe", logical, "non-directory-ancestor");
    if (last && finalKind === "directory" && !stat.isDirectory())
      throw new AgentsFilesystemError("agents-source-unsafe", logical, "not-directory");
    if (last && finalKind === "file" && !stat.isFile())
      throw new AgentsFilesystemError("agents-source-unsafe", logical, "non-regular");
  }
  try {
    if (await realpath(absolute) !== absolute)
      throw new AgentsFilesystemError("agents-source-unsafe", logical, "noncanonical-realpath");
  } catch (error) {
    if (error instanceof AgentsFilesystemError || nodeCode(error) === "ENOENT") throw error;
    throw new AgentsFilesystemError("agents-source-unreadable", logical, "realpath-failed");
  }
}

async function directoryNames(root: TrustedRoot, absolute: string, logical: string, state: ScanState): Promise<string[]> {
  await checkSafePath(root, absolute, logical, "directory");
  const before = await lstat(absolute, { bigint: true });
  if (!before.isDirectory()) throw new AgentsFilesystemError("agents-source-unsafe", logical, "not-directory");

  const names: string[] = [];
  let directory;
  try { directory = await opendir(absolute); }
  catch { throw new AgentsFilesystemError("agents-source-unreadable", logical, "open-directory-failed"); }
  try {
    for await (const entry of directory) {
      names.push(entry.name);
      state.entries++;
      if (names.length > agentsInteropDiscoveryPolicy.max_entries_per_directory ||
        state.entries > agentsInteropDiscoveryPolicy.max_total_entries) {
        incomplete(state, issue("agents-entry-limit", logical));
        break;
      }
    }
  } catch {
    throw new AgentsFilesystemError("agents-source-unreadable", logical, "read-directory-failed");
  }
  if (!state.complete) return [];

  await checkSafePath(root, absolute, logical, "directory");
  const after = await lstat(absolute, { bigint: true });
  if (!sameDirectory(before, after))
    throw new AgentsFilesystemError("agents-source-unsafe", logical, "directory-changed-during-discovery");
  state.directories.push({ absolute, logical, stat: after });
  return names.sort(compareText);
}

function rootStatusForIssue(state: ScanState, logical: string, value: AgentsInteropIssue): void {
  if (logical !== AGENTS_FILENAME) return;
  state.root_status = value.code === "agents-source-unreadable" ? "unreadable" : "unsafe";
}

async function scanDirectory(
  root: TrustedRoot,
  absolute: string,
  logical: string,
  depth: number,
  state: ScanState,
): Promise<void> {
  if (!state.complete) return;
  let names: string[];
  try { names = await directoryNames(root, absolute, logical, state); }
  catch (error) {
    const value = error instanceof AgentsFilesystemError ? issue(error.issueCode, error.logicalPath, "error", error.detail) :
      issue("agents-source-unreadable", logical, "error", "directory-read-failed");
    incomplete(state, value);
    return;
  }

  for (const name of names) {
    if (!state.complete) return;
    const entryLogical = logicalChild(logical, name);
    if (!safeEntryName(name) || !agentsTargetPathSchema.safeParse(entryLogical).success) {
      incomplete(state, issue("agents-path-invalid", entryLogical, "error", "invalid-directory-entry"));
      continue;
    }
    if (excludedName(name)) {
      state.skipped.push({ path: entryLogical, reason: "policy-excluded" });
      continue;
    }

    const entryAbsolute = join(absolute, name);
    let stat: BigIntStats;
    try { stat = await lstat(entryAbsolute, { bigint: true }); }
    catch (error) {
      const value = issue(nodeCode(error) === "ENOENT" ? "agents-source-unsafe" : "agents-source-unreadable", entryLogical,
        "error", nodeCode(error) === "ENOENT" ? "entry-disappeared" : "entry-lstat-failed");
      rootStatusForIssue(state, entryLogical, value);
      incomplete(state, value);
      continue;
    }

    if (stat.isSymbolicLink()) {
      const value = issue("agents-source-unsafe", entryLogical, "error", "symlink");
      rootStatusForIssue(state, entryLogical, value);
      record(state, value);
      continue;
    }
    if (stat.dev !== root.stat.dev) {
      const value = issue("agents-source-unsafe", entryLogical, "error", "cross-device");
      rootStatusForIssue(state, entryLogical, value);
      record(state, value);
      continue;
    }
    if (name === AGENTS_FILENAME && !stat.isFile()) {
      const value = issue("agents-source-unsafe", entryLogical, "error", "non-regular");
      rootStatusForIssue(state, entryLogical, value);
      record(state, value);
      continue;
    }
    if (stat.isDirectory()) {
      const childDepth = depth + 1;
      if (childDepth > agentsInteropDiscoveryPolicy.max_traversal_depth) {
        incomplete(state, issue("agents-depth-limit", entryLogical));
        continue;
      }
      await scanDirectory(root, entryAbsolute, entryLogical, childDepth, state);
      continue;
    }
    if (name !== AGENTS_FILENAME) continue;

    state.root_status = entryLogical === AGENTS_FILENAME ? "present" : state.root_status;
    if (!stat.isFile()) {
      const value = issue("agents-source-unsafe", entryLogical, "error", "non-regular");
      rootStatusForIssue(state, entryLogical, value);
      record(state, value);
      continue;
    }
    if (stat.nlink !== 1n) {
      const value = issue("agents-source-unsafe", entryLogical, "error", "hardlink");
      rootStatusForIssue(state, entryLogical, value);
      record(state, value);
      continue;
    }
    state.candidates.push({ absolute: entryAbsolute, logical: entryLogical, size: stat.size });
    if (state.candidates.length > agentsInteropDiscoveryPolicy.max_files) {
      incomplete(state, issue("agents-file-limit", "."));
      return;
    }
  }
}

async function readCandidate(root: TrustedRoot, candidate: Candidate): Promise<DiscoveredAgentsFile> {
  await checkSafePath(root, candidate.absolute, candidate.logical, "file");
  const before = await lstat(candidate.absolute, { bigint: true });
  if (!before.isFile()) throw new AgentsFilesystemError("agents-source-unsafe", candidate.logical, "non-regular");
  if (before.nlink !== 1n) throw new AgentsFilesystemError("agents-source-unsafe", candidate.logical, "hardlink");
  if (before.dev !== root.stat.dev) throw new AgentsFilesystemError("agents-source-unsafe", candidate.logical, "cross-device");
  if (before.size !== candidate.size)
    throw new AgentsFilesystemError("agents-source-unsafe", candidate.logical, "size-changed-after-discovery");
  if (before.size > BigInt(agentsInteropDiscoveryPolicy.max_file_bytes))
    throw new AgentsFilesystemError("agents-file-too-large", candidate.logical);
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK)
    throw new AgentsFilesystemError("agents-source-unsafe", candidate.logical, "no-follow-unavailable");

  let handle;
  try { handle = await open(candidate.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = nodeCode(error);
    if (code === "ELOOP") throw new AgentsFilesystemError("agents-source-unsafe", candidate.logical, "symlink");
    if (code === "ENOENT") throw new AgentsFilesystemError("agents-source-unsafe", candidate.logical, "file-disappeared");
    throw new AgentsFilesystemError("agents-source-unreadable", candidate.logical, "open-file-failed");
  }

  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new AgentsFilesystemError("agents-source-unsafe", candidate.logical, "non-regular");
    if (opened.nlink !== 1n) throw new AgentsFilesystemError("agents-source-unsafe", candidate.logical, "hardlink");
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new AgentsFilesystemError("agents-source-unsafe", candidate.logical, "file-substituted-during-open");
    if (opened.size > BigInt(agentsInteropDiscoveryPolicy.max_file_bytes))
      throw new AgentsFilesystemError("agents-file-too-large", candidate.logical);

    const storage = new Uint8Array(agentsInteropDiscoveryPolicy.max_file_bytes + 1);
    let offset = 0;
    for (;;) {
      const amount = Math.min(agentsInteropDiscoveryPolicy.read_chunk_bytes, storage.length - offset);
      if (amount === 0) throw new AgentsFilesystemError("agents-file-too-large", candidate.logical);
      const { bytesRead } = await handle.read(storage, offset, amount, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > agentsInteropDiscoveryPolicy.max_file_bytes)
        throw new AgentsFilesystemError("agents-file-too-large", candidate.logical);
    }

    await checkSafePath(root, candidate.absolute, candidate.logical, "file");
    const after = await lstat(candidate.absolute, { bigint: true });
    const final = await handle.stat({ bigint: true });
    if (!after.isFile() || after.nlink !== 1n || final.nlink !== 1n)
      throw new AgentsFilesystemError("agents-source-unsafe", candidate.logical, after.isFile() ? "hardlink" : "non-regular");
    if (!sameFile(before, after) || !sameFile(opened, final) || BigInt(offset) !== final.size)
      throw new AgentsFilesystemError("agents-source-unsafe", candidate.logical, "file-changed-during-read");
    return {
      source_path: candidate.logical,
      bytes: storage.slice(0, offset),
      filesystem: filesystemObservation(final, offset),
    };
  } finally {
    await handle.close();
  }
}

async function recheckDirectories(root: TrustedRoot, state: ScanState): Promise<void> {
  for (const observation of [...state.directories].sort((left, right) => compareText(left.logical, right.logical))) {
    try {
      await checkSafePath(root, observation.absolute, observation.logical, "directory");
      const current = await lstat(observation.absolute, { bigint: true });
      if (!sameDirectory(observation.stat, current))
        throw new AgentsFilesystemError("agents-source-unsafe", observation.logical, "directory-changed-after-discovery");
    } catch (error) {
      const value = error instanceof AgentsFilesystemError ? issue(error.issueCode, error.logicalPath, "error", error.detail) :
        issue(nodeCode(error) === "ENOENT" ? "agents-source-unsafe" : "agents-source-unreadable", observation.logical,
          "error", nodeCode(error) === "ENOENT" ? "directory-disappeared" : "directory-recheck-failed");
      incomplete(state, value);
    }
  }
}

function result(state: ScanState, files: readonly DiscoveredAgentsFile[]): AgentsFilesystemDiscovery {
  const diagnostics = [...state.diagnostics];
  if (!state.complete) diagnostics.push(issue("agents-discovery-incomplete", "."));
  const skipped = [...new Map(state.skipped.map((entry) => [entry.path, entry])).values()]
    .sort((left, right) => compareText(left.path, right.path));
  return {
    complete: state.complete,
    root_status: state.root_status,
    files: [...files].sort((left, right) => compareText(left.source_path, right.source_path)),
    unsafe_paths: stableAgentsIssues(state.unsafe),
    skipped_subtrees: skipped,
    diagnostics: stableAgentsIssues(diagnostics),
  };
}

/**
 * Read-only bounded AGENTS.md filesystem discovery. It never writes, follows a
 * symlink, derives a root from cwd, or reads ordinary non-AGENTS files.
 */
export async function discoverAgentsInterop(projectRootInput: string): Promise<AgentsFilesystemDiscovery> {
  let root: TrustedRoot;
  try { root = await assertTrustedRoot(projectRootInput); }
  catch (error) {
    const value = error instanceof AgentsFilesystemError ? issue(error.issueCode, error.logicalPath, "error", error.detail) :
      issue("agents-root-unsafe", ".", "error", "trusted-root-validation-failed");
    return {
      complete: false,
      root_status: "unsafe",
      files: [],
      unsafe_paths: value.code === "agents-root-unsafe" ? [value] : [],
      skipped_subtrees: [],
      diagnostics: stableAgentsIssues([value, issue("agents-discovery-incomplete", ".")]),
    };
  }

  const state: ScanState = {
    entries: 0,
    complete: true,
    root_status: "missing",
    candidates: [],
    directories: [],
    unsafe: [],
    skipped: [],
    diagnostics: [],
  };
  await scanDirectory(root, root.path, ".", 0, state);
  state.candidates.sort((left, right) => compareText(left.logical, right.logical));
  if (!state.complete) return result(state, []);

  const aggregate = state.candidates.reduce((total, candidate) => total + candidate.size, 0n);
  if (aggregate > BigInt(agentsInteropDiscoveryPolicy.max_aggregate_bytes)) {
    incomplete(state, issue("agents-aggregate-too-large", "."));
    return result(state, []);
  }

  const files: DiscoveredAgentsFile[] = [];
  for (const candidate of state.candidates) {
    if (candidate.size > BigInt(agentsInteropDiscoveryPolicy.max_file_bytes)) {
      record(state, issue("agents-file-too-large", candidate.logical));
      continue;
    }
    try { files.push(await readCandidate(root, candidate)); }
    catch (error) {
      const value = error instanceof AgentsFilesystemError ? issue(error.issueCode, error.logicalPath, "error", error.detail) :
        issue("agents-source-unreadable", candidate.logical, "error", "read-failed");
      rootStatusForIssue(state, candidate.logical, value);
      record(state, value);
      state.complete = false;
    }
  }

  await recheckDirectories(root, state);
  return result(state, files);
}
