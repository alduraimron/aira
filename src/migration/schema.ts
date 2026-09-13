import { z } from "zod";
import { runStateSchema } from "../legacy/v1/schema";
import { sourceIdentitySchema } from "../legacy/v1/observations";
import { digestSchema, inspectionTimeSchema, identityHash, locatorSchema, projectIdentitySchema } from "../legacy/v1/identity";
import { legacyErrorCodes } from "../legacy/v1/errors";
import { operationIdSchema } from "../spec/domain/ids";
import { positiveSequenceSchema } from "../storage/types";

export const legacyInspectionSchema = z.intersection(z.strictObject({
  inspected_at: inspectionTimeSchema, source: sourceIdentitySchema,
  status: z.enum(["valid", "invalid"]), run: runStateSchema.optional(), code: z.enum(legacyErrorCodes).optional(), detail: z.string().optional(),
}), z.discriminatedUnion("status", [
  z.object({ status: z.literal("valid"), run: runStateSchema }),
  z.object({ status: z.literal("invalid"), code: z.enum(legacyErrorCodes), detail: z.string() }),
])).refine((i) => i.status === "valid" ? i.code === undefined && i.detail === undefined && i.run.id === i.source.observation.original_run_id && i.run.id === i.source.observation.locator.run_directory_id && i.source.observation.run_json !== null : i.run === undefined);
export const findingCodes = ["MIG_VALID_LEGACY", "MIG_CORRUPT_LEGACY", "MIG_UNSUPPORTED_LEGACY", "MIG_ARTIFACT_PRESENT", "MIG_ARTIFACT_MISSING",
  "MIG_ARTIFACT_UNSAFE", "MIG_ARTIFACT_UNREADABLE", "MIG_HISTORICAL_BYTES_UNKNOWN", "MIG_REVISION_RESOLVED", "MIG_REVISION_PENDING",
  "MIG_APPROVAL_UNATTRIBUTABLE", "MIG_INTERRUPTED_RUN", "MIG_CONTINUATION_UNSUPPORTED", "MIG_DIAGNOSTIC_IMPORTABLE",
  "MIG_SOURCE_CONFLICT", "MIG_ALREADY_IMPORTED", "MIG_V2_EXISTS", "MIG_V2_UNAVAILABLE", "MIG_LAYOUT_WARNING"] as const;
export const findingSchema = z.strictObject({ code: z.enum(findingCodes), detail: z.string(), subject: z.string().nullable() });
export const warningSchema = z.strictObject({ code: z.string().min(1), detail: z.string() });
export const archiveIdSchema = z.string().regex(/^legacy_[a-f0-9]{64}$/);
export const archiveHeadSchema = z.strictObject({ commit_id: digestSchema, sequence: positiveSequenceSchema });
const archivedBytes = z.strictObject({ hash: digestSchema, bytes: z.number().int().nonnegative(), provenance: z.literal("observed-during-import"), historical_identity: z.literal("not-recorded-in-v1") });
export const archiveRecordSchema = z.strictObject({
  schema: z.literal("aira.dev/legacy-history/v1"), id: archiveIdSchema, source_format: z.literal("v1"), version: z.literal(1),
  original_run_id: z.string(), source: sourceIdentitySchema,
  run_json: archivedBytes, artifacts: z.array(z.strictObject({ path: z.string(), blob: archivedBytes })),
  original_timestamps: z.strictObject({ started_at: inspectionTimeSchema, updated_at: inspectionTimeSchema }),
  imported_at: inspectionTimeSchema, operation: operationIdSchema, plan_id: digestSchema,
  executable: z.literal(false), warnings: z.array(warningSchema),
  limitations: z.tuple([z.literal("no-historical-content-proof"), z.literal("no-exact-approval"), z.literal("no-spec-lineage"), z.literal("not-resumable")]),
}).refine((r) => r.id === `legacy_${identityHash(r.source.observation.locator).slice(7)}` && r.original_run_id === r.source.observation.original_run_id && r.original_run_id === r.source.observation.locator.run_directory_id &&
  r.run_json.hash === r.source.observation.run_json?.hash && r.run_json.bytes === r.source.observation.run_json?.bytes &&
  new Set(r.artifacts.map((a) => a.path)).size === r.artifacts.length && r.artifacts.every((a) => {
    const observed = r.source.observation.artifacts.find((x) => x.path === a.path)?.observation;
    return observed?.status === "present" && observed.bytes.hash === a.blob.hash && observed.bytes.bytes === a.blob.bytes;
  }), "archive-source-binding-mismatch");
export const archiveCatalogSchema = z.strictObject({
  schema: z.literal("aira.dev/legacy-archive-catalog/v1"), project: projectIdentitySchema,
  head: archiveHeadSchema.nullable(), records: z.array(archiveRecordSchema),
}).refine((c) => (c.head !== null || c.records.length === 0) && new Set(c.records.map((r) => r.id)).size === c.records.length &&
  c.records.every((r) => r.source.observation.locator.project === c.project), "invalid-archive-catalog");
export const migrationPolicySchema = z.strictObject({
  schema: z.literal("aira.dev/migration-policy/v1"), history: z.enum(["preserve", "archive-metadata", "archive-surviving"]),
  invalid: z.enum(["skip", "manual"]), unavailable_artifacts: z.enum(["metadata-only", "manual"]),
});
export const migrationActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("preserve-source") }),
  z.strictObject({ kind: z.literal("register-history"), archive_id: archiveIdSchema, run_json: digestSchema }),
  z.strictObject({ kind: z.literal("copy-observed-blob"), path: z.string(), hash: digestSchema, bytes: z.number().int().nonnegative(), provenance: z.literal("observed-during-import") }),
  z.strictObject({ kind: z.literal("skip"), code: z.enum(["MIG_CORRUPT_LEGACY", "MIG_UNSUPPORTED_LEGACY"]) }),
  z.strictObject({ kind: z.literal("already-imported"), archive_id: archiveIdSchema }),
  z.strictObject({ kind: z.literal("manual"), code: z.enum(["MIG_SOURCE_CONFLICT", "MIG_CORRUPT_LEGACY", "MIG_UNSUPPORTED_LEGACY", "MIG_ARTIFACT_UNREADABLE", "MIG_V2_UNAVAILABLE"]) }),
]);
export const planEntrySchema = z.strictObject({
  source: sourceIdentitySchema, validity: z.enum(["valid", "invalid"]),
  actions: z.array(migrationActionSchema).min(1), warnings: z.array(warningSchema),
}).refine((e) => e.actions[0]?.kind === "preserve-source" && e.actions.filter((a) => a.kind === "preserve-source").length === 1 &&
  e.actions.filter((a) => a.kind === "register-history").length <= 1 &&
  (e.validity === "valid" || e.actions.every((a) => ["preserve-source", "skip", "manual"].includes(a.kind))) &&
  (!e.actions.some((a) => ["skip", "manual", "already-imported"].includes(a.kind)) || e.actions.length === 2) &&
  e.actions.every((a) => {
    if (a.kind === "already-imported") return a.archive_id === `legacy_${identityHash(e.source.observation.locator).slice(7)}`;
    if (a.kind === "register-history") return a.archive_id === `legacy_${identityHash(e.source.observation.locator).slice(7)}` && a.run_json === e.source.observation.run_json?.hash;
    if (a.kind !== "copy-observed-blob") return true;
    const observed = e.source.observation.artifacts.find((x) => x.path === a.path)?.observation;
    return e.actions.some((a) => a.kind === "register-history") && observed?.status === "present" && a.hash === observed.bytes.hash && a.bytes === observed.bytes.bytes;
  }) && new Set(e.actions.filter((a) => a.kind === "copy-observed-blob").map((a) => a.path)).size === e.actions.filter((a) => a.kind === "copy-observed-blob").length,
"invalid-source-actions");
export const migrationPlanBodySchema = z.strictObject({
  schema: z.literal("aira.dev/migration-plan/v1"), project: projectIdentitySchema, operation: operationIdSchema,
  policy: migrationPolicySchema, expected_archive_head: archiveHeadSchema.nullable(), entries: z.array(planEntrySchema),
}).refine((p) => new Set(p.entries.map((e) => identityHash(e.source.observation.locator))).size === p.entries.length &&
  p.entries.every((e) => e.source.observation.locator.project === p.project), "duplicate-or-cross-project-source");
export const migrationPlanSchema = z.strictObject({ id: digestSchema, body: migrationPlanBodySchema })
  .refine((p) => identityHash(p.body) === p.id, "migration-plan-identity-mismatch");
export const reportStatuses = ["imported", "preserved-in-place", "skipped", "unsupported", "corrupt", "stale-plan-rejected", "already-imported", "failed", "manual-action-required"] as const;
export const reportEntrySchema = z.strictObject({ source_id: digestSchema, status: z.enum(reportStatuses), code: z.string().regex(/^MIG_[A-Z_]+$/), detail: z.string() });
export const migrationReportSchema = z.strictObject({
  schema: z.literal("aira.dev/migration-report/v1"), plan_id: digestSchema, operation: operationIdSchema,
  phase: z.enum(["plan", "preflight", "execution", "restart"]), fully_successful: z.boolean(), entries: z.array(reportEntrySchema),
}).refine((r) => new Set(r.entries.map((e) => e.source_id)).size === r.entries.length &&
  (!r.fully_successful || ["execution", "restart"].includes(r.phase) && r.entries.every((e) => ["imported", "preserved-in-place", "already-imported"].includes(e.status))), "partial-work-is-not-success");
export { locatorSchema };
