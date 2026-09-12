import type { ContentHash } from "../spec/domain/primitives";
/** Exact uncompressed bytes. A future streaming interface must keep these identity semantics. */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<ContentHash>;
  get(hash: ContentHash): Promise<Uint8Array>;
  exists(hash: ContentHash): Promise<boolean>;
  verify(hash: ContentHash): Promise<{ readonly hash: ContentHash; readonly bytes: number }>;
}
