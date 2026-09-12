import { join, relative } from "node:path";
import { contentHashSchema, type ContentHash } from "../../spec/domain/primitives";
import { StorageError } from "../errors";
import { FileSpecStore } from "./spec-store";
import { specIdFromKey } from "./paths";
import { validateState } from "./records";
import { readRecords } from "./records";
import { lockMetadataSchema } from "./locks";
import { decodeCanonical } from "./canonical-json";

export interface InspectionEntry {
  readonly path: string;
  readonly kind: "head" | "commit" | "blob" | "lock" | "other";
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
    const specRoot = join(root, "specs"), initial = await fs.entries(specRoot), pinned = new Map<string, string | null>();
    let complete = true;
    const add = (path: string, kind: InspectionEntry["kind"], classification: InspectionEntry["classification"], error?: unknown): void => {
      result.push({ path: relative(root, path), kind, classification, ...(error ? { error: error instanceof StorageError ? error.code : "STORE_IO" } : {}) });
    };
    if (await fs.present(root, "directory")) {
      try { await fs.checkFormat(); add(join(root, "FORMAT"), "other", "reachable"); }
      catch (error) { complete = false; add(join(root, "FORMAT"), "other", "corrupt", error); }
      for (const name of await fs.entries(root)) if (!["FORMAT", "blobs", "specs", "locks"].includes(name)) {
        const temporary = /^\.publish-tmp-[a-f0-9]+$/.test(name);
        add(join(root, name), "other", temporary ? "temporary" : "unknown");
        if (!temporary) complete = false;
      }
    }
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
    const blobRoot = join(root, "blobs", "sha256");
    for (const prefix of await fs.entries(blobRoot)) {
      const dir = join(blobRoot, prefix);
      if (!/^[a-f0-9]{2}$/.test(prefix)) { add(dir, "other", "unknown"); continue; }
      for (const name of await fs.entries(dir)) {
        const file = join(dir, name);
        if (/^\.publish-tmp-[a-f0-9]+$/.test(name)) { add(file, "blob", "temporary"); continue; }
        if (!/^[a-f0-9]{64}$/.test(name) || name.slice(0, 2) !== prefix) { add(file, "blob", "unknown"); continue; }
        try {
          const hash = contentHashSchema.parse(`sha256:${name}`); await store.blobs.verify(hash);
          add(file, "blob", reachable.has(hash) ? "reachable" : "orphaned");
        } catch (error) { add(file, "blob", "corrupt", error); }
      }
    }
    for (const name of await fs.entries(fs.paths.locks())) {
      const path = join(fs.paths.locks(), name);
      if (/^\.(?:stale|released)-lock-[a-f0-9]+$/.test(name)) { add(path, "lock", "temporary"); continue; }
      try {
        const value = decodeCanonical(await fs.read(join(path, "owner.json")), "STORE_LOCKED");
        if (!lockMetadataSchema.safeParse(value).success) throw new StorageError("STORE_LOCKED", "Invalid lock metadata");
        add(path, "lock", "unknown");
      } catch (error) { add(path, "lock", "corrupt", error); }
    }
    if (JSON.stringify(initial) !== JSON.stringify(await fs.entries(specRoot))) complete = false;
    for (const [key, head] of pinned) {
      try { if ((await store.commits.readHead(specIdFromKey(key)))?.commit_id !== (head ?? undefined)) complete = false; }
      catch { complete = false; }
    }
    return { complete, entries: result.map((entry) => !complete && entry.classification === "orphaned" ? { ...entry, classification: "unknown" } : entry),
      note: "Pinned-HEAD observation only. Concurrent uncommitted publication and future readers preclude deletion without a separate GC policy." };
  });
}
