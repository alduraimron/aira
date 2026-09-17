import { mkdir, rename, unlink, rmdir, readFile, readlink, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { SpecId } from "../../spec/domain/ids";
import { steeringProjectNamespaceSchema } from "../../steering/schema";
import { timestampSchema, nonBlankSchema, safeUnsignedSchema } from "../../spec/domain/primitives";
import { errno, fail } from "../errors";
import { canonicalBytes, canonicalJSON, decodeCanonical } from "./canonical-json";
import { DurableFS } from "./fsync";

export const lockMetadataSchema = z.strictObject({
  schema: z.literal("aira.dev/store-lock/v1"), owner: z.string().regex(/^[a-f0-9]{32,64}$/),
  pid: safeUnsignedSchema.refine((n) => n > 0), hostname: nonBlankSchema, acquired_at: timestampSchema,
  process_scope: nonBlankSchema.nullable(),
});
export type LockMetadata = z.infer<typeof lockMetadataSchema>;
export type LockHandle = { readonly spec: SpecId; readonly owner: string };
export type SteeringLockHandle = { readonly project: z.infer<typeof steeringProjectNamespaceSchema>; readonly owner: string };
type LockIdentity = { directory: string; file: string; metadata: string };
type LockScope<I extends string, H extends object & { readonly owner: string }> = {
  readonly label: string;
  readonly path: (identity: I) => string;
  readonly handle: (identity: I, owner: string) => H;
  readonly identity: (handle: H) => I;
};

/** Shared certified mkdir/inode-pinned lock protocol for independent authority scopes. */
export class CrossProcessLocks<I extends string, H extends object & { readonly owner: string }> {
  private readonly held = new WeakMap<H, LockIdentity>();
  constructor(readonly fs: DurableFS, private readonly scope: LockScope<I, H>) {}
  private path(identity: I): string { return this.scope.path(identity); }
  private async lockIdentity(path: string): Promise<LockIdentity> {
    await this.fs.check(path, "directory");
    const directory = await lstat(path, { bigint: true }), file = await lstat(join(path, "owner.json"), { bigint: true });
    const metadata = await this.ownerAt(path);
    if (!metadata) fail("STORE_LOCK_OWNERSHIP", "Lock disappeared");
    const after = await lstat(path, { bigint: true }), owner = await lstat(join(path, "owner.json"), { bigint: true });
    if (directory.dev !== after.dev || directory.ino !== after.ino || file.dev !== owner.dev || file.ino !== owner.ino)
      fail("STORE_LOCK_OWNERSHIP", "Lock substituted during observation");
    return { directory: `${directory.dev}:${directory.ino}`, file: `${file.dev}:${file.ino}`, metadata: canonicalJSON(metadata) };
  }
  private async assertIdentity(path: string, expected: LockIdentity): Promise<void> {
    if (canonicalJSON(await this.lockIdentity(path)) !== canonicalJSON(expected))
      fail("STORE_LOCK_OWNERSHIP", "Lock inode or complete owner metadata changed");
  }
  async owner(identity: I): Promise<LockMetadata | null> { return this.ownerAt(this.path(identity)); }
  private async ownerAt(path: string): Promise<LockMetadata | null> {
    return this.fs.wrap(async () => {
      if (!await this.fs.present(path, "directory")) return null;
      if (!await this.fs.present(join(path, "owner.json"), "file"))
        fail("STORE_LOCKED", "Incomplete ownerless lock; manual inspection required");
      const value = decodeCanonical(await this.fs.read(join(path, "owner.json")), "STORE_LOCKED");
      if (typeof value === "object" && value && "schema" in value && value.schema !== "aira.dev/store-lock/v1")
        fail("STORE_SCHEMA_UNSUPPORTED", "Unknown lock schema");
      const result = lockMetadataSchema.safeParse(value);
      if (!result.success) fail("STORE_LOCKED", "Corrupt lock owner metadata");
      return result.data;
    });
  }
  private async processScope(): Promise<string | null> {
    if (process.platform === "linux") {
      try {
        const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
        const namespace = await readlink("/proc/self/ns/pid");
        if (/^[a-f0-9-]{36}$/.test(boot) && /^pid:\[\d+\]$/.test(namespace)) return `linux:${boot}:${namespace}`;
      } catch { /* No portable proof of a shared process table: recovery stays busy. */ }
    }
    return null;
  }
  private async dead(owner: LockMetadata): Promise<boolean> {
    if (owner.hostname !== hostname() || owner.process_scope === null || owner.process_scope !== await this.processScope()) return false;
    try { process.kill(owner.pid, 0); return false; } catch (error) { return errno(error, "ESRCH"); }
  }
  async assertOwner(handle: H): Promise<void> {
    const identity = this.scope.identity(handle), expected = this.held.get(handle);
    if (!expected || (await this.owner(identity))?.owner !== handle.owner) fail("STORE_LOCK_OWNERSHIP", "Lock ownership changed");
    await this.assertIdentity(this.path(identity), expected);
  }
  /** Explicit stale recovery. Acquisition and every read remain non-repairing. */
  async recover(identity: I): Promise<boolean> {
    return this.fs.wrap(async () => {
      const path = this.path(identity), before = await this.owner(identity);
      if (!before) return false;
      await this.fs.checkFormat();
      await this.fs.mutationSupport(path);
      if (!await this.dead(before)) fail("STORE_LOCKED", "Lock owner is alive or cannot safely be shown dead");
      const initial = await this.lockIdentity(path);
      if (initial.metadata !== canonicalJSON(before)) fail("STORE_LOCK_OWNERSHIP", "Owner changed before recovery");
      const ancestors: { path: string; owner: LockMetadata; identity: LockIdentity }[] = [{ path, owner: before, identity: initial }];
      let parent = path;
      for (let depth = 0; depth < 32; depth++) {
        const marker = join(parent, "recovery");
        try { await mkdir(marker, { mode: 0o700 }); }
        catch (error) {
          if (errno(error, "ENOENT")) fail("STORE_LOCKED", "Concurrent lock recovery");
          if (!errno(error, "EEXIST")) throw error;
          const cleaner = await this.ownerAt(marker);
          if (!cleaner || !await this.dead(cleaner)) fail("STORE_LOCKED", "Cleaner is active or uncertain");
          const nestedIdentity = await this.lockIdentity(marker);
          if (nestedIdentity.metadata !== canonicalJSON(cleaner)) fail("STORE_LOCK_OWNERSHIP", "Cleaner changed");
          ancestors.push({ path: marker, owner: cleaner, identity: nestedIdentity }); parent = marker; continue;
        }
        const created = await lstat(marker, { bigint: true });
        const diagnostic = lockMetadataSchema.parse({ schema: "aira.dev/store-lock/v1", owner: this.fs.token(), pid: process.pid,
          hostname: hostname(), acquired_at: this.fs.now(), process_scope: await this.processScope() });
        await this.fs.immutable(join(marker, "owner.json"), canonicalBytes(diagnostic));
        const cleanerIdentity = await this.lockIdentity(marker);
        if (cleanerIdentity.directory !== `${created.dev}:${created.ino}` || cleanerIdentity.metadata !== canonicalJSON(diagnostic))
          fail("STORE_LOCK_OWNERSHIP", "Cleaner substituted during acquisition");
        for (const ancestor of ancestors) {
          await this.assertIdentity(ancestor.path, ancestor.identity);
          const current = await this.ownerAt(ancestor.path);
          if (!current || current.owner !== ancestor.owner.owner || !await this.dead(current))
            fail("STORE_LOCKED", "Ownership changed during recovery; inspect cleaner marker");
        }
        await this.assertIdentity(marker, cleanerIdentity);
        const tomb = join(dirname(path), `.stale-lock-${this.fs.token()}`);
        if (await this.fs.present(tomb)) fail("STORE_LOCK_OWNERSHIP", "Recovery tombstone collision");
        await rename(path, tomb); await this.fs.syncDir(dirname(path));
        return true;
      }
      fail("STORE_LOCKED", "Too many interrupted cleaners; manual inspection required");
    });
  }
  async acquire(identity: I): Promise<H> {
    return this.fs.wrap(async () => {
      const path = this.path(identity);
      const metadata = lockMetadataSchema.parse({ schema: "aira.dev/store-lock/v1", owner: this.fs.token(), pid: process.pid,
        hostname: hostname(), acquired_at: this.fs.now(), process_scope: await this.processScope() });
      await this.fs.prepare(); await this.fs.ensureDir(dirname(path));
      const deadline = performance.now() + (this.fs.options.lockTimeoutMs ?? 5000);
      for (;;) {
        try { await mkdir(path, { mode: 0o700 }); break; }
        catch (error) {
          if (!errno(error, "EEXIST")) throw error;
          if (!await this.fs.present(path, "directory")) continue;
          if (performance.now() >= deadline) fail("STORE_LOCKED", `${this.scope.label} writer lock is busy`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const created = await lstat(path, { bigint: true });
      await this.fs.immutable(join(path, "owner.json"), canonicalBytes(metadata));
      await this.fs.syncDir(dirname(path));
      const handle = Object.freeze(this.scope.handle(identity, metadata.owner));
      const observed = await this.lockIdentity(path);
      if (observed.directory !== `${created.dev}:${created.ino}` || observed.metadata !== canonicalJSON(metadata))
        fail("STORE_LOCK_OWNERSHIP", "Owner/directory changed during acquisition");
      this.held.set(handle, observed);
      return handle;
    });
  }
  async release(handle: H): Promise<void> {
    return this.fs.wrap(async () => {
      await this.assertOwner(handle);
      const path = this.path(this.scope.identity(handle));
      const entries = await this.fs.entries(path);
      if (entries.length !== 1 || entries[0] !== "owner.json") fail("STORE_LOCKED", "Unexpected lock contents; refusing release");
      const tomb = join(dirname(path), `.released-lock-${this.fs.token()}`);
      await this.assertOwner(handle);
      if (await this.fs.present(tomb)) fail("STORE_LOCK_OWNERSHIP", "Release tombstone collision");
      await rename(path, tomb); await this.fs.syncDir(dirname(path));
      await unlink(join(tomb, "owner.json")); await rmdir(tomb); await this.fs.syncDir(dirname(path));
    });
  }
}

export class SpecLocks extends CrossProcessLocks<SpecId, LockHandle> {
  constructor(fs: DurableFS) {
    super(fs, {
      label: "Spec",
      path: (spec) => fs.paths.lock(spec),
      handle: (spec, owner) => ({ spec, owner }),
      identity: (handle) => handle.spec,
    });
  }
}

export class SteeringLocks extends CrossProcessLocks<z.infer<typeof steeringProjectNamespaceSchema>, SteeringLockHandle> {
  constructor(fs: DurableFS) {
    super(fs, {
      label: "Steering registry",
      path: (project) => {
        if (!steeringProjectNamespaceSchema.safeParse(project).success) fail("STORE_PATH_UNSAFE", "Invalid Steering project identity");
        return fs.paths.steeringLock();
      },
      handle: (project, owner) => ({ project, owner }),
      identity: (handle) => handle.project,
    });
  }
}
