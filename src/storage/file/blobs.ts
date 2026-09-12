import type { BlobStore } from "../blob-store";
import type { ContentHash } from "../../spec/domain/primitives";
import { errno, fail } from "../errors";
import { hashBytes } from "./canonical-json";
import { DurableFS, type FileStoreOptions } from "./fsync";

export class FileBlobStore implements BlobStore {
  readonly fs: DurableFS;
  constructor(projectRoot: string, options: FileStoreOptions = {}) { this.fs = new DurableFS(projectRoot, options); }
  async put(input: Uint8Array): Promise<ContentHash> {
    if (!(input instanceof Uint8Array)) fail("STORE_INTEGRITY", "Blob input must be exact Uint8Array bytes");
    const bytes = Uint8Array.from(input); // Snapshot caller-owned memory before the first await.
    return this.fs.wrap(async () => {
      const hash = hashBytes(bytes); await this.fs.prepare();
      await this.fs.immutable(this.fs.paths.blob(hash), bytes);
      return hash;
    });
  }
  async get(hash: ContentHash): Promise<Uint8Array> {
    return this.fs.wrap(async () => {
      const path = this.fs.paths.blob(hash);
      if (await this.fs.present(this.fs.paths.root, "directory")) await this.fs.checkFormat();
      let bytes: Uint8Array;
      try { bytes = await this.fs.read(path); }
      catch (error) { if (errno(error, "ENOENT")) fail("STORE_NOT_FOUND", `Blob not found: ${hash}`); throw error; }
      if (hashBytes(bytes) !== hash) fail("STORE_CORRUPT_BLOB", `Blob digest mismatch: ${hash}`);
      return bytes;
    });
  }
  async exists(hash: ContentHash): Promise<boolean> {
    try { await this.get(hash); return true; }
    catch (error) { if (errno(error, "STORE_NOT_FOUND")) return false; throw error; }
  }
  async verify(hash: ContentHash): Promise<{ hash: ContentHash; bytes: number }> {
    return { hash, bytes: (await this.get(hash)).length };
  }
}
