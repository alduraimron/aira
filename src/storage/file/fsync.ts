import { constants } from "node:fs";
import { lstat, mkdir, open, link, unlink, rename, realpath, readdir, rmdir, statfs } from "node:fs/promises";
import { dirname, join, parse, resolve, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { errno, fail, io, StorageError } from "../errors";
import { StorePaths } from "./paths";
import { canonicalBytes, canonicalJSON, decodeCanonical } from "./canonical-json";

import { fileStoreFormat } from "../format";
export { fileStoreFormat } from "../format";

export type Failpoint = "after-lock-acquisition" | "after-steering-body-blob-publication" |
  "after-steering-revision-record-publication" | "after-blob-publication" | "after-commit-publication" |
  "after-head-temp-write" | "after-head-temp-fsync" | "before-head-rename" | "after-head-rename" |
  "after-head-directory-fsync" | "before-lock-release" | "after-snapshot-source-verification" |
  "after-snapshot-record-publication" | "after-snapshot-locator-publication";
/** Internal constructor injection only, never environment-controlled. */
export interface FileStoreOptions {
  clock?: () => string;
  token?: () => string;
  failpoint?: (point: Failpoint) => void | Promise<void>;
  capabilities?: () => { noFollow: boolean; directorySync: boolean; atomicReplace: boolean; exclusiveLink: boolean };
  lockTimeoutMs?: number;
}
export class DurableFS {
  readonly paths: StorePaths;
  constructor(projectRoot: string, readonly options: FileStoreOptions = {}) { this.paths = new StorePaths(projectRoot); }
  now(): string { return this.options.clock?.() ?? new Date().toISOString(); }
  token(): string {
    const token = this.options.token?.() ?? randomBytes(24).toString("hex");
    if (!/^[a-f0-9]{32,64}$/.test(token)) fail("STORE_PATH_UNSAFE", "Unsafe temporary/owner token");
    return token;
  }
  async point(point: Failpoint): Promise<void> { await this.options.failpoint?.(point); }
  /** lstat every ancestor, including the project path. No reads create directories. */
  async check(path: string, kind?: "file" | "directory"): Promise<void> {
    this.paths.assertInside(path);
    const absolute = resolve(path), root = parse(absolute).root;
    const parts = relative(root, absolute).split(/[\\/]/).filter(Boolean);
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      cursor = join(cursor, parts[i]!);
      const st = await lstat(cursor);
      if (st.isSymbolicLink()) fail("STORE_PATH_UNSAFE", `Symlink in control path: ${cursor}`);
      const last = i === parts.length - 1;
      if ((!last || kind === "directory") && !st.isDirectory()) fail("STORE_PATH_UNSAFE", `Not a directory: ${cursor}`);
      if (last && kind === "file" && (!st.isFile() || st.nlink < 1)) fail("STORE_PATH_UNSAFE", `Not a regular file: ${cursor}`);
    }
    if (await realpath(absolute) !== absolute) fail("STORE_PATH_UNSAFE", "Canonical path substitution detected");
  }
  async present(path: string, kind?: "file" | "directory"): Promise<boolean> {
    try { await this.check(path, kind); return true; } catch (error) { if (errno(error, "ENOENT")) return false; throw error; }
  }
  async syncDir(path: string): Promise<void> {
    await this.check(path, "directory");
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.sync();
    } catch (error) {
      if (["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EISDIR"].some((code) => errno(error, code)))
        throw new StorageError("STORE_DURABILITY_UNSUPPORTED", "Directory fsync is unavailable", { cause: error });
      throw error;
    } finally { await handle?.close(); }
  }
  async ensureDir(path: string): Promise<void> {
    this.paths.assertInside(path);
    if (await this.present(path, "directory")) {
      await this.mutationSupport(path);
      await this.syncDir(path);
      if (path !== this.paths.project) await this.ensureDir(dirname(path));
      return;
    }
    if (path === this.paths.project) fail("STORE_PATH_UNSAFE", "Project/control root must already exist");
    await this.ensureDir(dirname(path));
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (!errno(error, "EEXIST")) throw error; }
    await this.check(path, "directory"); await this.syncDir(path); await this.syncDir(dirname(path));
  }
  /** Called on each actual destination ancestor, not just the project mount. */
  async mutationSupport(path: string): Promise<void> {
    if (process.platform !== "linux") fail("STORE_DURABILITY_UNSUPPORTED", "Mutating file storage is supported only on Linux");
    const supported = !!constants.O_NOFOLLOW && !!constants.O_DIRECTORY;
    const c = this.options.capabilities?.() ?? { noFollow: supported, directorySync: supported, atomicReplace: supported, exclusiveLink: supported };
    if (!supported || c.noFollow !== true || c.directorySync !== true || c.atomicReplace !== true || c.exclusiveLink !== true)
      fail("STORE_DURABILITY_UNSUPPORTED", "Required no-follow, fsync, link and atomic replacement primitives unavailable");
    await this.check(path, "directory");
    // Known remote filesystem types are rejected, not advertised as local locks.
    const info = await statfs(path);
    const type = info.type >>> 0;
    if ([0x01021994, 0x858458f6].includes(type)) fail("STORE_DURABILITY_UNSUPPORTED", "Volatile tmpfs/ramfs cannot provide durable control storage");
    if ([0x6969, 0xff534d42, 0xfe534d42, 0x517b, 0x01021997, 0x00c36400, 0x5346414f, 0x65735546].includes(type))
      fail("STORE_DURABILITY_UNSUPPORTED", "Network/FUSE filesystems are unsupported");
  }
  async prepare(): Promise<void> {
    await this.mutationSupport(this.paths.project);
    if (await this.present(join(this.paths.project, ".aira", "FORMAT")))
      fail("STORE_SCHEMA_UNSUPPORTED", "Conflicting control-root FORMAT requires explicit inspection");
    if ((await this.entries(dirname(this.paths.root))).some((name) => name !== "v2"))
      fail("STORE_SCHEMA_UNSUPPORTED", "Conflicting state version roots require explicit inspection");
    if ((await this.entries(this.paths.root)).some((name) => !["FORMAT", "blobs", "specs", "steering", "locks"].includes(name) && !/^\.publish-tmp-[a-f0-9]{32,64}$/.test(name)))
      fail("STORE_SCHEMA_UNSUPPORTED", "Unknown v2 control namespace requires explicit inspection");
    await this.ensureDir(this.paths.root);
    const format = join(this.paths.root, "FORMAT");
    if (await this.present(format)) await this.checkFormat();
    else {
      // A killed first initializer can leave only recognized publication temporaries.
      // Never retrofit a format marker onto pre-existing unversioned authority.
      if ((await this.entries(this.paths.root)).some((entry) => !/^\.publish-tmp-[a-f0-9]+$/.test(entry)) && !await this.present(format))
        fail("STORE_SCHEMA_UNSUPPORTED", "Unversioned control storage requires explicit inspection");
      await this.immutable(format, canonicalBytes(fileStoreFormat));
    }
    await this.syncFile(format);
    await this.syncDir(this.paths.project);
  }
  async checkFormat(): Promise<void> {
    const path = join(this.paths.root, "FORMAT");
    if (!await this.present(path, "file")) fail("STORE_SCHEMA_UNSUPPORTED", "Missing store format record");
    const value = decodeCanonical(await this.read(path), "STORE_INTEGRITY");
    if (canonicalJSON(value) !== canonicalJSON(fileStoreFormat)) fail("STORE_SCHEMA_UNSUPPORTED", "Unsupported file-store format/encoding");
  }
  async read(path: string): Promise<Uint8Array> {
    await this.check(path, "file");
    const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await h.stat(), name = await lstat(path);
      if (!before.isFile() || before.dev !== name.dev || before.ino !== name.ino) fail("STORE_PATH_UNSAFE", "File substitution detected");
      const bytes = new Uint8Array(await h.readFile());
      await this.check(path, "file");
      const after = await lstat(path), final = await h.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== final.size ||
        before.mtimeMs !== final.mtimeMs)
        fail("STORE_PATH_UNSAFE", "File changed during read");
      return bytes;
    } finally { await h.close(); }
  }
  async syncFile(path: string): Promise<void> {
    await this.check(path, "file");
    const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const inode = await h.stat(), name = await lstat(path);
      if (!inode.isFile() || inode.dev !== name.dev || inode.ino !== name.ino) fail("STORE_PATH_UNSAFE", "Sync target substituted");
      await h.sync();
    } finally { await h.close(); }
    await this.ensureDir(dirname(path));
  }
  async temp(path: string, bytes: Uint8Array, head = false): Promise<string> {
    await this.check(path, "directory");
    const name = join(path, `${head ? ".head-tmp-" : ".publish-tmp-"}${this.token()}`);
    let h;
    try { h = await open(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (errno(error, "EEXIST") || errno(error, "ELOOP"))
        fail("STORE_PATH_UNSAFE", "Exclusive publication temporary target already exists");
      throw error;
    }
    try {
      await h.writeFile(bytes);
      if (head) await this.point("after-head-temp-write");
      await h.sync();
      if (head) await this.point("after-head-temp-fsync");
    } finally { await h.close(); }
    return name;
  }
  /** Publish complete fsynced inode via exclusive link. A killed writer cannot poison an identity with a partial file. */
  async immutable(path: string, bytes: Uint8Array): Promise<boolean> {
    await this.ensureDir(dirname(path));
    const temp = await this.temp(dirname(path), bytes);
    let published = true;
    try {
      await this.check(dirname(path), "directory");
      try { await link(temp, path); }
      catch (error) {
        if (!errno(error, "EEXIST")) {
          if (["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].some((c) => errno(error, c))) fail("STORE_DURABILITY_UNSUPPORTED", "Exclusive immutable publication unavailable");
          throw error;
        }
        published = false;
        const existing = await this.read(path);
        if (!Buffer.from(existing).equals(Buffer.from(bytes))) fail("STORE_INTEGRITY", "Immutable identity collision");
        await this.syncFile(path);
      }
      await this.syncDir(dirname(path));
      return published;
    } finally { await unlink(temp); await this.syncDir(dirname(path)); }
  }
  async replaceHead(path: string, bytes: Uint8Array, assertOwner: () => Promise<void> = async () => {}): Promise<void> {
    await this.ensureDir(dirname(path));
    if (await this.present(path)) await this.check(path, "file");
    const temp = await this.temp(dirname(path), bytes, true);
    await this.point("before-head-rename");
    await this.check(dirname(path), "directory");
    if (await this.present(path)) await this.check(path, "file");
    await assertOwner(); // Recheck after temp I/O and failpoint barriers, immediately before publication.
    await rename(temp, path); // Never unlink HEAD first.
    await this.point("after-head-rename");
    await this.syncDir(dirname(path));
    await this.point("after-head-directory-fsync");
  }
  async entries(path: string): Promise<string[]> {
    if (!await this.present(path, "directory")) return [];
    return (await readdir(path)).sort();
  }
  async removeEmpty(path: string): Promise<void> { await this.check(path, "directory"); await rmdir(path); await this.syncDir(dirname(path)); }
  wrap<T>(f: () => Promise<T>): Promise<T> { return io(f); }
}
