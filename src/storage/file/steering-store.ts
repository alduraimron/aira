import type { SteeringStore } from "../steering-store";
import type { OperationId } from "../../spec/domain/ids";
import { operationIdSchema } from "../../spec/domain/ids";
import { commitSequenceSchema } from "../../spec/domain/generations";
import { exact, type ContentHash } from "../../spec/domain/primitives";
import { steeringProjectNamespaceSchema, steeringResourceRevisionSchema } from "../../steering/schema";
import type { BlobInput } from "../types";
import {
  steeringCommitSchema,
  steeringRegistryRevisionOf,
  steeringTransactionSchema,
  type SteeringCommit,
  type SteeringHead,
  type SteeringHistoryOptions,
  type SteeringLoadMode,
  type SteeringRevisionPublication,
  type SteeringStoreSnapshot,
  type SteeringTransaction,
  type SteeringTransactionResult,
  type SteeringVerificationReport,
} from "../steering-types";
import {
  checkSteeringEvolution,
  checkSteeringExpectations,
  checkSteeringParent,
  steeringHeadOf,
} from "../steering-transaction";
import { nextSequence } from "../transaction";
import { errno, fail } from "../errors";
import { canonicalBytes, canonicalJSON, hashBytes, hashCanonical } from "./canonical-json";
import { strictRecord } from "./commits";
import { FileBlobStore } from "./blobs";
import { DurableFS, type FileStoreOptions } from "./fsync";
import { SteeringLocks } from "./locks";
import { SteeringCommitFiles } from "./steering-commits";
import { readSteeringRevisions } from "./steering-records";

export class FileSteeringStore implements SteeringStore {
  readonly fs: DurableFS;
  readonly blobs: FileBlobStore;
  readonly locks: SteeringLocks;
  readonly commits: SteeringCommitFiles;

  constructor(projectRoot: string, options: FileStoreOptions = {}) {
    this.fs = new DurableFS(projectRoot, options);
    this.blobs = new FileBlobStore(projectRoot, options);
    this.locks = new SteeringLocks(this.fs);
    this.commits = new SteeringCommitFiles(this.fs);
  }

  async recoverLock(project: SteeringHead["project"]): Promise<boolean> { return this.locks.recover(project); }

  private async snapshot(commit: SteeringCommit, full: boolean): Promise<SteeringStoreSnapshot> {
    const registry = commit.payload.transaction.registry;
    const closure = await readSteeringRevisions(this.blobs, registry, full);
    if (full) for (const event of commit.payload.transaction.events) for (const reference of event.payloads) {
      try {
        const verified = await this.blobs.verify(reference.hash);
        if (verified.bytes !== reference.bytes) fail("STORE_INTEGRITY", "Steering audit payload size mismatch");
      } catch (error) {
        if (errno(error, "STORE_NOT_FOUND")) fail("STORE_INTEGRITY", "Required Steering audit payload is missing");
        throw error;
      }
    }
    return { head: steeringHeadOf(commit), registry, revisions: closure.revisions };
  }

  async loadRegistry(project: SteeringHead["project"], mode: SteeringLoadMode = "full"): Promise<SteeringStoreSnapshot> {
    return this.fs.wrap(async () => {
      if (!steeringProjectNamespaceSchema.safeParse(project).success) fail("STORE_PATH_UNSAFE", "Invalid Steering project identity");
      const current = await this.commits.current(project);
      if (!current) fail("STORE_NOT_FOUND", "Project Steering registry has no authoritative HEAD");
      if (current.commit.payload.parent)
        checkSteeringParent(current.commit, await this.commits.read(project, current.commit.payload.parent));
      if (mode === "deep") await this.verifyChain(current.head);
      return this.snapshot(current.commit, mode !== "current");
    });
  }

  async inspectHead(project: SteeringHead["project"]): Promise<SteeringHead> {
    return (await this.loadRegistry(project, "current")).head;
  }

  private async chain(
    head: SteeringHead,
    limit = Infinity,
    before?: ContentHash,
  ): Promise<SteeringCommit[]> {
    const result: SteeringCommit[] = [], seen = new Set<ContentHash>(), operations = new Set<OperationId>();
    let id: ContentHash | null = head.commit_id, child: SteeringCommit | undefined, include = before === undefined;
    while (id) {
      if (seen.has(id)) fail("STORE_CORRUPT_COMMIT", "Steering commit cycle");
      seen.add(id);
      const commit = await this.commits.read(head.project, id);
      if (!child && !exact(steeringHeadOf(commit), head)) fail("STORE_CORRUPT_HEAD", "Pinned Steering HEAD mismatch");
      if (child) checkSteeringParent(child, commit);
      const operation = commit.payload.transaction.operation;
      if (operations.has(operation)) fail("STORE_OPERATION_REUSE", "Duplicate committed Steering OperationId");
      operations.add(operation);
      if (include) result.push(commit);
      if (id === before) include = true;
      if (result.length >= limit) return result;
      child = commit;
      id = commit.payload.parent;
    }
    if (!include) fail("STORE_NOT_FOUND", "Steering history cursor is not reachable from HEAD");
    return result;
  }

  async history(project: SteeringHead["project"], options: SteeringHistoryOptions = {}): Promise<readonly SteeringCommit[]> {
    return this.fs.wrap(async () => {
      if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1))
        fail("STORE_CONFLICT", "History limit must be a positive safe integer");
      const current = await this.commits.current(project);
      if (!current) fail("STORE_NOT_FOUND", "Project Steering registry has no authoritative HEAD");
      return this.chain(current.head, options.limit, options.before);
    });
  }

  async findCommittedOperation(project: SteeringHead["project"], operation: OperationId): Promise<SteeringCommit | null> {
    return this.fs.wrap(async () => {
      if (!operationIdSchema.safeParse(operation).success) fail("STORE_CONFLICT", "Invalid OperationId");
      const current = await this.commits.current(project);
      if (!current) return null;
      return (await this.chain(current.head)).find((commit) => commit.payload.transaction.operation === operation) ?? null;
    });
  }

  private async verifyChain(head: SteeringHead): Promise<SteeringVerificationReport> {
    const chain = await this.chain(head), revisions = new Set<ContentHash>(), blobs = new Set<ContentHash>();
    for (const commit of [...chain].reverse()) {
      await this.snapshot(commit, true);
      for (const resource of commit.payload.transaction.registry.resources) for (const revision of resource.revisions) {
        revisions.add(revision.record.hash);
        blobs.add(revision.record.hash);
        blobs.add(revision.content.hash);
      }
      for (const event of commit.payload.transaction.events) for (const reference of event.payloads) blobs.add(reference.hash);
    }
    return { head, commits: chain.length, revisions: revisions.size, blobs: blobs.size };
  }

  async verifyHistory(project: SteeringHead["project"]): Promise<SteeringVerificationReport> {
    return this.fs.wrap(async () => {
      const current = await this.commits.current(project);
      if (!current) fail("STORE_NOT_FOUND", "Project Steering registry has no authoritative HEAD");
      return this.verifyChain(current.head);
    });
  }

  async createRegistry(
    transaction: SteeringTransaction,
    revisions: readonly SteeringRevisionPublication[] = [],
    blobs: readonly BlobInput[] = [],
  ): Promise<SteeringTransactionResult> {
    if (transaction.expected !== null) fail("STORE_CONFLICT", "Steering creation requires authoritative absence");
    return this.commit(transaction, revisions, blobs);
  }

  private async result(commit: SteeringCommit, replayed: boolean): Promise<SteeringTransactionResult> {
    const snapshot = await this.snapshot(commit, true), head = snapshot.head;
    return {
      ...snapshot,
      project: head.project,
      commit_id: head.commit_id,
      sequence: head.sequence,
      steering_generation: head.steering_generation,
      operation: commit.payload.transaction.operation,
      replayed,
    };
  }

  private async durable(commit: SteeringCommit): Promise<void> {
    await this.snapshot(commit, true);
    const hashes = new Set<ContentHash>();
    for (const resource of commit.payload.transaction.registry.resources) for (const revision of resource.revisions) {
      hashes.add(revision.record.hash);
      hashes.add(revision.content.hash);
    }
    for (const event of commit.payload.transaction.events) for (const reference of event.payloads) hashes.add(reference.hash);
    for (const hash of hashes) await this.fs.syncFile(this.fs.paths.blob(hash));
  }

  async commit(
    input: SteeringTransaction,
    revisionInputs: readonly SteeringRevisionPublication[] = [],
    blobInputs: readonly BlobInput[] = [],
  ): Promise<SteeringTransactionResult> {
    canonicalBytes(input);
    const transaction = strictRecord(steeringTransactionSchema, input, "aira.dev/steering-store-transaction/v1", "STORE_INTEGRITY");
    const publications = revisionInputs.map((publication) => {
      canonicalBytes(publication.revision);
      if (publication.revision && typeof publication.revision === "object" && "schema" in publication.revision &&
        publication.revision.schema !== "aira.dev/steering-resource/v1")
        fail("STORE_SCHEMA_UNSUPPORTED", `Unsupported Steering resource record: ${String(publication.revision.schema)}`);
      const parsed = steeringResourceRevisionSchema.safeParse(publication.revision);
      if (!parsed.success) fail("STORE_INTEGRITY", `Invalid Steering revision publication: ${parsed.error.message}`);
      const revision = parsed.data;
      if (canonicalJSON(revision) !== canonicalJSON(publication.revision)) fail("STORE_INTEGRITY", "Steering revision decoder changed publication intent");
      if (!(publication.body instanceof Uint8Array)) fail("STORE_INTEGRITY", "Steering body must be exact Uint8Array bytes");
      const body = Uint8Array.from(publication.body);
      if (hashBytes(body) !== revision.content.hash || body.length !== revision.content.bytes)
        fail("STORE_INTEGRITY", "Steering body bytes do not match the declared raw content identity");
      const summary = steeringRegistryRevisionOf(revision);
      if (!transaction.registry.resources.some((resource) => resource.revisions.some((candidate) => exact(candidate, summary))))
        fail("STORE_INTEGRITY", "Published Steering revision is not referenced by the resulting registry");
      return { revision, summary, body, record: canonicalBytes(revision) };
    });
    const publicationKeys = publications.map((publication) => `${publication.revision.identity.id}@${publication.revision.identity.revision}`);
    if (new Set(publicationKeys).size !== publicationKeys.length) fail("STORE_INTEGRITY", "Duplicate Steering revision publication input");

    const blobs = blobInputs.map((blob) => {
      if (!(blob.bytes instanceof Uint8Array)) fail("STORE_INTEGRITY", "Blob input must be exact Uint8Array bytes");
      const bytes = Uint8Array.from(blob.bytes);
      if (hashBytes(bytes) !== blob.hash) fail("STORE_INTEGRITY", "Input blob identity mismatch");
      return { hash: blob.hash, bytes };
    });
    const operationHash = hashCanonical(transaction);

    return this.fs.wrap(async () => {
      const lock = await this.locks.acquire(transaction.project);
      try {
        await this.fs.point("after-lock-acquisition");
        const current = await this.commits.current(transaction.project);
        if (current) {
          const history = await this.chain(current.head);
          const replay = history.find((commit) => commit.payload.transaction.operation === transaction.operation);
          if (replay) {
            if (replay.payload.operation_hash !== operationHash || canonicalJSON(replay.payload.transaction) !== canonicalJSON(transaction))
              fail("STORE_OPERATION_REUSE", "OperationId is already bound to a different canonical Steering intent");
            await this.durable(replay);
            await this.fs.syncFile(this.fs.paths.steeringCommit(replay.id));
            await this.fs.syncFile(this.fs.paths.steeringCommit(current.commit.id));
            await this.fs.syncFile(this.fs.paths.steeringHead());
            return this.result(replay, true);
          }
          if (transaction.expected === null) fail("STORE_ALREADY_EXISTS", "Project Steering registry already exists");
          checkSteeringExpectations(transaction, current.head, current.commit.payload.transaction.registry);
        } else if (transaction.expected !== null) {
          fail("STORE_NOT_FOUND", "Steering mutation requires an authoritative registry");
        }

        checkSteeringEvolution(transaction, current?.commit.payload.transaction.registry ?? null);
        for (const publication of publications) {
          await this.blobs.put(publication.body);
          await this.fs.point("after-steering-body-blob-publication");
          await this.blobs.put(publication.record);
          await this.fs.point("after-steering-revision-record-publication");
        }
        for (const blob of blobs) await this.blobs.put(blob.bytes);
        await readSteeringRevisions(this.blobs, transaction.registry, true);

        const sequence = current ? nextSequence(current.head.sequence) : commitSequenceSchema.parse("1");
        const payload: SteeringCommit["payload"] = {
          schema: "aira.dev/steering-store-commit-payload/v1",
          project: transaction.project,
          sequence,
          parent: current?.commit.id ?? null,
          at: this.fs.now(),
          steering_generation: transaction.registry.generation,
          operation_hash: operationHash,
          transaction,
        };
        const commit = steeringCommitSchema.parse({
          schema: "aira.dev/steering-store-commit/v1",
          id: hashCanonical(payload),
          payload,
        });
        await this.durable(commit);
        await this.fs.point("after-blob-publication");
        await this.commits.publish(commit);
        await this.fs.point("after-commit-publication");
        await this.locks.assertOwner(lock);
        await this.fs.replaceHead(this.fs.paths.steeringHead(), canonicalBytes(steeringHeadOf(commit)),
          () => this.locks.assertOwner(lock));
        return this.result(commit, false);
      } finally {
        try { await this.fs.point("before-lock-release"); }
        finally { await this.locks.release(lock); }
      }
    });
  }
}
