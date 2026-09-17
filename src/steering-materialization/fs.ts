import { constants, type BigIntStats } from "node:fs";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, statfs, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { hashBytes } from "../canonical-json";
import { compareText, exact } from "../spec/domain/primitives";
import {
  nativeSteeringDiscoveryPolicy,
  parseNativeSteeringSource,
  steeringSourcePathSchema,
  type SteeringSourceObservation,
  type SteeringSourceProposal,
} from "../steering-source";
import {
  materializationDirectoryObservationSchema,
  materializationFileIdentitySchema,
  materializationPortablePathKey,
  materializationSourceDescriptorSchema,
  materializationTargetStateSchema,
  type MaterializationDirectoryObservation,
  type MaterializationFileIdentity,
  type MaterializationTargetState,
  type SteeringMaterializationFileOptions,
} from "./types";

const nodeCode = (error: unknown): string | undefined => typeof error === "object" && error !== null && "code" in error &&
  typeof error.code === "string" ? error.code : undefined;

export class MaterializationFilesystemError extends Error {
  constructor(
    readonly reason: string,
    readonly target_path?: string,
    readonly stale = false,
    options?: ErrorOptions,
    readonly published = false,
  ) {
    super(reason, options);
    this.name = "MaterializationFilesystemError";
  }
}

interface TrustedRoot {
  readonly path: string;
  readonly stat: BigIntStats;
}

interface RuntimeDirectory {
  readonly logical: string;
  readonly absolute: string;
  readonly stat: BigIntStats;
}

export interface ObservedMaterializationTarget {
  readonly state: MaterializationTargetState;
  readonly source_observation?: SteeringSourceObservation;
  readonly proposal?: SteeringSourceProposal;
  readonly source_bytes?: Uint8Array;
}

function inside(root: string, target: string): boolean {
  const part = relative(root, target);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function sameEntry(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function identity(stat: BigIntStats): MaterializationFileIdentity {
  return materializationFileIdentitySchema.parse({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    links: Number(stat.nlink),
    mode: Number(stat.mode),
  }) as MaterializationFileIdentity;
}

function sameIdentity(left: MaterializationFileIdentity, right: MaterializationFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.links === right.links && left.mode === right.mode;
}

async function requiredLstat(path: string, targetPath?: string): Promise<BigIntStats> {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if (nodeCode(error) === "ENOENT") throw new MaterializationFilesystemError("path-missing", targetPath);
    throw new MaterializationFilesystemError("lstat-failed", targetPath, false, { cause: error });
  }
}

/** Explicit trusted root, matching the native source adapter's no-cwd contract. */
export async function assertTrustedMaterializationRoot(projectRootInput: string): Promise<TrustedRoot> {
  if (typeof projectRootInput !== "string" || !isAbsolute(projectRootInput) || resolve(projectRootInput) !== projectRootInput)
    throw new MaterializationFilesystemError("absolute-canonical-root-required");
  let stat: BigIntStats;
  try { stat = await lstat(projectRootInput, { bigint: true }); }
  catch (error) { throw new MaterializationFilesystemError("trusted-root-unreadable", undefined, false, { cause: error }); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new MaterializationFilesystemError("trusted-root-unsafe");
  try {
    if (await realpath(projectRootInput) !== projectRootInput)
      throw new MaterializationFilesystemError("trusted-root-noncanonical");
  } catch (error) {
    if (error instanceof MaterializationFilesystemError) throw error;
    throw new MaterializationFilesystemError("trusted-root-realpath-failed", undefined, false, { cause: error });
  }
  return { path: projectRootInput, stat };
}

/** Same local durable-filesystem boundary used by authoritative file storage. */
export async function assertMaterializationDurabilitySupport(projectRoot: string): Promise<void> {
  const root = await assertTrustedMaterializationRoot(projectRoot);
  if (process.platform !== "linux") throw new MaterializationFilesystemError("durable-publication-linux-required");
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK || !constants.O_DIRECTORY)
    throw new MaterializationFilesystemError("durability-primitives-unavailable");
  let info;
  try { info = await statfs(root.path); }
  catch (error) { throw new MaterializationFilesystemError("filesystem-capability-check-failed", undefined, false, { cause: error }); }
  const type = info.type >>> 0;
  if ([0x01021994, 0x858458f6].includes(type) ||
    [0x6969, 0xff534d42, 0xfe534d42, 0x517b, 0x01021997, 0x00c36400, 0x5346414f, 0x65735546].includes(type))
    throw new MaterializationFilesystemError("durable-publication-filesystem-unsupported");
}

function absoluteTarget(root: TrustedRoot, targetPath: string): string {
  if (!steeringSourcePathSchema.safeParse(targetPath).success)
    throw new MaterializationFilesystemError("invalid-target-path", targetPath);
  const absolute = resolve(root.path, ...targetPath.split("/"));
  if (!inside(root.path, absolute)) throw new MaterializationFilesystemError("target-escaped-project-root", targetPath);
  return absolute;
}

export function materializationDirectoriesForTarget(targetPath: string): string[] {
  const parsed = steeringSourcePathSchema.safeParse(targetPath);
  if (!parsed.success) throw new MaterializationFilesystemError("invalid-target-path", targetPath);
  const parts = targetPath.split("/");
  parts.pop();
  const result: string[] = [];
  for (let index = 1; index <= parts.length; index++) result.push(parts.slice(0, index).join("/"));
  return result;
}

function parentDirectoryPath(targetPath: string): string {
  const paths = materializationDirectoriesForTarget(targetPath);
  return paths.at(-1)!;
}

function parentLogical(path: string): string | undefined {
  const index = path.lastIndexOf("/");
  return index < 0 ? undefined : path.slice(0, index);
}

async function directoryAt(root: TrustedRoot, logical: string): Promise<RuntimeDirectory | undefined> {
  const parts = logical.split("/");
  let cursor = root.path;
  for (const part of parts) {
    cursor = join(cursor, part);
    let stat: BigIntStats;
    try { stat = await lstat(cursor, { bigint: true }); }
    catch (error) {
      if (nodeCode(error) === "ENOENT") return undefined;
      throw new MaterializationFilesystemError("directory-lstat-failed", logical, false, { cause: error });
    }
    if (stat.isSymbolicLink()) throw new MaterializationFilesystemError("symlink-directory", logical);
    if (!stat.isDirectory()) throw new MaterializationFilesystemError("non-directory-ancestor", logical);
    if (stat.dev !== root.stat.dev) throw new MaterializationFilesystemError("cross-device-directory", logical);
    try {
      if (await realpath(cursor) !== cursor) throw new MaterializationFilesystemError("noncanonical-directory", logical);
    } catch (error) {
      if (error instanceof MaterializationFilesystemError) throw error;
      throw new MaterializationFilesystemError("directory-realpath-failed", logical, false, { cause: error });
    }
  }
  return { logical, absolute: join(root.path, ...parts), stat: await requiredLstat(join(root.path, ...parts), logical) };
}

async function assertNoPortableAmbiguity(root: TrustedRoot, targetPath: string): Promise<void> {
  const parts = targetPath.split("/");
  let parent = root.path;
  let parentStat = root.stat;
  for (const part of parts) {
    if (!parentStat.isDirectory()) throw new MaterializationFilesystemError("non-directory-ancestor", targetPath);
    const before = parentStat;
    let names: string[];
    try { names = await readdir(parent); }
    catch (error) { throw new MaterializationFilesystemError("directory-read-failed", targetPath, false, { cause: error }); }
    const key = materializationPortablePathKey(part);
    const ambiguous = names.find((name) => name !== part && materializationPortablePathKey(name) === key);
    if (ambiguous !== undefined) throw new MaterializationFilesystemError(`portable-path-ambiguity:${ambiguous}`, targetPath);
    const after = await requiredLstat(parent, targetPath);
    if (!sameDirectory(before, after)) throw new MaterializationFilesystemError("directory-changed-during-observation", targetPath, true);

    const child = join(parent, part);
    let childStat: BigIntStats;
    try { childStat = await lstat(child, { bigint: true }); }
    catch (error) {
      if (nodeCode(error) === "ENOENT") return;
      throw new MaterializationFilesystemError("path-lstat-failed", targetPath, false, { cause: error });
    }
    if (childStat.isSymbolicLink()) throw new MaterializationFilesystemError("symlink-path", targetPath);
    if (childStat.dev !== root.stat.dev) throw new MaterializationFilesystemError("cross-device-path", targetPath);
    parent = child; parentStat = childStat;
  }
}

async function observeOneDirectory(root: TrustedRoot, logical: string): Promise<MaterializationDirectoryObservation> {
  const found = await directoryAt(root, logical);
  if (found === undefined) return materializationDirectoryObservationSchema.parse({ path: logical, status: "absent" }) as MaterializationDirectoryObservation;
  return materializationDirectoryObservationSchema.parse({ path: logical, status: "present", filesystem: identity(found.stat) }) as MaterializationDirectoryObservation;
}

/** Read-only exact directory observations needed for planned safe directory creation. */
export async function observeMaterializationDirectories(
  projectRoot: string,
  targetPaths: readonly string[],
): Promise<readonly MaterializationDirectoryObservation[]> {
  const root = await assertTrustedMaterializationRoot(projectRoot);
  const directories = new Set<string>();
  for (const targetPath of targetPaths) {
    await assertNoPortableAmbiguity(root, targetPath);
    for (const directory of materializationDirectoriesForTarget(targetPath)) directories.add(directory);
  }
  const ordered = [...directories].sort(compareText);
  const observations: MaterializationDirectoryObservation[] = [];
  for (const directory of ordered) observations.push(await observeOneDirectory(root, directory));
  return observations;
}

/** Bounded no-follow exact target observation. It never creates a directory or file. */
export async function observeMaterializationTarget(
  projectRoot: string,
  project: string,
  targetPath: string,
): Promise<ObservedMaterializationTarget> {
  const root = await assertTrustedMaterializationRoot(projectRoot);
  const absolute = absoluteTarget(root, targetPath);
  await assertNoPortableAmbiguity(root, targetPath);
  const parent = await directoryAt(root, parentDirectoryPath(targetPath));
  if (parent === undefined) return { state: materializationTargetStateSchema.parse({ status: "absent", target_path: targetPath }) as MaterializationTargetState };

  let before: BigIntStats;
  try { before = await lstat(absolute, { bigint: true }); }
  catch (error) {
    if (nodeCode(error) === "ENOENT") return { state: materializationTargetStateSchema.parse({ status: "absent", target_path: targetPath }) as MaterializationTargetState };
    throw new MaterializationFilesystemError("target-lstat-failed", targetPath, false, { cause: error });
  }
  if (before.isSymbolicLink()) throw new MaterializationFilesystemError("symlink-target", targetPath);
  if (!before.isFile()) throw new MaterializationFilesystemError("non-regular-target", targetPath);
  if (before.nlink !== 1n) throw new MaterializationFilesystemError("hardlinked-target", targetPath);
  if (before.dev !== root.stat.dev) throw new MaterializationFilesystemError("cross-device-target", targetPath);
  if (before.size > BigInt(nativeSteeringDiscoveryPolicy.max_file_bytes))
    throw new MaterializationFilesystemError("target-file-size-limit", targetPath);
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK)
    throw new MaterializationFilesystemError("no-follow-unavailable", targetPath);

  let handle;
  try { handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (nodeCode(error) === "ELOOP") throw new MaterializationFilesystemError("symlink-target", targetPath);
    if (nodeCode(error) === "ENOENT") throw new MaterializationFilesystemError("target-disappeared", targetPath, true);
    throw new MaterializationFilesystemError("target-open-failed", targetPath, false, { cause: error });
  }

  let bytes: Uint8Array;
  let final: BigIntStats;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new MaterializationFilesystemError("non-regular-target", targetPath);
    if (opened.nlink !== 1n) throw new MaterializationFilesystemError("hardlinked-target", targetPath);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new MaterializationFilesystemError("target-replaced-during-open", targetPath, true);
    if (opened.size > BigInt(nativeSteeringDiscoveryPolicy.max_file_bytes))
      throw new MaterializationFilesystemError("target-file-size-limit", targetPath);
    const storage = new Uint8Array(nativeSteeringDiscoveryPolicy.max_file_bytes + 1);
    let offset = 0;
    for (;;) {
      const amount = Math.min(64 * 1024, storage.length - offset);
      if (amount === 0) throw new MaterializationFilesystemError("target-file-size-limit", targetPath);
      const { bytesRead } = await handle.read(storage, offset, amount, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    bytes = storage.slice(0, offset);
    const after = await requiredLstat(absolute, targetPath);
    final = await handle.stat({ bigint: true });
    if (!sameEntry(before, after) || !sameEntry(opened, final) || BigInt(bytes.length) !== final.size)
      throw new MaterializationFilesystemError("target-changed-during-read", targetPath, true);
  } finally { await handle.close(); }

  const source = materializationSourceDescriptorSchema.parse({
    hash: hashBytes(bytes), bytes: bytes.length, media_type: "text/markdown; charset=utf-8",
  });
  const filesystem = identity(final!);
  const parsed = parseNativeSteeringSource({
    project,
    source_path: targetPath,
    bytes,
    filesystem: {
      kind: "filesystem",
      device: final!.dev.toString(),
      inode: final!.ino.toString(),
      links: Number(final!.nlink),
      mode: Number(final!.mode),
      size: bytes.length,
      modified_ns: final!.mtimeNs.toString(),
      changed_ns: final!.ctimeNs.toString(),
    },
  });
  const state = materializationTargetStateSchema.parse({
    status: "present",
    target_path: targetPath,
    file: { source, filesystem, ...(parsed.ok ? { proposal: parsed.proposal } : {}) },
  }) as MaterializationTargetState;
  return {
    state,
    ...(parsed.ok ? { source_observation: parsed.observation, proposal: parsed.proposal } : {}),
    source_bytes: bytes,
  };
}

export function materializationTargetStateMatches(
  expected: MaterializationTargetState,
  actual: MaterializationTargetState,
): boolean {
  if (expected.status !== actual.status || expected.target_path !== actual.target_path) return false;
  if (expected.status === "absent" || actual.status === "absent") return true;
  return exact(expected.file.source, actual.file.source) && sameIdentity(expected.file.filesystem, actual.file.filesystem);
}

/** Verify every directory state before any plan write. */
export async function assertMaterializationDirectoryPreconditions(
  projectRoot: string,
  expected: readonly MaterializationDirectoryObservation[],
): Promise<void> {
  const root = await assertTrustedMaterializationRoot(projectRoot);
  for (const observation of expected) {
    const actual = await observeOneDirectory(root, observation.path);
    if (observation.status !== actual.status || (observation.status === "present" && actual.status === "present" &&
      !sameIdentity(observation.filesystem, actual.filesystem)))
      throw new MaterializationFilesystemError("directory-precondition-changed", observation.path, true);
  }
}

async function syncDirectory(root: TrustedRoot, logical?: string): Promise<void> {
  const absolute = logical === undefined ? root.path : join(root.path, ...logical.split("/"));
  const before = logical === undefined ? await requiredLstat(root.path) : (await directoryAt(root, logical))?.stat;
  if (before === undefined) throw new MaterializationFilesystemError("directory-missing", logical);
  let handle;
  try { handle = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) { throw new MaterializationFilesystemError("directory-sync-open-failed", logical, false, { cause: error }); }
  try {
    const opened = await handle.stat({ bigint: true });
    const named = await requiredLstat(absolute, logical);
    if (!opened.isDirectory() || opened.dev !== named.dev || opened.ino !== named.ino || !sameDirectory(before, named))
      throw new MaterializationFilesystemError("directory-replaced-before-sync", logical, true);
    await handle.sync();
  } catch (error) {
    if (error instanceof MaterializationFilesystemError) throw error;
    const code = nodeCode(error);
    if (["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EISDIR"].includes(code ?? ""))
      throw new MaterializationFilesystemError("directory-fsync-unavailable", logical, false, { cause: error });
    throw new MaterializationFilesystemError("directory-sync-failed", logical, false, { cause: error });
  } finally { await handle.close(); }
}

/**
 * Create only directories named by a plan. Missing states are checked before
 * mkdir; existing directories are revalidated by device, inode, links and mode.
 */
export async function ensureMaterializationDirectories(
  projectRoot: string,
  expected: readonly MaterializationDirectoryObservation[],
  targetPath: string,
  created: Map<string, MaterializationFileIdentity>,
): Promise<void> {
  await assertMaterializationDurabilitySupport(projectRoot);
  const root = await assertTrustedMaterializationRoot(projectRoot);
  const byPath = new Map(expected.map((observation) => [observation.path, observation]));
  for (const logical of materializationDirectoriesForTarget(targetPath)) {
    const planned = byPath.get(logical);
    if (planned === undefined) throw new MaterializationFilesystemError("directory-not-bound-in-plan", targetPath);
    const actual = await observeOneDirectory(root, logical);
    if (planned.status === "present") {
      if (actual.status !== "present" || !sameIdentity(planned.filesystem, actual.filesystem))
        throw new MaterializationFilesystemError("directory-precondition-changed", logical, true);
      continue;
    }
    const own = created.get(logical);
    if (own !== undefined) {
      if (actual.status !== "present" || !sameIdentity(own, actual.filesystem))
        throw new MaterializationFilesystemError("created-directory-changed", logical, true);
      continue;
    }
    if (actual.status !== "absent") throw new MaterializationFilesystemError("directory-precondition-changed", logical, true);
    const parent = parentLogical(logical);
    if (parent !== undefined) {
      const parentActual = await observeOneDirectory(root, parent);
      if (parentActual.status !== "present") throw new MaterializationFilesystemError("parent-directory-missing", logical, true);
    }
    const absolute = join(root.path, ...logical.split("/"));
    try { await mkdir(absolute, { mode: 0o700 }); }
    catch (error) {
      if (nodeCode(error) === "EEXIST") throw new MaterializationFilesystemError("directory-created-concurrently", logical, true);
      throw new MaterializationFilesystemError("directory-create-failed", logical, false, { cause: error });
    }
    const made = await observeOneDirectory(root, logical);
    if (made.status !== "present") throw new MaterializationFilesystemError("directory-create-not-visible", logical, true);
    created.set(logical, made.filesystem);
    await syncDirectory(root, logical);
    await syncDirectory(root, parent);
  }
}

function token(options: SteeringMaterializationFileOptions | undefined): string {
  const value = options?.token?.() ?? randomBytes(24).toString("hex");
  if (!/^[a-f0-9]{32,64}$/.test(value)) throw new MaterializationFilesystemError("unsafe-temporary-token");
  return value;
}

async function point(options: SteeringMaterializationFileOptions | undefined, pointName: Parameters<NonNullable<SteeringMaterializationFileOptions["failpoint"]>>[0]): Promise<void> {
  await options?.failpoint?.(pointName);
}

async function cleanTemporary(root: TrustedRoot, absolute: string, opened: BigIntStats | undefined, parentLogicalPath: string): Promise<void> {
  if (opened === undefined) return;
  try {
    const current = await lstat(absolute, { bigint: true });
    if (current.dev !== opened.dev || current.ino !== opened.ino) return;
    await unlink(absolute);
    await syncDirectory(root, parentLogicalPath);
  } catch (error) {
    if (nodeCode(error) !== "ENOENT") return;
  }
}

export interface PublishMaterializationTargetInput {
  readonly project_root: string;
  readonly target_path: string;
  readonly bytes: Uint8Array;
  readonly options?: SteeringMaterializationFileOptions;
  /** Rechecks target state and all relevant path identities immediately before rename. */
  readonly revalidate: () => Promise<void>;
}

/**
 * Complete-temp, fsync, revalidate, same-directory atomic rename, directory
 * fsync. The target is never opened for in-place writes.
 */
export async function publishMaterializationTarget(input: PublishMaterializationTargetInput): Promise<void> {
  if (!(input.bytes instanceof Uint8Array)) throw new MaterializationFilesystemError("publication-bytes-invalid", input.target_path);
  await assertMaterializationDurabilitySupport(input.project_root);
  const root = await assertTrustedMaterializationRoot(input.project_root);
  const target = absoluteTarget(root, input.target_path);
  const parentLogicalPath = parentDirectoryPath(input.target_path);
  const parent = await directoryAt(root, parentLogicalPath);
  if (parent === undefined) throw new MaterializationFilesystemError("parent-directory-missing", input.target_path, true);
  await assertNoPortableAmbiguity(root, input.target_path);
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK || !constants.O_DIRECTORY)
    throw new MaterializationFilesystemError("durability-primitives-unavailable", input.target_path);

  const temporary = join(dirname(target), `.aira-steering-materialization-${token(input.options)}.tmp`);
  let handle;
  let temporaryStat: BigIntStats | undefined;
  let published = false;
  try {
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (nodeCode(error) === "EEXIST" || nodeCode(error) === "ELOOP")
        throw new MaterializationFilesystemError("temporary-collision", input.target_path);
      throw new MaterializationFilesystemError("temporary-open-failed", input.target_path, false, { cause: error });
    }
    temporaryStat = await handle.stat({ bigint: true });
    await handle.writeFile(input.bytes);
    await point(input.options, "after-temp-write");
    await handle.sync();
    await point(input.options, "after-temp-fsync");
    await handle.close(); handle = undefined;

    await point(input.options, "before-target-publication");
    await input.revalidate();
    await rename(temporary, target);
    published = true;
    temporaryStat = undefined;
    await point(input.options, "after-target-publication");
    await point(input.options, "before-directory-fsync");
    await syncDirectory(root, parentLogicalPath);
    await point(input.options, "after-directory-fsync");
  } catch (error) {
    if (typeof error === "object" && error !== null && "materialization_authority_stale" in error &&
      (error as { materialization_authority_stale?: unknown }).materialization_authority_stale === true)
      throw error;
    if (error instanceof MaterializationFilesystemError) {
      if (published && !error.published)
        throw new MaterializationFilesystemError(error.reason, error.target_path, error.stale, { cause: error }, true);
      throw error;
    }
    throw new MaterializationFilesystemError("publication-failed", input.target_path, false, { cause: error }, published);
  } finally {
    try { await handle?.close(); }
    finally { await cleanTemporary(root, temporary, temporaryStat, parentLogicalPath); }
  }
}

export function materializationTemporaryPath(targetPath: string, tokenValue: string): string {
  return join(dirname(targetPath), `.aira-steering-materialization-${tokenValue}.tmp`);
}

export function materializationTargetBasename(targetPath: string): string {
  return basename(targetPath);
}
