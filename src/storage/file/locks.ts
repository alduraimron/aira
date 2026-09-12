import { mkdir, rename, unlink, rmdir, readFile, readlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { SpecId } from "../../spec/domain/ids";
import { timestampSchema, nonBlankSchema, safeUnsignedSchema } from "../../spec/domain/primitives";
import { errno, fail } from "../errors";
import { canonicalBytes, decodeCanonical } from "./canonical-json";
import { DurableFS } from "./fsync";

export const lockMetadataSchema = z.strictObject({
  schema: z.literal("aira.dev/store-lock/v1"), owner: z.string().regex(/^[a-f0-9]{32,64}$/),
  pid: safeUnsignedSchema.refine((n) => n > 0), hostname: nonBlankSchema, acquired_at: timestampSchema,
  process_scope: nonBlankSchema.nullable(),
});
export type LockMetadata = z.infer<typeof lockMetadataSchema>;
export type LockHandle = { readonly spec: SpecId; readonly owner: string };
export class SpecLocks {
  constructor(readonly fs: DurableFS) {}
  async owner(spec: SpecId): Promise<LockMetadata | null> { return this.ownerAt(this.fs.paths.lock(spec)); }
  private async ownerAt(path: string): Promise<LockMetadata | null> {
    return this.fs.wrap(async () => {
      if (!await this.fs.present(path, "directory")) return null;
      if (!await this.fs.present(join(path, "owner.json"), "file")) fail("STORE_LOCKED", "Incomplete ownerless lock; manual inspection required");
      const value = decodeCanonical(await this.fs.read(join(path, "owner.json")), "STORE_LOCKED");
      if (typeof value === "object" && value && "schema" in value && value.schema !== "aira.dev/store-lock/v1") fail("STORE_SCHEMA_UNSUPPORTED", "Unknown lock schema");
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
    if (process.platform === "darwin") return "darwin:host-process-table";
    return null;
  }
  private async dead(owner: LockMetadata): Promise<boolean> {
    if (owner.hostname !== hostname() || owner.process_scope === null || owner.process_scope !== await this.processScope()) return false;
    // PID reuse is deliberately false-busy: any live PID, including EPERM, is never stolen.
    try { process.kill(owner.pid, 0); return false; } catch (error) { return errno(error, "ESRCH"); }
  }
  async assertOwner(handle: LockHandle): Promise<void> {
    if ((await this.owner(handle.spec))?.owner !== handle.owner) fail("STORE_LOCK_OWNERSHIP", "Lock ownership changed");
  }
  /** Explicit recovery. Exclusive nested cleaner directories serialize reclamation.
   * A dead, fully identified cleaner can itself be fenced by a nested cleaner. Any
   * live/foreign/ownerless cleaner remains busy. Time/age never authorizes stealing.
   */
  async recover(spec: SpecId): Promise<boolean> {
    return this.fs.wrap(async () => {
      const before = await this.owner(spec);
      if (!before) return false;
      await this.fs.checkFormat();
      if (!await this.dead(before)) fail("STORE_LOCKED", "Lock owner is alive or cannot safely be shown dead");
      const path = this.fs.paths.lock(spec);
      const ancestors: { path: string; owner: LockMetadata }[] = [{ path, owner: before }];
      let parent = path;
      for (let depth = 0; depth < 32; depth++) {
        const marker = join(parent, "recovery");
        try { await mkdir(marker, { mode: 0o700 }); }
        catch (error) {
          if (errno(error, "ENOENT")) fail("STORE_LOCKED", "Concurrent lock recovery");
          if (!errno(error, "EEXIST")) throw error;
          const cleaner = await this.ownerAt(marker);
          if (!cleaner || !await this.dead(cleaner)) fail("STORE_LOCKED", "Cleaner is active or uncertain");
          ancestors.push({ path: marker, owner: cleaner }); parent = marker; continue;
        }
        const diagnostic = lockMetadataSchema.parse({ schema: "aira.dev/store-lock/v1", owner: this.fs.token(), pid: process.pid,
          hostname: hostname(), acquired_at: this.fs.now(), process_scope: await this.processScope() });
        await this.fs.immutable(join(marker, "owner.json"), canonicalBytes(diagnostic));
        for (const ancestor of ancestors) {
          const current = await this.ownerAt(ancestor.path);
          if (!current || current.owner !== ancestor.owner.owner || !await this.dead(current))
            fail("STORE_LOCKED", "Ownership changed during recovery; inspect cleaner marker");
        }
        if ((await this.ownerAt(marker))?.owner !== diagnostic.owner) fail("STORE_LOCK_OWNERSHIP", "Cleaner ownership changed");
        const tomb = join(dirname(path), `.stale-lock-${this.fs.token()}`);
        await rename(path, tomb); await this.fs.syncDir(dirname(path));
        // Retain all dead owner/cleaner diagnostics. This tombstone is not authority.
        return true;
      }
      fail("STORE_LOCKED", "Too many interrupted cleaners; manual inspection required");
    });
  }
  async acquire(spec: SpecId): Promise<LockHandle> {
    return this.fs.wrap(async () => {
      await this.fs.prepare(); await this.fs.ensureDir(this.fs.paths.locks());
      const path = this.fs.paths.lock(spec), deadline = performance.now() + (this.fs.options.lockTimeoutMs ?? 5000);
      for (;;) {
        try { await mkdir(path, { mode: 0o700 }); break; }
        catch (error) {
          if (!errno(error, "EEXIST")) throw error;
          if (!await this.fs.present(path, "directory")) continue; // Owner released between EEXIST and inspection.
          // Mutation acquisition does not implicitly recover: recovery is an explicit API.
          if (performance.now() >= deadline) fail("STORE_LOCKED", "Spec writer lock is busy");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const metadata = lockMetadataSchema.parse({ schema: "aira.dev/store-lock/v1", owner: this.fs.token(), pid: process.pid,
        hostname: hostname(), acquired_at: this.fs.now(), process_scope: await this.processScope() });
      await this.fs.immutable(join(path, "owner.json"), canonicalBytes(metadata));
      await this.fs.syncDir(dirname(path));
      return { spec, owner: metadata.owner };
    });
  }
  async release(handle: LockHandle): Promise<void> {
    return this.fs.wrap(async () => {
      await this.assertOwner(handle);
      const path = this.fs.paths.lock(handle.spec);
      const entries = await this.fs.entries(path);
      if (entries.length !== 1 || entries[0] !== "owner.json") fail("STORE_LOCKED", "Unexpected lock contents; refusing release");
      // Rename ownership away atomically. A release crash cannot leave an ownerless public lock.
      const tomb = join(dirname(path), `.released-lock-${this.fs.token()}`);
      await rename(path, tomb); await this.fs.syncDir(dirname(path));
      await unlink(join(tomb, "owner.json")); await rmdir(tomb); await this.fs.syncDir(dirname(path));
    });
  }
}
