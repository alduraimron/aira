import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { specIdSchema, type SpecId } from "../../spec/domain/ids";
import { contentHashSchema, type ContentHash } from "../../spec/domain/primitives";
import { fail } from "../errors";

/** Hex UTF-8 is injective, reversible and independent of case-insensitive filesystems. */
export function specKey(id: SpecId): string {
  if (!specIdSchema.safeParse(id).success) fail("STORE_PATH_UNSAFE", "Invalid Spec identity");
  return `s-${Buffer.from(id, "utf8").toString("hex")}`;
}
export function specIdFromKey(key: string): SpecId {
  if (!/^s-(?:[0-9a-f]{2})+$/.test(key)) fail("STORE_PATH_UNSAFE", "Invalid Spec key");
  const id = Buffer.from(key.slice(2), "hex").toString("utf8") as SpecId;
  if (specKey(id) !== key) fail("STORE_PATH_UNSAFE", "Noncanonical Spec key");
  return id;
}
export function digest(hash: ContentHash): string {
  if (!contentHashSchema.safeParse(hash).success) fail("STORE_PATH_UNSAFE", "Invalid integrity identity");
  return hash.slice(7);
}
export class StorePaths {
  readonly project: string;
  readonly root: string;
  constructor(projectRoot: string) { this.project = resolve(projectRoot); this.root = join(this.project, ".aira", "state", "v2"); }
  assertInside(path: string): void {
    const part = relative(this.project, path);
    if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) fail("STORE_PATH_UNSAFE", "Control path escaped project root");
  }
  blob(hash: ContentHash): string { const d = digest(hash); return join(this.root, "blobs", "sha256", d.slice(0, 2), d); }
  spec(id: SpecId): string { return join(this.root, "specs", specKey(id)); }
  head(id: SpecId): string { return join(this.spec(id), "HEAD"); }
  commits(id: SpecId): string { return join(this.spec(id), "commits"); }
  commit(id: SpecId, hash: ContentHash): string { return join(this.commits(id), `${digest(hash)}.json`); }
  locks(): string { return join(this.root, "locks", "specs"); }
  lock(id: SpecId): string { return join(this.locks(), `${specKey(id)}.lock`); }
}
