import { z } from "zod";
import type { SpecId } from "../../spec/domain/ids";
import type { ContentHash } from "../../spec/domain/primitives";
import { commitSchema, headSchema, type StoreCommit, type StoreHead } from "../types";
import { checkCommitMetadata, headOf } from "../transaction";
import { errno, fail, type StorageErrorCode } from "../errors";
import { canonicalBytes, canonicalJSON, decodeCanonical, hashCanonical } from "./canonical-json";
import { DurableFS } from "./fsync";
import { rejectUnknownVersions } from "../records";
export function strictRecord<T>(schema: z.ZodType<T>, value: unknown, name: string, code: StorageErrorCode): T {
  if (value && typeof value === "object" && "schema" in value && value.schema !== name) fail("STORE_SCHEMA_UNSUPPORTED", `Unsupported envelope: ${String(value.schema)}`);
  const result = schema.safeParse(value);
  if (!result.success) {
    rejectUnknownVersions(value);
    fail(code, `Invalid ${name}: ${result.error.message}`);
  }
  if (canonicalJSON(result.data) !== canonicalJSON(value)) fail(code, "Schema decode changed bytes");
  return result.data;
}
export class CommitFiles {
  constructor(readonly fs: DurableFS) {}
  async readHead(spec: SpecId): Promise<StoreHead | null> {
    if (await this.fs.present(this.fs.paths.root, "directory")) await this.fs.checkFormat();
    let bytes;
    try { bytes = await this.fs.read(this.fs.paths.head(spec)); }
    catch (error) { if (errno(error, "ENOENT")) return null; throw error; }
    const head = strictRecord(headSchema, decodeCanonical(bytes, "STORE_CORRUPT_HEAD"), "aira.dev/store-head/v1", "STORE_CORRUPT_HEAD");
    if (head.spec_id !== spec) fail("STORE_CORRUPT_HEAD", "HEAD Spec identity mismatch");
    return head;
  }
  async read(spec: SpecId, id: ContentHash): Promise<StoreCommit> {
    let bytes;
    try { bytes = await this.fs.read(this.fs.paths.commit(spec, id)); }
    catch (error) { if (errno(error, "ENOENT")) fail("STORE_CORRUPT_COMMIT", "Referenced commit is missing"); throw error; }
    const commit = strictRecord(commitSchema, decodeCanonical(bytes, "STORE_CORRUPT_COMMIT"), "aira.dev/store-commit/v1", "STORE_CORRUPT_COMMIT");
    if (commit.id !== id || hashCanonical(commit.payload) !== id || commit.payload.spec_id !== spec ||
      hashCanonical(commit.payload.transaction) !== commit.payload.operation_hash) fail("STORE_INTEGRITY", "Commit identity/fingerprint mismatch");
    checkCommitMetadata(commit);
    return commit;
  }
  async current(spec: SpecId): Promise<{ head: StoreHead; commit: StoreCommit } | null> {
    const head = await this.readHead(spec);
    if (!head) return null;
    const commit = await this.read(spec, head.commit_id);
    if (canonicalJSON(headOf(commit)) !== canonicalJSON(head)) fail("STORE_CORRUPT_HEAD", "HEAD and committed state disagree");
    return { head, commit };
  }
  async publish(commit: StoreCommit): Promise<void> {
    strictRecord(commitSchema, commit, "aira.dev/store-commit/v1", "STORE_CORRUPT_COMMIT");
    checkCommitMetadata(commit);
    if (hashCanonical(commit.payload) !== commit.id) fail("STORE_INTEGRITY", "Invalid commit publication identity");
    await this.fs.immutable(this.fs.paths.commit(commit.payload.spec_id, commit.id), canonicalBytes(commit));
  }
}
