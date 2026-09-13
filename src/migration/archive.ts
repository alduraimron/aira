import { z } from "zod";
import type { BlobInput } from "../storage/types";
import { operationIdSchema } from "../spec/domain/ids";
import { archiveCatalogSchema, archiveHeadSchema, archiveRecordSchema, migrationPlanSchema } from "./schema";
import { digestSchema, freeze, identityHash, identityJSON, inspectionTimeSchema, observeBytes, type ReadonlyData } from "../legacy/v1/identity";
import { validateMigrationPlan, MigrationConflict } from "./plan";
import type { ArchiveCatalog, MigrationInspection, MigrationPlan } from "./types";
import { runStateSchema } from "../legacy/v1/schema";
import { artifactReferences } from "../legacy/v1/artifacts";

export const archivePublicationSchema = z.strictObject({
  schema: z.literal("aira.dev/legacy-archive-publication/v1"), operation: operationIdSchema,
  plan: migrationPlanSchema, expected_head: archiveHeadSchema.nullable(), imported_at: inspectionTimeSchema,
  records: z.array(archiveRecordSchema).min(1),
}).refine((t) => t.operation === t.plan.body.operation && identityJSON(t.expected_head) === identityJSON(t.plan.body.expected_archive_head) &&
  new Set(t.records.map((r) => r.id)).size === t.records.length && t.records.every((r) => r.operation === t.operation && r.plan_id === t.plan.id && r.imported_at === t.imported_at &&
    t.plan.body.entries.some((e) => e.source.id === r.source.id && e.actions.some((a) => a.kind === "register-history" && a.archive_id === r.id) &&
      identityJSON(r.warnings) === identityJSON(e.warnings) && identityJSON(r.artifacts.map((a) => ({ path: a.path, hash: a.blob.hash, bytes: a.blob.bytes }))) ===
      identityJSON(e.actions.flatMap((a) => a.kind === "copy-observed-blob" ? [{ path: a.path, hash: a.hash, bytes: a.bytes }] : [])))) &&
    t.records.length === t.plan.body.entries.filter((e) => e.actions.some((a) => a.kind === "register-history")).length, "invalid-archive-publication");
export type ArchivePublication = ReadonlyData<z.infer<typeof archivePublicationSchema>>;
export const archiveReceiptSchema = z.strictObject({
  schema: z.literal("aira.dev/legacy-archive-receipt/v1"), operation: operationIdSchema,
  input_hash: digestSchema, head: archiveHeadSchema, publication: archivePublicationSchema,
}).refine((r) => r.operation === r.publication.operation && identityHash(r.publication) === r.input_hash &&
  BigInt(r.head.sequence) === (r.publication.expected_head ? BigInt(r.publication.expected_head.sequence) + 1n : 1n), "invalid-archive-receipt");
export type ArchiveReceipt = ReadonlyData<z.infer<typeof archiveReceiptSchema>>;
/** Dedicated aggregate port, NOT SpecStore and NOT a file-backed implementation.
 * A provider must validate all source bytes against the plan before publication;
 * snapshot transports before yielding; lock the project archive scope; verify its
 * complete reachable history; check this exact intent's OperationId before CAS;
 * fsync immutable blobs/records/commit then atomically advance ONE archive HEAD.
 * Orphans are not receipts. Retry returns the original receipt, never duplicate rows.
 * Neither commit nor recovery may mutate a v1 path. No multi-Spec atomicity is claimed.
 */
export interface LegacyArchiveStore {
  catalog(): Promise<ArchiveCatalog>;
  findCommittedOperation(operation: z.infer<typeof operationIdSchema>): Promise<ArchiveReceipt | null>;
  commit(publication: ArchivePublication, blobs: readonly BlobInput[]): Promise<{ readonly receipt: ArchiveReceipt; readonly replayed: boolean }>;
}
/** Prepare metadata only. This does not copy bytes or claim that an import happened. */
export function prepareArchivePublication(planInput: MigrationPlan, fresh: MigrationInspection, importedAt: string): ArchivePublication {
  const plan = validateMigrationPlan(planInput, fresh); inspectionTimeSchema.parse(importedAt);
  const records = [];
  for (const entry of plan.body.entries) {
    const action = entry.actions.find((a) => a.kind === "register-history"); if (!action) continue;
    const source = fresh.sources.find((s) => s.source.id === entry.source.id);
    if (!source || source.status !== "valid" || !source.source.observation.run_json) throw new MigrationConflict("MIG_STALE_PLAN", "Valid source bytes no longer observed");
    const bytes = source.source.observation.run_json;
    records.push(archiveRecordSchema.parse({ schema: "aira.dev/legacy-history/v1", id: action.archive_id, source_format: "v1", version: 1,
      original_run_id: source.run.id, source: source.source,
      run_json: { hash: bytes.hash, bytes: bytes.bytes, provenance: "observed-during-import", historical_identity: "not-recorded-in-v1" },
      artifacts: entry.actions.flatMap((a) => a.kind === "copy-observed-blob" ? [{ path: a.path, blob: { hash: a.hash, bytes: a.bytes, provenance: a.provenance, historical_identity: "not-recorded-in-v1" } }] : []),
      original_timestamps: { started_at: source.run.started_at, updated_at: source.run.updated_at }, imported_at: importedAt,
      operation: plan.body.operation, plan_id: plan.id, executable: false, warnings: entry.warnings,
      limitations: ["no-historical-content-proof", "no-exact-approval", "no-spec-lineage", "not-resumable"] }));
  }
  return freeze(archivePublicationSchema.parse({ schema: "aira.dev/legacy-archive-publication/v1", operation: plan.body.operation,
    plan, expected_head: plan.body.expected_archive_head, imported_at: importedAt, records }));
}
/** Pure exact transport validation. Existing immutable blobs may be supplied from a
 * verified BlobStore read. The coordinator must capture these bytes before yielding
 * and must also reobserve sources; digest checking alone does not freeze paths.
 */
export function validateArchiveBlobs(publication: ArchivePublication, inputs: readonly BlobInput[]): void {
  const t = archivePublicationSchema.parse(publication);
  const required = new Map<string, number>();
  for (const record of t.records) for (const blob of [record.run_json, ...record.artifacts.map((a) => a.blob)]) {
    if (required.has(blob.hash) && required.get(blob.hash) !== blob.bytes) throw new MigrationConflict("MIG_PLAN_INVALID", "Conflicting byte sizes");
    required.set(blob.hash, blob.bytes);
  }
  const available = new Map<string, Uint8Array>();
  for (const input of inputs) {
    if (!(input.bytes instanceof Uint8Array) || !required.has(input.hash)) throw new MigrationConflict("MIG_PLAN_INVALID", "Unselected or invalid blob transport");
    const observed = observeBytes(input.bytes);
    if (observed.hash !== input.hash || observed.bytes !== required.get(input.hash)) throw new MigrationConflict("MIG_STALE_PLAN", "Transported bytes differ from reviewed observations");
    available.set(input.hash, input.bytes);
  }
  for (const hash of required.keys()) if (!available.has(hash)) throw new MigrationConflict("MIG_STALE_PLAN", "Required observed bytes are unavailable");
  for (const record of t.records) {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { ignoreBOM: true }).decode(available.get(record.run_json.hash)!)); }
    catch { throw new MigrationConflict("MIG_PLAN_INVALID", "Original run JSON is invalid"); }
    const run = runStateSchema.safeParse(value);
    if (!run.success || run.data.id !== record.original_run_id || run.data.started_at !== record.original_timestamps.started_at || run.data.updated_at !== record.original_timestamps.updated_at)
      throw new MigrationConflict("MIG_PLAN_INVALID", "Archive metadata does not describe original run bytes");
    if (identityJSON(artifactReferences(run.data)) !== identityJSON(record.source.observation.artifacts.map((a) => ({ path: a.path, references: a.references }))))
      throw new MigrationConflict("MIG_PLAN_INVALID", "Archive artifact observations do not describe original references");
  }
}

/** Pure provider acceptance rule. Committed receipt lookup is BEFORE stale CAS,
 * but source re-observation/preflight is still required by an import coordinator.
 * Providers must obtain this catalog/receipt from verified reachable authority.
 */
export function checkArchivePublication(input: ArchivePublication, catalogInput: ArchiveCatalog, committed: ArchiveReceipt | null): "publish" | "replay" {
  const t = archivePublicationSchema.parse(input), catalog = archiveCatalogSchema.parse(catalogInput);
  if (t.plan.body.project !== catalog.project) throw new MigrationConflict("MIG_ARCHIVE_CONFLICT", "Different archive project");
  if (committed) {
    const receipt = archiveReceiptSchema.parse(committed);
    if (receipt.operation !== t.operation || receipt.input_hash !== identityHash(t)) throw new MigrationConflict("MIG_OPERATION_REUSE", "Operation is already bound to different immutable input");
    return "replay";
  }
  if (identityJSON(t.expected_head) !== identityJSON(catalog.head)) throw new MigrationConflict("MIG_ARCHIVE_CONFLICT", "Stale archive CAS");
  if (catalog.head?.sequence === "18446744073709551615") throw new MigrationConflict("MIG_ARCHIVE_CONFLICT", "Archive sequence overflow");
  for (const record of t.records) if (catalog.records.some((r) => r.id === record.id))
    throw new MigrationConflict("MIG_ARCHIVE_CONFLICT", "Source is already mapped; reconcile rather than append a duplicate");
  return "publish";
}
