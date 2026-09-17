import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { canonical, compareText } from "../spec/domain/primitives";
import { steeringProjectNamespaceSchema } from "../steering/schema";
import {
  STEERING_NATIVE_INSPECTION_SCHEMA,
  STEERING_SOURCE_ROOT,
  nativeSteeringDiscoveryPolicy,
  steeringSourcePathSchema,
  type InspectNativeSteeringOptions,
  type NativeSteeringInspection,
  type SteeringDuplicateSourceIdentity,
  type SteeringInvalidNativeSource,
  type SteeringSourceFileObservation,
  type SteeringSourceFilesystemObservation,
  type SteeringSourceIssue,
  type SteeringSourceIssueCode,
  type SteeringSourceParseSuccess,
} from "./contract";
import { parseNativeSteeringSource } from "./parser";

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

class SourceFilesystemError extends Error {
  constructor(
    readonly issueCode: SteeringSourceIssueCode,
    readonly logicalPath: string,
    readonly detail?: string,
  ) {
    super(issueCode);
    this.name = "SourceFilesystemError";
  }
}

const nodeCode = (error: unknown): string | undefined => typeof error === "object" && error !== null && "code" in error &&
  typeof error.code === "string" ? error.code : undefined;

function stableIssues(issues: readonly SteeringSourceIssue[]): SteeringSourceIssue[] {
  return [...new Map(issues.map((issue) => [canonical(issue), issue])).values()]
    .sort((left, right) => compareText(canonical(left), canonical(right)));
}

function freezeData<T>(value: T): T {
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

const pathIssue = (
  code: SteeringSourceIssueCode,
  path: string,
  severity: "error" | "warning" = "error",
  detail?: string,
): SteeringSourceIssue => ({ code, severity, path, ...(detail === undefined ? {} : { detail }) });

function finalInspection(value: Omit<NativeSteeringInspection, "status">): NativeSteeringInspection {
  const invalid = value.invalid_sources.length > 0 || value.duplicate_identities.length > 0 || value.unsafe_paths.length > 0;
  return freezeData({ ...value, status: invalid ? "invalid" as const : "valid" as const });
}

function emptyInspection(
  project: string,
  rootStatus: NativeSteeringInspection["root_status"],
  complete: boolean,
  unsafePaths: readonly SteeringSourceIssue[] = [],
  warnings: readonly SteeringSourceIssue[] = [],
  invalidSources: readonly SteeringInvalidNativeSource[] = [],
): NativeSteeringInspection {
  return finalInspection({
    schema: STEERING_NATIVE_INSPECTION_SCHEMA,
    complete,
    root_status: rootStatus,
    discovery_policy: nativeSteeringDiscoveryPolicy,
    project,
    control: { steering_root: STEERING_SOURCE_ROOT },
    discovered_sources: [],
    proposals: [],
    invalid_sources: [...invalidSources],
    duplicate_identities: [],
    unsafe_paths: stableIssues(unsafePaths),
    warnings: stableIssues(warnings),
  });
}

function inside(root: string, target: string): boolean {
  const part = relative(root, target);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

async function checkNoSymlinkPath(projectRoot: string, target: string, logical: string, finalKind?: "file" | "directory"): Promise<void> {
  if (!inside(projectRoot, target)) throw new SourceFilesystemError("steering-source-root-unsafe", logical, "path-escaped-project-root");
  let trustedRoot;
  try { trustedRoot = await lstat(projectRoot, { bigint: true }); }
  catch (error) { if (nodeCode(error) === "ENOENT") throw error; throw new SourceFilesystemError("steering-source-unreadable", logical, "trusted-root-lstat-failed"); }
  const absolute = resolve(target), filesystemRoot = parse(absolute).root;
  const parts = relative(filesystemRoot, absolute).split(/[\\/]/).filter(Boolean);
  let cursor = filesystemRoot;
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]!);
    let stat;
    try { stat = await lstat(cursor, { bigint: true }); }
    catch (error) {
      if (nodeCode(error) === "ENOENT") throw error;
      throw new SourceFilesystemError("steering-source-unreadable", logical, "lstat-failed");
    }
    if (stat.isSymbolicLink()) throw new SourceFilesystemError("steering-source-symlink", logical);
    if (inside(projectRoot, cursor) && stat.dev !== trustedRoot.dev)
      throw new SourceFilesystemError("steering-source-root-unsafe", logical, "cross-device-source");
    if (cursor === projectRoot && (stat.dev !== trustedRoot.dev || stat.ino !== trustedRoot.ino))
      throw new SourceFilesystemError("steering-source-path-race", logical, "trusted-root-substituted");
    const last = index === parts.length - 1;
    if (!last && !stat.isDirectory()) throw new SourceFilesystemError("steering-source-root-unsafe", logical, "non-directory-ancestor");
    if (last && finalKind === "directory" && !stat.isDirectory())
      throw new SourceFilesystemError("steering-source-root-unsafe", logical, "not-directory");
    if (last && finalKind === "file" && !stat.isFile())
      throw new SourceFilesystemError("steering-source-non-regular", logical);
  }
  try {
    if (await realpath(absolute) !== absolute)
      throw new SourceFilesystemError("steering-source-root-unsafe", logical, "noncanonical-realpath");
  } catch (error) {
    if (error instanceof SourceFilesystemError || nodeCode(error) === "ENOENT") throw error;
    throw new SourceFilesystemError("steering-source-unreadable", logical, "realpath-failed");
  }
}

function sameDirectoryObservation(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function safeEntryName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") &&
    !name.includes(":") && !/[\u0000-\u001f\u007f]/.test(name);
}

function ignoredName(name: string): boolean {
  return name === "AGENTS.md" || name === ".DS_Store" || name.endsWith("~") || name.startsWith(".#") ||
    /^#.*#$/.test(name) || /\.(?:swp|swo|tmp|temp|bak)$/.test(name);
}

interface ScanState {
  entries: number;
  incomplete: boolean;
  candidates: Candidate[];
  directories: DirectoryObservation[];
  unsafe: SteeringSourceIssue[];
  warnings: SteeringSourceIssue[];
}

async function directoryNames(projectRoot: string, absolute: string, logical: string, state: ScanState): Promise<string[]> {
  await checkNoSymlinkPath(projectRoot, absolute, logical, "directory");
  const before = await lstat(absolute, { bigint: true });
  if (!before.isDirectory()) throw new SourceFilesystemError("steering-source-root-unsafe", logical, "not-directory");
  const names: string[] = [];
  let directory;
  try { directory = await opendir(absolute); }
  catch { throw new SourceFilesystemError("steering-source-unreadable", logical, "open-directory-failed"); }
  try {
    for await (const entry of directory) {
      names.push(entry.name);
      state.entries++;
      if (names.length > nativeSteeringDiscoveryPolicy.max_entries_per_directory ||
        state.entries > nativeSteeringDiscoveryPolicy.max_total_entries) {
        state.incomplete = true;
        state.unsafe.push(pathIssue("steering-source-entry-limit", logical));
        break;
      }
    }
  } catch {
    throw new SourceFilesystemError("steering-source-unreadable", logical, "read-directory-failed");
  }
  if (state.incomplete) return [];
  await checkNoSymlinkPath(projectRoot, absolute, logical, "directory");
  const after = await lstat(absolute, { bigint: true });
  if (!sameDirectoryObservation(before, after))
    throw new SourceFilesystemError("steering-source-path-race", logical, "directory-changed-during-discovery");
  state.directories.push({ absolute, logical, stat: after });
  return names.sort(compareText);
}

async function scanDirectory(
  projectRoot: string,
  absolute: string,
  logical: string,
  location: "root" | "custom",
  customDepth: number,
  state: ScanState,
): Promise<void> {
  if (state.incomplete) return;
  let names: string[];
  try { names = await directoryNames(projectRoot, absolute, logical, state); }
  catch (error) {
    const issue = error instanceof SourceFilesystemError ? pathIssue(error.issueCode, error.logicalPath, "error", error.detail) :
      pathIssue("steering-source-unreadable", logical);
    state.unsafe.push(issue); state.incomplete = true; return;
  }
  for (const name of names) {
    if (state.incomplete) return;
    const entryLogical = `${logical}/${name}`;
    if (!safeEntryName(name) || !steeringSourcePathOrDirectory(entryLogical)) {
      state.unsafe.push(pathIssue("steering-source-root-unsafe", entryLogical, "error", "invalid-entry-name"));
      continue;
    }
    const entryAbsolute = join(absolute, name);
    let stat;
    try { stat = await lstat(entryAbsolute, { bigint: true }); }
    catch (error) {
      state.unsafe.push(pathIssue(nodeCode(error) === "ENOENT" ? "steering-source-path-race" : "steering-source-unreadable", entryLogical));
      continue;
    }
    if (stat.isSymbolicLink()) {
      state.unsafe.push(pathIssue("steering-source-symlink", entryLogical));
      continue;
    }
    if (stat.isDirectory()) {
      if (location === "root" && name === nativeSteeringDiscoveryPolicy.custom_directory) {
        await scanDirectory(projectRoot, entryAbsolute, entryLogical, "custom", 0, state);
      } else if (location === "custom") {
        if (customDepth >= nativeSteeringDiscoveryPolicy.custom_max_depth) {
          state.unsafe.push(pathIssue("steering-source-custom-depth-limit", entryLogical));
          continue;
        }
        await scanDirectory(projectRoot, entryAbsolute, entryLogical, "custom", customDepth + 1, state);
      } else {
        state.warnings.push(pathIssue("steering-source-unsupported-directory", entryLogical, "warning"));
      }
      continue;
    }
    if (!stat.isFile()) {
      state.unsafe.push(pathIssue("steering-source-non-regular", entryLogical));
      continue;
    }
    if (stat.nlink !== 1n) {
      state.unsafe.push(pathIssue("steering-source-hardlink", entryLogical));
      continue;
    }
    if (ignoredName(name)) continue;
    if (!nativeSteeringDiscoveryPolicy.extensions.includes(extname(name) as ".md")) {
      state.warnings.push(pathIssue("steering-source-unsupported-extension", entryLogical, "warning"));
      continue;
    }
    if (!steeringSourcePathSchema.safeParse(entryLogical).success) {
      state.unsafe.push(pathIssue("steering-source-path-invalid", entryLogical));
      continue;
    }
    state.candidates.push({ absolute: entryAbsolute, logical: entryLogical, size: stat.size });
  }
}

function steeringSourcePathOrDirectory(path: string): boolean {
  return path.length <= nativeSteeringDiscoveryPolicy.max_logical_path_bytes &&
    new TextEncoder().encode(path).length <= nativeSteeringDiscoveryPolicy.max_logical_path_bytes && !path.startsWith("/") &&
    !path.includes("\\") && !path.includes(":") && !/[\u0000-\u001f\u007f]/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function filesystemObservation(stat: BigIntStats, size: number): SteeringSourceFilesystemObservation {
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

async function readCandidate(projectRoot: string, candidate: Candidate): Promise<{
  bytes: Uint8Array;
  filesystem: SteeringSourceFilesystemObservation;
}> {
  await checkNoSymlinkPath(projectRoot, candidate.absolute, candidate.logical, "file");
  const before = await lstat(candidate.absolute, { bigint: true });
  if (!before.isFile()) throw new SourceFilesystemError("steering-source-non-regular", candidate.logical);
  if (before.nlink !== 1n) throw new SourceFilesystemError("steering-source-hardlink", candidate.logical);
  if (before.size !== candidate.size)
    throw new SourceFilesystemError("steering-source-path-race", candidate.logical, "size-changed-after-discovery");
  if (before.size > BigInt(nativeSteeringDiscoveryPolicy.max_file_bytes))
    throw new SourceFilesystemError("steering-source-file-size-limit", candidate.logical);
  if (!constants.O_NOFOLLOW)
    throw new SourceFilesystemError("steering-source-root-unsafe", candidate.logical, "no-follow-unavailable");

  let handle;
  try { handle = await open(candidate.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = nodeCode(error);
    if (code === "ELOOP") throw new SourceFilesystemError("steering-source-symlink", candidate.logical);
    if (code === "ENOENT") throw new SourceFilesystemError("steering-source-path-race", candidate.logical, "file-disappeared");
    throw new SourceFilesystemError("steering-source-unreadable", candidate.logical, "open-file-failed");
  }

  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new SourceFilesystemError("steering-source-non-regular", candidate.logical);
    if (opened.nlink !== 1n) throw new SourceFilesystemError("steering-source-hardlink", candidate.logical);
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new SourceFilesystemError("steering-source-path-race", candidate.logical, "file-substituted-during-open");
    if (opened.size > BigInt(nativeSteeringDiscoveryPolicy.max_file_bytes))
      throw new SourceFilesystemError("steering-source-file-size-limit", candidate.logical);

    const maximum = nativeSteeringDiscoveryPolicy.max_file_bytes;
    const storage = new Uint8Array(maximum + 1);
    let offset = 0;
    for (;;) {
      const amount = Math.min(64 * 1024, storage.length - offset);
      if (amount === 0) throw new SourceFilesystemError("steering-source-file-size-limit", candidate.logical);
      const { bytesRead } = await handle.read(storage, offset, amount, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > maximum) throw new SourceFilesystemError("steering-source-file-size-limit", candidate.logical);
    }

    await checkNoSymlinkPath(projectRoot, candidate.absolute, candidate.logical, "file");
    const after = await lstat(candidate.absolute, { bigint: true });
    const final = await handle.stat({ bigint: true });
    if (!after.isFile() || after.nlink !== 1n || final.nlink !== 1n)
      throw new SourceFilesystemError(after.isFile() ? "steering-source-hardlink" : "steering-source-non-regular", candidate.logical);
    if (before.dev !== after.dev || before.ino !== after.ino || opened.dev !== final.dev || opened.ino !== final.ino ||
      before.size !== final.size || before.mtimeNs !== final.mtimeNs || before.ctimeNs !== final.ctimeNs ||
      BigInt(offset) !== final.size)
      throw new SourceFilesystemError("steering-source-path-race", candidate.logical, "file-changed-during-read");
    return { bytes: storage.slice(0, offset), filesystem: filesystemObservation(final, offset) };
  } finally { await handle.close(); }
}

async function recheckDirectories(projectRoot: string, state: ScanState): Promise<void> {
  for (const observation of [...state.directories].sort((left, right) => compareText(left.logical, right.logical))) {
    try {
      await checkNoSymlinkPath(projectRoot, observation.absolute, observation.logical, "directory");
      const current = await lstat(observation.absolute, { bigint: true });
      if (!sameDirectoryObservation(observation.stat, current))
        throw new SourceFilesystemError("steering-source-path-race", observation.logical, "directory-changed-after-discovery");
    } catch (error) {
      const issue = error instanceof SourceFilesystemError ? pathIssue(error.issueCode, error.logicalPath, "error", error.detail) :
        pathIssue(nodeCode(error) === "ENOENT" ? "steering-source-path-race" : "steering-source-unreadable", observation.logical);
      state.unsafe.push(issue);
      state.incomplete = true;
    }
  }
}

function invalidFromIssue(path: string, issue: SteeringSourceIssue): SteeringInvalidNativeSource {
  return { source_path: path, issues: [issue] };
}

/**
 * Read-only bounded inspection from one explicitly supplied absolute project
 * root. It never initializes control storage, publishes blobs, or consults the
 * authoritative Steering registry.
 */
export async function inspectNativeSteering(
  projectRootInput: string,
  options: InspectNativeSteeringOptions,
): Promise<NativeSteeringInspection> {
  const project = typeof options?.project === "string" ? options.project : "<invalid>";
  if (!steeringProjectNamespaceSchema.safeParse(project).success)
    return emptyInspection(project, "unsafe", false, [pathIssue("steering-source-project-invalid", STEERING_SOURCE_ROOT)]);
  if (typeof projectRootInput !== "string" || !isAbsolute(projectRootInput) || resolve(projectRootInput) !== projectRootInput)
    return emptyInspection(project, "unsafe", false, [pathIssue("steering-source-root-unsafe", STEERING_SOURCE_ROOT, "error", "absolute-canonical-root-required")]);

  const projectRoot = projectRootInput;
  try { await checkNoSymlinkPath(projectRoot, projectRoot, ".", "directory"); }
  catch (error) {
    const issue = error instanceof SourceFilesystemError ? pathIssue(error.issueCode, STEERING_SOURCE_ROOT, "error", error.detail) :
      pathIssue("steering-source-root-unsafe", STEERING_SOURCE_ROOT);
    return emptyInspection(project, "unsafe", false, [issue]);
  }

  const steeringRoot = join(projectRoot, ".aira", "steering");
  try { await checkNoSymlinkPath(projectRoot, steeringRoot, STEERING_SOURCE_ROOT, "directory"); }
  catch (error) {
    if (nodeCode(error) === "ENOENT") return emptyInspection(project, "missing", true, [], [
      pathIssue("steering-source-root-missing", STEERING_SOURCE_ROOT, "warning"),
    ]);
    const issue = error instanceof SourceFilesystemError ? pathIssue(error.issueCode, STEERING_SOURCE_ROOT, "error", error.detail) :
      pathIssue("steering-source-root-unsafe", STEERING_SOURCE_ROOT);
    return emptyInspection(project, error instanceof SourceFilesystemError && error.issueCode === "steering-source-unreadable" ? "unreadable" : "unsafe", false, [issue]);
  }

  const state: ScanState = { entries: 0, incomplete: false, candidates: [], directories: [], unsafe: [], warnings: [] };
  await scanDirectory(projectRoot, steeringRoot, STEERING_SOURCE_ROOT, "root", 0, state);
  state.candidates.sort((left, right) => compareText(left.logical, right.logical));
  if (state.incomplete) return emptyInspection(project, "present", false, state.unsafe, state.warnings);

  if (state.candidates.length > nativeSteeringDiscoveryPolicy.max_files) {
    const issue = pathIssue("steering-source-file-count-limit", STEERING_SOURCE_ROOT);
    return emptyInspection(project, "present", false, state.unsafe, state.warnings,
      [invalidFromIssue(STEERING_SOURCE_ROOT, issue)]);
  }
  const aggregate = state.candidates.reduce((total, candidate) => total + candidate.size, 0n);
  if (aggregate > BigInt(nativeSteeringDiscoveryPolicy.max_aggregate_bytes)) {
    const issue = pathIssue("steering-source-aggregate-size-limit", STEERING_SOURCE_ROOT);
    return emptyInspection(project, "present", false, state.unsafe, state.warnings,
      [invalidFromIssue(STEERING_SOURCE_ROOT, issue)]);
  }

  const discovered: SteeringSourceFileObservation[] = [];
  const parsed: SteeringSourceParseSuccess[] = [];
  const invalid: SteeringInvalidNativeSource[] = [];
  let complete = true;
  for (const candidate of state.candidates) {
    if (candidate.size > BigInt(nativeSteeringDiscoveryPolicy.max_file_bytes)) {
      invalid.push(invalidFromIssue(candidate.logical, pathIssue("steering-source-file-size-limit", candidate.logical)));
      continue;
    }
    let read;
    try { read = await readCandidate(projectRoot, candidate); }
    catch (error) {
      const issue = error instanceof SourceFilesystemError ? pathIssue(error.issueCode, error.logicalPath, "error", error.detail) :
        pathIssue("steering-source-unreadable", candidate.logical);
      if (["steering-source-symlink", "steering-source-hardlink", "steering-source-non-regular", "steering-source-path-race",
        "steering-source-root-unsafe"].includes(issue.code)) state.unsafe.push(issue);
      else invalid.push(invalidFromIssue(candidate.logical, issue));
      if (issue.code === "steering-source-path-race" || issue.code === "steering-source-unreadable") complete = false;
      continue;
    }
    const result = parseNativeSteeringSource({
      project,
      source_path: candidate.logical,
      bytes: read.bytes,
      filesystem: read.filesystem,
    });
    if (result.ok) {
      discovered.push({
        schema: "aira.dev/steering-source-file-observation/v1",
        discovery: result.observation.discovery,
        project: result.observation.project,
        source_path: result.observation.source_path,
        source: result.observation.source,
        filesystem: result.observation.filesystem,
      });
      parsed.push(result);
      state.warnings.push(...result.warnings);
    } else {
      if (result.file) discovered.push(result.file);
      invalid.push({ source_path: result.source_path, ...(result.file === undefined ? {} : { file: result.file }), issues: result.issues });
      state.warnings.push(...result.warnings);
    }
  }

  await recheckDirectories(projectRoot, state);
  if (state.incomplete) complete = false;

  const byIdentity = new Map<string, SteeringSourceParseSuccess[]>();
  for (const result of parsed) {
    const id = result.observation.identity.id;
    const values = byIdentity.get(id) ?? [];
    values.push(result); byIdentity.set(id, values);
  }
  const duplicates: SteeringDuplicateSourceIdentity[] = [];
  const proposals: SteeringSourceParseSuccess[] = [];
  for (const [id, values] of [...byIdentity.entries()].sort(([left], [right]) => compareText(left, right))) {
    values.sort((left, right) => compareText(left.observation.source_path, right.observation.source_path));
    if (values.length === 1) { proposals.push(values[0]!); continue; }
    const paths = values.map((value) => value.observation.source_path);
    const issue: SteeringSourceIssue = {
      code: "steering-source-duplicate-resource-id",
      severity: "error",
      resource_id: values[0]!.observation.identity.id,
      related_paths: paths,
    };
    duplicates.push({ resource_id: values[0]!.observation.identity.id, paths, issue });
    for (const value of values) invalid.push({
      source_path: value.observation.source_path,
      file: {
        schema: "aira.dev/steering-source-file-observation/v1",
        discovery: value.observation.discovery,
        project: value.observation.project,
        source_path: value.observation.source_path,
        source: value.observation.source,
        filesystem: value.observation.filesystem,
      },
      issues: [{ ...issue, path: value.observation.source_path }],
      parsed: value,
    });
  }

  discovered.sort((left, right) => compareText(left.source_path, right.source_path));
  proposals.sort((left, right) => compareText(left.observation.identity.id, right.observation.identity.id) ||
    compareText(left.observation.source_path, right.observation.source_path));
  invalid.sort((left, right) => compareText(left.source_path, right.source_path) || compareText(canonical(left.issues), canonical(right.issues)));
  duplicates.sort((left, right) => compareText(left.resource_id, right.resource_id));

  return finalInspection({
    schema: STEERING_NATIVE_INSPECTION_SCHEMA,
    complete,
    root_status: "present",
    discovery_policy: nativeSteeringDiscoveryPolicy,
    project,
    control: { steering_root: STEERING_SOURCE_ROOT },
    discovered_sources: discovered,
    proposals,
    invalid_sources: invalid,
    duplicate_identities: duplicates,
    unsafe_paths: stableIssues(state.unsafe),
    warnings: stableIssues(state.warnings),
  });
}
