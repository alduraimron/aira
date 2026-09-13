import type { SpecStore } from "../spec-store";
import type { SpecId, OperationId } from "../../spec/domain/ids";
import { operationIdSchema } from "../../spec/domain/ids";
import { commitSequenceSchema } from "../../spec/domain/generations";
import { exact, type ContentHash } from "../../spec/domain/primitives";
import { transactionSchema, type BlobInput, type HistoryOptions, type LoadMode, type StoreCommit, type StoreHead,
  type StoreSnapshot, type StoreTransaction, type TransactionResult, type VerificationReport } from "../types";
import { checkEvolution, checkExpectations, checkParent, headOf, nextSequence, runCounters } from "../transaction";
import { fail, errno } from "../errors";
import { canonicalBytes, canonicalJSON, hashBytes, hashCanonical } from "./canonical-json";
import { CommitFiles, strictRecord } from "./commits";
import { FileBlobStore } from "./blobs";
import { DurableFS, type FileStoreOptions } from "./fsync";
import { SpecLocks } from "./locks";
import { checkRecordEvolution, readRecords, validateReferenceIdentities, validateState } from "./records";

export class FileSpecStore implements SpecStore {
  readonly fs: DurableFS;
  readonly blobs: FileBlobStore;
  readonly locks: SpecLocks;
  readonly commits: CommitFiles;
  constructor(projectRoot: string, options: FileStoreOptions = {}) {
    this.fs = new DurableFS(projectRoot, options); this.blobs = new FileBlobStore(projectRoot, options);
    this.locks = new SpecLocks(this.fs); this.commits = new CommitFiles(this.fs);
  }
  /** Explicit backend recovery, separate from every read/inspection API. */
  async recoverLock(spec: SpecId): Promise<boolean> { return this.locks.recover(spec); }
  private async snapshot(commit: StoreCommit, full: boolean): Promise<StoreSnapshot> {
    const state = commit.payload.transaction.state;
    const records = await readRecords(this.blobs, state.records);
    await validateState(this.blobs, state, records, full);
    if (full) for (const event of commit.payload.transaction.events) for (const ref of event.payloads) {
      try {
        const verified = await this.blobs.verify(ref.hash);
        if (verified.bytes !== ref.bytes) fail("STORE_INTEGRITY", "Audit payload size mismatch");
      } catch (error) {
        if (errno(error, "STORE_NOT_FOUND")) fail("STORE_INTEGRITY", "Required audit payload is missing");
        throw error;
      }
    }
    return { head: headOf(commit), state, records };
  }
  async loadSpec(spec: SpecId, mode: LoadMode = "full"): Promise<StoreSnapshot> {
    return this.fs.wrap(async () => {
      const current = await this.commits.current(spec);
      if (!current) fail("STORE_NOT_FOUND", "Spec has no authoritative HEAD");
      if (current.commit.payload.parent) checkParent(current.commit, await this.commits.read(spec, current.commit.payload.parent));
      if (mode === "deep") await this.verifyChain(current.head); // Pin the original HEAD, even across concurrent publication.
      return this.snapshot(current.commit, mode !== "current");
    });
  }
  async inspectHead(spec: SpecId): Promise<StoreHead> {
    return (await this.loadSpec(spec, "current")).head;
  }
  /** Traversal always starts from the pinned authoritative HEAD, never a directory scan. */
  private async chain(head: StoreHead, limit = Infinity, before?: ContentHash): Promise<StoreCommit[]> {
    const result: StoreCommit[] = [], seen = new Set<ContentHash>(), operations = new Set<OperationId>();
    let id: ContentHash | null = head.commit_id, child: StoreCommit | undefined, include = before === undefined;
    while (id) {
      if (seen.has(id)) fail("STORE_CORRUPT_COMMIT", "Commit cycle"); seen.add(id);
      const commit = await this.commits.read(head.spec_id, id);
      if (!child && !exact(headOf(commit), head)) fail("STORE_CORRUPT_HEAD", "Pinned HEAD mismatch");
      if (child) checkParent(child, commit);
      const op = commit.payload.transaction.operation;
      if (operations.has(op)) fail("STORE_OPERATION_REUSE", "Duplicate committed OperationId"); operations.add(op);
      if (include) result.push(commit);
      if (id === before) include = true;
      if (result.length >= limit) return result;
      child = commit; id = commit.payload.parent;
    }
    if (!include) fail("STORE_NOT_FOUND", "History cursor is not reachable from HEAD");
    return result;
  }
  async history(spec: SpecId, options: HistoryOptions = {}): Promise<readonly StoreCommit[]> {
    return this.fs.wrap(async () => {
      if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) fail("STORE_CONFLICT", "History limit must be a positive safe integer");
      const current = await this.commits.current(spec);
      if (!current) fail("STORE_NOT_FOUND", "Spec has no authoritative HEAD");
      return this.chain(current.head, options.limit, options.before);
    });
  }
  async findCommittedOperation(spec: SpecId, operation: OperationId): Promise<StoreCommit | null> {
    return this.fs.wrap(async () => {
      if (!operationIdSchema.safeParse(operation).success) fail("STORE_CONFLICT", "Invalid OperationId");
      const current = await this.commits.current(spec);
      if (!current) return null;
      return (await this.chain(current.head)).find((c) => c.payload.transaction.operation === operation) ?? null;
    });
  }
  private async verifyChain(head: StoreHead): Promise<VerificationReport> {
    const chain = await this.chain(head), blobs = new Set<ContentHash>(), records = new Set<ContentHash>();
    validateReferenceIdentities(chain.map((c) => c.payload.transaction.state));
    let previous: StoreSnapshot | undefined;
    for (const commit of [...chain].reverse()) {
      const snapshot = await this.snapshot(commit, true);
      const refs = await validateState(this.blobs, snapshot.state, snapshot.records, true);
      for (const hash of refs) blobs.add(hash);
      for (const event of commit.payload.transaction.events) for (const ref of event.payloads) blobs.add(ref.hash);
      for (const ref of snapshot.state.records) records.add(ref.hash);
      if (previous) checkRecordEvolution(previous.records, snapshot.records, previous.state, snapshot.state);
      previous = snapshot;
    }
    return { head, commits: chain.length, records: records.size, blobs: blobs.size };
  }
  async verifySpecHistory(spec: SpecId): Promise<VerificationReport> {
    return this.fs.wrap(async () => {
      const current = await this.commits.current(spec);
      if (!current) fail("STORE_NOT_FOUND", "Spec has no authoritative HEAD");
      return this.verifyChain(current.head);
    });
  }
  async createSpec(transaction: StoreTransaction, blobs: readonly BlobInput[] = []): Promise<TransactionResult> {
    if (transaction.expected !== null) fail("STORE_CONFLICT", "Creation requires absent-Spec CAS");
    return this.commit(transaction, blobs);
  }
  private async result(commit: StoreCommit, replayed: boolean): Promise<TransactionResult> {
    const snapshot = await this.snapshot(commit, true), h = snapshot.head;
    return { ...snapshot, spec_id: h.spec_id, commit_id: h.commit_id, sequence: h.sequence, spec_generation: h.spec_generation,
      run_generation: h.run_generation, run_generations: h.run_generations, operation: commit.payload.transaction.operation, replayed };
  }
  private async durable(commit: StoreCommit): Promise<void> {
    const snapshot = await this.snapshot(commit, true);
    const hashes = await validateState(this.blobs, snapshot.state, snapshot.records, true);
    for (const event of commit.payload.transaction.events) for (const ref of event.payloads) hashes.add(ref.hash);
    for (const hash of hashes) await this.fs.syncFile(this.fs.paths.blob(hash));
  }
  async commit(input: StoreTransaction, inputs: readonly BlobInput[] = []): Promise<TransactionResult> {
    // Detach the entire intent and bytes before yielding; caller mutation cannot alter the fingerprint/publication.
    canonicalBytes(input);
    const t = strictRecord(transactionSchema, input, "aira.dev/store-transaction/v1", "STORE_INTEGRITY");
    const blobs = inputs.map((b) => {
      if (!(b.bytes instanceof Uint8Array)) fail("STORE_INTEGRITY", "Blob input must be exact Uint8Array bytes");
      return { hash: b.hash, bytes: Uint8Array.from(b.bytes) };
    });
    for (const b of blobs) if (hashBytes(b.bytes) !== b.hash) fail("STORE_INTEGRITY", "Input blob identity mismatch");
    const operationHash = hashCanonical(t);
    return this.fs.wrap(async () => {
      const lock = await this.locks.acquire(t.spec_id);
      try {
        await this.fs.point("after-lock-acquisition");
        const current = await this.commits.current(t.spec_id);
        if (current) {
          const history = await this.chain(current.head);
          const replay = history.find((c) => c.payload.transaction.operation === t.operation);
          if (replay) {
            if (replay.payload.operation_hash !== operationHash || canonicalJSON(replay.payload.transaction) !== canonicalJSON(t))
              fail("STORE_OPERATION_REUSE", "OperationId is already bound to a different canonical intent");
            // Resolve lost acknowledgement after rename: sync the selected authority before acknowledging retry.
            await this.durable(current.commit);
            await this.fs.syncFile(this.fs.paths.commit(t.spec_id, current.commit.id));
            await this.fs.syncFile(this.fs.paths.head(t.spec_id));
            return this.result(replay, true);
          }
          if (t.expected === null) fail("STORE_ALREADY_EXISTS", "Spec already exists");
          checkExpectations(t, current.head, current.commit.payload.transaction.state);
          validateReferenceIdentities([...history.map((c) => c.payload.transaction.state), t.state]);
        } else if (t.expected !== null) fail("STORE_NOT_FOUND", "Mutation requires an authoritative Spec");
        const sequence = current ? nextSequence(current.head.sequence) : commitSequenceSchema.parse("1");
        checkEvolution(t, current?.commit.payload.transaction.state ?? null, sequence);
        for (const blob of blobs) await this.blobs.put(blob.bytes);
        const records = await readRecords(this.blobs, t.state.records);
        await validateState(this.blobs, t.state, records, true);
        if (current) {
          const old = await this.snapshot(current.commit, true);
          checkRecordEvolution(old.records, records, old.state, t.state);
        }
        const runs = runCounters(t.state), runId = t.state.spec.run_binding?.run ?? null;
        const payload: StoreCommit["payload"] = {
          schema: "aira.dev/store-commit-payload/v1", spec_id: t.spec_id, sequence, parent: current?.commit.id ?? null,
          at: this.fs.now(), spec_generation: t.state.spec.generation, run_id: runId,
          run_generation: runs.find((r) => r.run === runId)?.generation ?? "0" as StoreHead["run_generation"],
          run_generations: runs, operation_hash: operationHash, transaction: t,
        };
        const commit: StoreCommit = { schema: "aira.dev/store-commit/v1", id: hashCanonical(payload), payload };
        await this.durable(commit);
        await this.fs.point("after-blob-publication");
        await this.commits.publish(commit);
        await this.fs.point("after-commit-publication");
        await this.locks.assertOwner(lock);
        await this.fs.replaceHead(this.fs.paths.head(t.spec_id), canonicalBytes(headOf(commit)), () => this.locks.assertOwner(lock));
        return this.result(commit, false);
      } finally {
        try { await this.fs.point("before-lock-release"); } finally { await this.locks.release(lock); }
      }
    });
  }
}
