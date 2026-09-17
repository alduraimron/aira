import { join, relative } from "node:path";
import { contentHashSchema, type ContentHash } from "../../spec/domain/primitives";
import { StorageError } from "../errors";
import { FileSpecStore } from "./spec-store";
import { FileSteeringStore } from "./steering-store";
import { FileSteeringSnapshotStore } from "./steering-snapshot-store";
import { specIdFromKey } from "./paths";
import { validateState } from "./records";
import { readRecords } from "./records";
import { lockMetadataSchema } from "./locks";
import { decodeCanonical } from "./canonical-json";
import { strictRecord } from "./commits";
import { steeringCommitSchema, steeringHeadSchema, type SteeringHead } from "../steering-types";
import { steeringSnapshotLocatorSchema } from "../steering-snapshot-types";
import { steeringSnapshotIdSchema } from "../../steering/ids";

export interface InspectionEntry {
  readonly path: string;
  readonly kind: "head" | "commit" | "blob" | "snapshot" | "lock" | "other";
  readonly classification: "reachable" | "orphaned" | "temporary" | "corrupt" | "unknown";
  readonly error?: string;
}
export interface StorageInspection {
  readonly entries: readonly InspectionEntry[];
  readonly complete: boolean;
  readonly note: string;
}
/** Read-only, observational classification, NOT a GC authorization. Never repairs HEAD,
 * promotes an orphan, recovers a lock, or deletes anything. Corrupt/racing roots make
 * unproven reachability unknown rather than falsely declaring safe garbage.
 */
export async function inspectStorage(store: FileSpecStore): Promise<StorageInspection> {
  return store.fs.wrap(async () => {
    const fs = store.fs, root = fs.paths.root, result: InspectionEntry[] = [];
    const reachable = new Set<ContentHash>(), reachableCommits = new Set<string>();
    const snapshotBlobs = new Set<ContentHash>(), corruptSnapshotBlobs = new Set<ContentHash>();
    const specRoot = join(root, "specs"), pinned = new Map<string, string | null>();
    let complete = true;
    const add = (path: string, kind: InspectionEntry["kind"], classification: InspectionEntry["classification"], error?: unknown): void => {
      result.push({ path: relative(root, path), kind, classification, ...(error ? { error: error instanceof StorageError ? error.code : "STORE_IO" } : {}) });
    };
    if (await fs.present(root, "directory")) {
      try { await fs.checkFormat(); add(join(root, "FORMAT"), "other", "reachable"); }
      catch (error) {
        add(join(root, "FORMAT"), "other", error instanceof StorageError && error.code === "STORE_SCHEMA_UNSUPPORTED" ? "unknown" : "corrupt", error);
        return { complete: false, entries: result, note: "Unsupported/corrupt FORMAT: no current layout or record decoding attempted." };
      }
      for (const name of await fs.entries(root)) if (!["FORMAT", "blobs", "specs", "steering", "locks"].includes(name)) {
        const temporary = /^\.publish-tmp-[a-f0-9]+$/.test(name);
        add(join(root, name), "other", temporary ? "temporary" : "unknown");
        if (!temporary) complete = false;
      }
    }
    const initial = await fs.entries(specRoot);
    for (const key of initial) {
      const dir = join(specRoot, key);
      let id;
      try { id = specIdFromKey(key); await fs.check(dir, "directory"); }
      catch (error) { complete = false; add(dir, "other", "unknown", error); continue; }
      try {
        const current = await store.commits.current(id);
        pinned.set(key, current?.head.commit_id ?? null);
        if (current) {
          await store.verifySpecHistory(id);
          for (const commit of await store.history(id)) {
            reachableCommits.add(fs.paths.commit(id, commit.id));
            const state = commit.payload.transaction.state;
            const records = await readRecords(store.blobs, state.records);
            for (const hash of await validateState(store.blobs, state, records, true)) reachable.add(hash);
            for (const event of commit.payload.transaction.events) for (const blob of event.payloads) reachable.add(blob.hash);
          }
          add(fs.paths.head(id), "head", "reachable");
        }
      } catch (error) { complete = false; add(fs.paths.head(id), "head", "corrupt", error); }
      for (const name of await fs.entries(fs.paths.commits(id))) {
        const file = join(fs.paths.commits(id), name);
        if (/^\.publish-tmp-[a-f0-9]+$/.test(name)) { add(file, "commit", "temporary"); continue; }
        if (!/^[a-f0-9]{64}\.json$/.test(name)) { add(file, "commit", "unknown"); continue; }
        try {
          await store.commits.read(id, contentHashSchema.parse(`sha256:${name.slice(0, 64)}`));
          add(file, "commit", reachableCommits.has(file) ? "reachable" : "orphaned");
        } catch (error) { add(file, "commit", "corrupt", error); }
      }
      for (const name of await fs.entries(dir)) if (name !== "HEAD" && name !== "commits")
        add(join(dir, name), "other", /^\.head-tmp-[a-f0-9]+$/.test(name) ? "temporary" : "unknown");
    }

    const steeringRoot = fs.paths.steering();
    let steeringPinned: SteeringHead | null = null, steeringReadable = true;
    const steering = new FileSteeringStore(fs.paths.project, fs.options);
    if (await fs.present(steeringRoot, "directory")) {
      try {
        if (await fs.present(fs.paths.steeringHead(), "file")) {
          const value = decodeCanonical(await fs.read(fs.paths.steeringHead()), "STORE_CORRUPT_HEAD");
          steeringPinned = strictRecord(steeringHeadSchema, value, "aira.dev/steering-store-head/v1", "STORE_CORRUPT_HEAD");
          const current = await steering.commits.current(steeringPinned.project);
          if (!current) throw new StorageError("STORE_CORRUPT_HEAD", "Steering HEAD disappeared");
          await steering.verifyHistory(steeringPinned.project);
          for (const commit of await steering.history(steeringPinned.project)) {
            reachableCommits.add(fs.paths.steeringCommit(commit.id));
            for (const resource of commit.payload.transaction.registry.resources) for (const revision of resource.revisions) {
              reachable.add(revision.record.hash); reachable.add(revision.content.hash);
            }
            for (const event of commit.payload.transaction.events) for (const blob of event.payloads) reachable.add(blob.hash);
          }
          add(fs.paths.steeringHead(), "head", "reachable");
        }
      } catch (error) {
        complete = false; steeringReadable = false;
        add(fs.paths.steeringHead(), "head", "corrupt", error);
      }
      for (const name of await fs.entries(fs.paths.steeringCommits())) {
        const file = join(fs.paths.steeringCommits(), name);
        if (/^\.publish-tmp-[a-f0-9]+$/.test(name)) { add(file, "commit", "temporary"); continue; }
        if (!/^[a-f0-9]{64}\.json$/.test(name)) { add(file, "commit", "unknown"); continue; }
        try {
          const hash = contentHashSchema.parse(`sha256:${name.slice(0, 64)}`);
          let project = steeringPinned?.project;
          if (!project) {
            const value = decodeCanonical(await fs.read(file), "STORE_CORRUPT_COMMIT");
            project = strictRecord(steeringCommitSchema, value, "aira.dev/steering-store-commit/v1", "STORE_CORRUPT_COMMIT").payload.project;
          }
          await steering.commits.read(project, hash);
          add(file, "commit", steeringReadable && reachableCommits.has(file) ? "reachable" : steeringReadable ? "orphaned" : "unknown");
        } catch (error) { add(file, "commit", "corrupt", error); }
      }
      for (const name of await fs.entries(steeringRoot)) if (name !== "HEAD" && name !== "commits" && name !== "snapshot-locators")
        add(join(steeringRoot, name), "other", /^\.head-tmp-[a-f0-9]+$/.test(name) ? "temporary" : "unknown");
    }

    const snapshotRoot = fs.paths.steeringSnapshotLocators();
    const snapshotStore = new FileSteeringSnapshotStore(fs.paths.project, fs.options);
    const snapshotInitial = await fs.entries(snapshotRoot);
    for (const name of snapshotInitial) {
      const file = join(snapshotRoot, name);
      if (/^\.publish-tmp-[a-f0-9]+$/.test(name)) { add(file, "snapshot", "temporary"); continue; }
      if (!/^[a-f0-9]{64}\.json$/.test(name)) { add(file, "snapshot", "unknown"); continue; }
      const id = steeringSnapshotIdSchema.parse(`steering_snapshot_${name.slice(0, 64)}`);
      let recordHash: ContentHash | undefined;
      try {
        const value = decodeCanonical(await fs.read(file), "STORE_INTEGRITY");
        const locator = strictRecord(steeringSnapshotLocatorSchema, value,
          "aira.dev/steering-snapshot-locator/v1", "STORE_INTEGRITY");
        if (locator.snapshot.id !== id) throw new StorageError("STORE_INTEGRITY", "Snapshot locator filename mismatch");
        recordHash = locator.record.hash;
        snapshotBlobs.add(recordHash);
        reachable.add(recordHash);
        await snapshotStore.inspectSnapshot(id);
        add(file, "snapshot", "reachable");
      } catch (error) {
        if (recordHash) corruptSnapshotBlobs.add(recordHash);
        add(file, "snapshot", "corrupt", error);
      }
    }

    const blobRoot = join(root, "blobs", "sha256");
    for (const prefix of await fs.entries(blobRoot)) {
      const dir = join(blobRoot, prefix);
      if (!/^[a-f0-9]{2}$/.test(prefix)) { add(dir, "other", "unknown"); continue; }
      for (const name of await fs.entries(dir)) {
        const file = join(dir, name);
        if (/^\.publish-tmp-[a-f0-9]+$/.test(name)) { add(file, "blob", "temporary"); continue; }
        if (!/^[a-f0-9]{64}$/.test(name) || name.slice(0, 2) !== prefix) { add(file, "blob", "unknown"); continue; }
        const hash = contentHashSchema.parse(`sha256:${name}`);
        try {
          await store.blobs.verify(hash);
          add(file, snapshotBlobs.has(hash) ? "snapshot" : "blob",
            corruptSnapshotBlobs.has(hash) ? "corrupt" : reachable.has(hash) ? "reachable" : "orphaned");
        } catch (error) { add(file, snapshotBlobs.has(hash) ? "snapshot" : "blob", "corrupt", error); }
      }
    }
    for (const lockRoot of [fs.paths.locks(), fs.paths.steeringLocks()]) for (const name of await fs.entries(lockRoot)) {
      const path = join(lockRoot, name);
      if (/^\.(?:stale|released)-lock-[a-f0-9]+$/.test(name)) { add(path, "lock", "temporary"); continue; }
      try {
        const value = decodeCanonical(await fs.read(join(path, "owner.json")), "STORE_LOCKED");
        if (!lockMetadataSchema.safeParse(value).success) throw new StorageError("STORE_LOCKED", "Invalid lock metadata");
        add(path, "lock", "unknown");
      } catch (error) { add(path, "lock", "corrupt", error); }
    }
    if (JSON.stringify(initial) !== JSON.stringify(await fs.entries(specRoot))) complete = false;
    if (JSON.stringify(snapshotInitial) !== JSON.stringify(await fs.entries(snapshotRoot))) complete = false;
    for (const [key, head] of pinned) {
      try { if ((await store.commits.readHead(specIdFromKey(key)))?.commit_id !== (head ?? undefined)) complete = false; }
      catch { complete = false; }
    }
    if (steeringPinned) {
      try { if ((await steering.commits.readHead(steeringPinned.project))?.commit_id !== steeringPinned.commit_id) complete = false; }
      catch { complete = false; }
    }
    return { complete, entries: result.map((entry) => !complete && entry.classification === "orphaned" ? { ...entry, classification: "unknown" } : entry),
      note: "Pinned-HEAD observation only. Concurrent uncommitted publication and future readers preclude deletion without a separate GC policy." };
  });
}
