import type { ContentHash } from "../../spec/domain/primitives";
import { steeringProjectNamespaceSchema } from "../../steering/schema";
import type { SteeringHead } from "../steering-types";
import { steeringCommitSchema, steeringHeadSchema, type SteeringCommit } from "../steering-types";
import { checkSteeringCommitMetadata, steeringHeadOf } from "../steering-transaction";
import { errno, fail } from "../errors";
import { canonicalBytes, canonicalJSON, decodeCanonical, hashCanonical } from "./canonical-json";
import { strictRecord } from "./commits";
import { DurableFS } from "./fsync";

export class SteeringCommitFiles {
  constructor(readonly fs: DurableFS) {}
  private validateProject(project: SteeringHead["project"]): void {
    if (!steeringProjectNamespaceSchema.safeParse(project).success) fail("STORE_PATH_UNSAFE", "Invalid Steering project identity");
  }

  async readHead(project: SteeringHead["project"]): Promise<SteeringHead | null> {
    this.validateProject(project);
    if (await this.fs.present(this.fs.paths.root, "directory")) await this.fs.checkFormat();
    let bytes: Uint8Array;
    try { bytes = await this.fs.read(this.fs.paths.steeringHead()); }
    catch (error) { if (errno(error, "ENOENT")) return null; throw error; }
    const head = strictRecord(steeringHeadSchema, decodeCanonical(bytes, "STORE_CORRUPT_HEAD"),
      "aira.dev/steering-store-head/v1", "STORE_CORRUPT_HEAD");
    if (head.project !== project) fail("STORE_CORRUPT_HEAD", "Steering HEAD project identity mismatch");
    return head;
  }

  async read(project: SteeringHead["project"], id: ContentHash): Promise<SteeringCommit> {
    this.validateProject(project);
    let bytes: Uint8Array;
    try { bytes = await this.fs.read(this.fs.paths.steeringCommit(id)); }
    catch (error) { if (errno(error, "ENOENT")) fail("STORE_CORRUPT_COMMIT", "Referenced Steering commit is missing"); throw error; }
    const commit = strictRecord(steeringCommitSchema, decodeCanonical(bytes, "STORE_CORRUPT_COMMIT"),
      "aira.dev/steering-store-commit/v1", "STORE_CORRUPT_COMMIT");
    if (commit.id !== id || hashCanonical(commit.payload) !== id || commit.payload.project !== project ||
      hashCanonical(commit.payload.transaction) !== commit.payload.operation_hash)
      fail("STORE_INTEGRITY", "Steering commit identity/fingerprint mismatch");
    checkSteeringCommitMetadata(commit);
    return commit;
  }

  async current(project: SteeringHead["project"]): Promise<{ head: SteeringHead; commit: SteeringCommit } | null> {
    const head = await this.readHead(project);
    if (!head) return null;
    const commit = await this.read(project, head.commit_id);
    if (canonicalJSON(steeringHeadOf(commit)) !== canonicalJSON(head))
      fail("STORE_CORRUPT_HEAD", "Steering HEAD and committed registry disagree");
    return { head, commit };
  }

  async publish(commit: SteeringCommit): Promise<void> {
    strictRecord(steeringCommitSchema, commit, "aira.dev/steering-store-commit/v1", "STORE_CORRUPT_COMMIT");
    checkSteeringCommitMetadata(commit);
    if (hashCanonical(commit.payload) !== commit.id) fail("STORE_INTEGRITY", "Invalid Steering commit publication identity");
    await this.fs.immutable(this.fs.paths.steeringCommit(commit.id), canonicalBytes(commit));
  }
}
