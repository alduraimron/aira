import type { SteeringSnapshotStore } from "../steering-snapshot-store";
import {
  steeringSnapshotLocatorOf,
  steeringSnapshotLocatorSchema,
  steeringSnapshotPublicationMetadataSchema,
  steeringSnapshotRecordOf,
  steeringSnapshotRecordReferenceOf,
  steeringSnapshotRecordSchema,
  type SteeringSnapshotLocator,
  type SteeringSnapshotPublicationMetadata,
  type SteeringSnapshotPutResult,
  type SteeringSnapshotRecord,
  type SteeringSnapshotVerificationReport,
} from "../steering-snapshot-types";
import {
  STEERING_SNAPSHOT_SCHEMA,
  steeringSnapshotSchema,
  validateSteeringSnapshot,
  type SteeringSnapshot,
} from "../../steering/snapshot";
import { freezeResolution } from "../../steering/resolution-contract";
import type { SteeringSnapshotId } from "../../steering/ids";
import { steeringResourceRevisionSchema, type SteeringResourceRevisionValue } from "../../steering/schema";
import { exact, type ContentHash } from "../../spec/domain/primitives";
import { errno, fail } from "../errors";
import { canonicalBytes, canonicalJSON, decodeCanonical } from "./canonical-json";
import { strictRecord } from "./commits";
import { DurableFS, type FileStoreOptions } from "./fsync";
import { FileBlobStore } from "./blobs";
import { FileSteeringStore } from "./steering-store";
import { readSteeringRevisions } from "./steering-records";
import { steeringHeadOf } from "../steering-transaction";

interface LoadedSnapshot {
  readonly locator: SteeringSnapshotLocator;
  readonly record: SteeringSnapshotRecord;
  readonly revisions: readonly SteeringResourceRevisionValue[];
}

function exactSnapshot(value: unknown): SteeringSnapshot {
  canonicalBytes(value);
  if (value && typeof value === "object" && "schema" in value && value.schema !== STEERING_SNAPSHOT_SCHEMA)
    fail("STORE_SCHEMA_UNSUPPORTED", `Unsupported Steering snapshot: ${String(value.schema)}`);
  const parsed = strictRecord(steeringSnapshotSchema, value, STEERING_SNAPSHOT_SCHEMA, "STORE_INTEGRITY");
  const issues = validateSteeringSnapshot(parsed);
  if (issues.length) fail("STORE_INTEGRITY", `Invalid Steering snapshot: ${JSON.stringify(issues)}`);
  return parsed as SteeringSnapshot;
}

function snapshotRevisions(snapshot: SteeringSnapshot): SteeringResourceRevisionValue[] {
  return snapshot.semantic.resources.map((entry, index) => {
    const audit = snapshot.audit.resource_creation[index];
    if (!audit || !exact(audit.resource, entry.revision.identity))
      fail("STORE_INTEGRITY", "Steering snapshot resource creation attribution is inconsistent");
    const parsed = steeringResourceRevisionSchema.safeParse({ ...entry.revision, created: audit.created });
    if (!parsed.success) fail("STORE_INTEGRITY", `Invalid Steering snapshot resource revision: ${parsed.error.message}`);
    return parsed.data;
  });
}

function exactRecord(value: unknown): { record: SteeringSnapshotRecord; revisions: SteeringResourceRevisionValue[] } {
  const record = strictRecord(steeringSnapshotRecordSchema, value,
    "aira.dev/steering-snapshot-record/v1", "STORE_INTEGRITY") as SteeringSnapshotRecord;
  const snapshot = exactSnapshot(record.snapshot);
  if (canonicalJSON(snapshot) !== canonicalJSON(record.snapshot))
    fail("STORE_INTEGRITY", "Steering snapshot record changed during domain decoding");
  return { record, revisions: snapshotRevisions(snapshot) };
}

export class FileSteeringSnapshotStore implements SteeringSnapshotStore {
  readonly fs: DurableFS;
  readonly blobs: FileBlobStore;
  readonly registry: FileSteeringStore;

  constructor(projectRoot: string, options: FileStoreOptions = {}) {
    this.fs = new DurableFS(projectRoot, options);
    this.blobs = new FileBlobStore(projectRoot, options);
    this.registry = new FileSteeringStore(projectRoot, options);
  }

  private async read(snapshotId: SteeringSnapshotId): Promise<LoadedSnapshot> {
    const path = this.fs.paths.steeringSnapshotLocator(snapshotId);
    if (await this.fs.present(this.fs.paths.root, "directory")) await this.fs.checkFormat();
    let locatorBytes: Uint8Array;
    try { locatorBytes = await this.fs.read(path); }
    catch (error) {
      if (errno(error, "ENOENT")) fail("STORE_NOT_FOUND", `Steering snapshot not found: ${snapshotId}`);
      throw error;
    }
    const locator = strictRecord(steeringSnapshotLocatorSchema,
      decodeCanonical(locatorBytes, "STORE_INTEGRITY"),
      "aira.dev/steering-snapshot-locator/v1", "STORE_INTEGRITY") as SteeringSnapshotLocator;
    if (locator.snapshot.id !== snapshotId || locator.snapshot.hash !== `sha256:${snapshotId.slice("steering_snapshot_".length)}`)
      fail("STORE_INTEGRITY", "Steering snapshot locator does not match its deterministic identity");

    let recordBytes: Uint8Array;
    try { recordBytes = await this.blobs.get(locator.record.hash); }
    catch (error) {
      if (errno(error, "STORE_NOT_FOUND")) fail("STORE_INTEGRITY", "Referenced Steering snapshot record is missing");
      throw error;
    }
    if (recordBytes.length !== locator.record.bytes)
      fail("STORE_INTEGRITY", "Steering snapshot record byte size mismatch");
    const decoded = exactRecord(decodeCanonical(recordBytes, "STORE_INTEGRITY"));
    const expectedLocator = steeringSnapshotLocatorOf(decoded.record,
      steeringSnapshotRecordReferenceOf(decoded.record));
    if (!exact(locator, expectedLocator))
      fail("STORE_INTEGRITY", "Steering snapshot locator does not match its immutable record");
    return { locator, record: decoded.record, revisions: decoded.revisions };
  }

  private async verifySource(loaded: LoadedSnapshot): Promise<{ blobs: Set<ContentHash> }> {
    const { record, revisions } = loaded;
    let history;
    try {
      await this.registry.verifyHistory(record.source.head.project);
      history = await this.registry.history(record.source.head.project);
    }
    catch (error) {
      if (errno(error, "STORE_NOT_FOUND")) fail("STORE_INTEGRITY", "Steering snapshot source registry is unavailable");
      throw error;
    }
    const commit = history.find((candidate) => candidate.id === record.source.head.commit_id);
    if (!commit || !exact(steeringHeadOf(commit), record.source.head))
      fail("STORE_INTEGRITY", "Steering snapshot source commit is not reachable with the claimed authority metadata");

    const closure = await readSteeringRevisions(this.blobs, commit.payload.transaction.registry, true);
    for (const revision of revisions) {
      const authority = commit.payload.transaction.registry.resources.find((resource) => resource.id === revision.identity.id);
      if (!authority || authority.status !== "active" || !exact(authority.current, revision.identity))
        fail("STORE_INTEGRITY", "Steering snapshot revision was not current in its claimed registry observation");
      const source = closure.revisions.find((candidate) => exact(candidate.identity, revision.identity));
      if (!source || !exact(source, revision))
        fail("STORE_INTEGRITY", "Steering snapshot resource does not match its claimed authoritative revision record");
    }
    return { blobs: closure.blobs };
  }

  async putSnapshot(
    snapshotInput: SteeringSnapshot,
    metadataInput: SteeringSnapshotPublicationMetadata,
  ): Promise<SteeringSnapshotPutResult> {
    const snapshot = exactSnapshot(snapshotInput);
    canonicalBytes(metadataInput);
    const metadataResult = steeringSnapshotPublicationMetadataSchema.safeParse(metadataInput);
    if (!metadataResult.success)
      fail("STORE_INTEGRITY", `Invalid Steering snapshot publication metadata: ${metadataResult.error.message}`);
    if (canonicalJSON(metadataResult.data) !== canonicalJSON(metadataInput))
      fail("STORE_INTEGRITY", "Steering snapshot publication metadata changed during decoding");
    let record: SteeringSnapshotRecord;
    try { record = steeringSnapshotRecordOf(snapshot, metadataResult.data); }
    catch (error) {
      fail("STORE_INTEGRITY", `Invalid Steering snapshot record: ${error instanceof Error ? error.message : "record validation failed"}`);
    }
    const revisions = snapshotRevisions(snapshot);
    const reference = steeringSnapshotRecordReferenceOf(record);
    const locator = steeringSnapshotLocatorOf(record, reference);
    const loaded = { locator, record, revisions };

    await this.verifySource(loaded);
    await this.fs.point("after-snapshot-source-verification");

    return this.fs.wrap(async () => {
      const path = this.fs.paths.steeringSnapshotLocator(snapshot.id);
      if (await this.fs.present(path, "file")) {
        const existing = await this.read(snapshot.id);
        if (!exact(existing.record, record) || !exact(existing.locator, locator))
          fail("STORE_INTEGRITY", "SteeringSnapshotId is already bound to a different immutable record");
        return {
          snapshot: freezeResolution(existing.record.snapshot) as SteeringSnapshot,
          record: freezeResolution(existing.record) as SteeringSnapshotRecord,
          locator: freezeResolution(existing.locator) as SteeringSnapshotLocator,
          reused: true,
        };
      }

      const recordHash = await this.blobs.put(canonicalBytes(record));
      if (recordHash !== reference.hash) fail("STORE_INTEGRITY", "Steering snapshot record content identity mismatch");
      await this.fs.point("after-snapshot-record-publication");
      const published = await this.fs.immutable(path, canonicalBytes(locator));
      await this.fs.point("after-snapshot-locator-publication");
      const persisted = await this.read(snapshot.id);
      if (!exact(persisted.record, record) || !exact(persisted.locator, locator))
        fail("STORE_INTEGRITY", "Published Steering snapshot record changed during immutable publication");
      return {
        snapshot: freezeResolution(persisted.record.snapshot) as SteeringSnapshot,
        record: freezeResolution(persisted.record) as SteeringSnapshotRecord,
        locator: freezeResolution(persisted.locator) as SteeringSnapshotLocator,
        reused: !published,
      };
    });
  }

  async getSnapshot(snapshotId: SteeringSnapshotId): Promise<SteeringSnapshot> {
    return this.fs.wrap(async () => freezeResolution((await this.read(snapshotId)).record.snapshot) as SteeringSnapshot);
  }

  async hasSnapshot(snapshotId: SteeringSnapshotId): Promise<boolean> {
    try { await this.inspectSnapshot(snapshotId); return true; }
    catch (error) { if (errno(error, "STORE_NOT_FOUND")) return false; throw error; }
  }

  async inspectSnapshot(snapshotId: SteeringSnapshotId): Promise<SteeringSnapshotRecord> {
    return this.fs.wrap(async () => freezeResolution((await this.read(snapshotId)).record) as SteeringSnapshotRecord);
  }

  async verifySnapshot(snapshotId: SteeringSnapshotId): Promise<SteeringSnapshotVerificationReport> {
    return this.fs.wrap(async () => {
      const loaded = await this.read(snapshotId);
      const source = await this.verifySource(loaded);
      return {
        snapshot_id: loaded.record.snapshot_id,
        semantic_hash: loaded.record.semantic_hash,
        record_hash: loaded.locator.record.hash,
        source_head: loaded.record.source.head,
        resources: loaded.revisions.length,
        blobs: source.blobs.size + 1,
      };
    });
  }
}
