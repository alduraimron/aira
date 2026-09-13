import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { resolve, parse, relative, join } from "node:path";
import { isInspectionPath } from "./paths";
import { LegacyReadError, legacyError, hasCode } from "./errors";

/** Read-only adapter. No mkdir, writes, locks, repairs, workflow or config imports.
 * Pathname checks reduce races but are not openat confinement against a hostile owner.
 */
export class LegacyFiles {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private path(name: string): string {
    if (!isInspectionPath(name)) throw new LegacyReadError("LEGACY_PATH_UNSAFE", "Unsafe relative observation path");
    return join(this.root, ...name.split("/"));
  }
  private async check(path: string): Promise<void> {
    const base = parse(path).root; let cursor = base;
    const parts = relative(base, path).split(/[\\/]/);
    for (const [i, part] of parts.entries()) {
      cursor = join(cursor, part); const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()))
        throw new LegacyReadError("LEGACY_PATH_UNSAFE", "Symlink or non-directory in historical path");
    }
  }
  async kind(name: string): Promise<"missing" | "directory" | "file" | "unsafe" | "other"> {
    try {
      const path = this.path(name); await this.check(path); const st = await lstat(path);
      return st.isDirectory() ? "directory" : st.isFile() ? "file" : "other";
    } catch (error) {
      const e = legacyError(error);
      if (e.code === "LEGACY_NOT_FOUND") return "missing";
      if (e.code === "LEGACY_PATH_UNSAFE") return "unsafe";
      throw e;
    }
  }
  async list(name: string): Promise<readonly string[]> {
    try {
      const path = this.path(name); await this.check(path);
      const before = await lstat(path, { bigint: true });
      if (!before.isDirectory()) throw new LegacyReadError("LEGACY_PATH_UNSAFE", "Not a historical directory");
      const names = (await readdir(path)).sort(); await this.check(path);
      const after = await lstat(path, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino) throw new LegacyReadError("LEGACY_SOURCE_CHANGED", "Directory changed during discovery");
      return names;
    } catch (error) { if (hasCode(error, "ENOENT")) return []; throw legacyError(error); }
  }
  async read(name: string): Promise<Uint8Array> {
    try {
      const path = this.path(name); await this.check(path);
      const before = await lstat(path, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n) throw new LegacyReadError("LEGACY_PATH_UNSAFE", "Not a singly linked regular historical file");
      const h = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const opened = await h.stat({ bigint: true });
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
          throw new LegacyReadError("LEGACY_SOURCE_CHANGED", "Historical file substituted during open");
        const bytes = new Uint8Array(await h.readFile()); await this.check(path);
        const after = await lstat(path, { bigint: true }), final = await h.stat({ bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== final.size ||
          before.mtimeNs !== final.mtimeNs || before.ctimeNs !== final.ctimeNs)
          throw new LegacyReadError("LEGACY_SOURCE_CHANGED", "Historical bytes changed during read");
        return bytes;
      } finally { await h.close(); }
    } catch (error) { throw legacyError(error); }
  }
}
