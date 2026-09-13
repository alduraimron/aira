import { freeze, identityHash } from "../legacy/v1/identity";
import { migrationPlanSchema, migrationReportSchema, archiveCatalogSchema } from "./schema";
import { validateMigrationPlan, MigrationConflict } from "./plan";
import type { MigrationInspection, MigrationPlan, MigrationReport, ArchiveCatalog } from "./types";
import type { ArchiveReceipt } from "./archive";
import { archiveReceiptSchema } from "./archive";

type Entry = MigrationReport["entries"][number];
function pendingEntries(plan: MigrationPlan): Entry[] {
  return plan.body.entries.map((entry) => {
    const action = entry.actions.find((a) => a.kind !== "preserve-source");
    let status: Entry["status"] = "preserved-in-place", code = "MIG_PRESERVATION_PLANNED", detail = "Leave original v1 source in place; no conversion or deletion.";
    if (action?.kind === "register-history") { status = "manual-action-required"; code = "MIG_IMPORT_ADAPTER_UNAVAILABLE"; detail = "Archive actions are planned, not executed. A certified dedicated archive adapter is required."; }
    else if (action?.kind === "skip") { status = action.code === "MIG_UNSUPPORTED_LEGACY" ? "unsupported" : "corrupt"; code = action.code; detail = "Skip this source without changing it."; }
    else if (action?.kind === "manual") { status = "manual-action-required"; code = action.code; detail = "Inspection or an explicit new plan is required; nothing may be silently repaired."; }
    else if (action?.kind === "already-imported") { status = "already-imported"; code = "MIG_ALREADY_IMPORTED"; detail = "Exact source is already mapped in verified archive authority."; }
    return { source_id: entry.source.id, status, code, detail };
  });
}
export function validateMigrationReport(planInput: MigrationPlan, reportInput: MigrationReport): MigrationReport {
  const plan = migrationPlanSchema.parse(planInput), report = migrationReportSchema.parse(reportInput);
  if (report.plan_id !== plan.id || report.operation !== plan.body.operation || report.entries.length !== plan.body.entries.length ||
    report.entries.some((r) => !plan.body.entries.some((e) => e.source.id === r.source_id)))
    throw new MigrationConflict("MIG_PLAN_INVALID", "Report must cover every planned source exactly once");
  return freeze(report);
}
export function reportMigrationPlan(planInput: MigrationPlan): MigrationReport {
  const plan = migrationPlanSchema.parse(planInput);
  return freeze(migrationReportSchema.parse({ schema: "aira.dev/migration-report/v1", plan_id: plan.id, operation: plan.body.operation,
    phase: "plan", fully_successful: false, entries: pendingEntries(plan) }));
}
/** Re-observation is done by the read adapter/caller, never implicitly by pure code. */
export function preflightMigration(planInput: MigrationPlan, fresh: MigrationInspection): MigrationReport {
  const plan = migrationPlanSchema.parse(planInput);
  try { validateMigrationPlan(plan, fresh); return freeze({ ...reportMigrationPlan(plan), phase: "preflight" }); }
  catch (error) {
    const conflict = error instanceof MigrationConflict ? error : new MigrationConflict("MIG_PLAN_INVALID", String(error));
    return freeze(migrationReportSchema.parse({ schema: "aira.dev/migration-report/v1", plan_id: plan.id, operation: plan.body.operation,
      phase: "preflight", fully_successful: false, entries: plan.body.entries.map((e) => ({ source_id: e.source.id,
        status: conflict.code === "MIG_STALE_PLAN" ? "stale-plan-rejected" : "failed", code: conflict.code, detail: conflict.message })) }));
  }
}
/** Restart reconciliation consumes ONLY verified committed catalog/receipt observations.
 * Blobs copied without an authoritative receipt are never reported as imported.
 * A coordinator must still reobserve sources and reject stale plans before any retry.
 */
export function reportMigrationRestart(planInput: MigrationPlan, catalogInput: ArchiveCatalog, receiptInput: ArchiveReceipt | null): MigrationReport {
  const plan = migrationPlanSchema.parse(planInput), catalog = archiveCatalogSchema.parse(catalogInput);
  const receipt = receiptInput ? archiveReceiptSchema.parse(receiptInput) : null;
  if (catalog.project !== plan.body.project) throw new MigrationConflict("MIG_ARCHIVE_CONFLICT", "Different archive project");
  if (receipt && (receipt.operation !== plan.body.operation || receipt.publication.plan.id !== plan.id))
    throw new MigrationConflict("MIG_OPERATION_REUSE", "Committed migration operation belongs to another plan");
  const entries = pendingEntries(plan).map((pending): Entry => {
    const planned = plan.body.entries.find((e) => e.source.id === pending.source_id)!;
    const archive = catalog.records.find((r) => r.id === `legacy_${identityHash(planned.source.observation.locator).slice(7)}`);
    if (!archive) return pending.status === "already-imported" ? { ...pending, status: "failed", code: "MIG_ARCHIVE_CONFLICT", detail: "Previously observed committed archive is missing." } : pending;
    if (archive.source.id !== pending.source_id) return { ...pending, status: "manual-action-required", code: "MIG_SOURCE_CONFLICT", detail: "Existing immutable archive has different observations." };
    const expected = receipt?.publication.records.find((r) => r.id === archive.id);
    if (expected && identityHash(expected) === identityHash(archive)) return { ...pending, status: "imported", code: "MIG_IMPORTED", detail: "Exact committed archive record confirmed after restart; original source preserved." };
    if (pending.status === "already-imported") return pending;
    if (planned.actions.some((a) => a.kind === "register-history")) return { ...pending, status: "failed", code: "MIG_RECEIPT_REQUIRED", detail: "Source mapping exists, but this operation's full authoritative receipt is unconfirmed." };
    return pending;
  });
  return freeze(migrationReportSchema.parse({ schema: "aira.dev/migration-report/v1", plan_id: plan.id, operation: plan.body.operation, phase: "restart",
    fully_successful: entries.every((e) => ["imported", "preserved-in-place", "already-imported"].includes(e.status)), entries }));
}
