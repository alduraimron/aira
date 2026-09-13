import { freeze, identityHash, identityJSON } from "../legacy/v1/identity";
import { legacyWarnings } from "../legacy/v1/view";
import type { LegacyRunInspection } from "../legacy/v1/reader";
import { archiveId, existingSource } from "./compatibility";
import { migrationPlanBodySchema, migrationPlanSchema, migrationPolicySchema, archiveCatalogSchema } from "./schema";
import { inspectMigration } from "./inspect";
import type { MigrationInspection, MigrationPlan, MigrationPolicy } from "./types";
import type { z } from "zod";

function actions(item: LegacyRunInspection, inspection: MigrationInspection, policy: MigrationPolicy): z.infer<typeof migrationPlanBodySchema>["entries"][number]["actions"] {
  const result: ReturnType<typeof actions> = [{ kind: "preserve-source" }];
  const stop = (action: ReturnType<typeof actions>[number]) => [...result, action];
  if (item.status === "invalid") return stop({ kind: policy.invalid === "skip" ? "skip" : "manual",
    code: item.code === "LEGACY_UNSUPPORTED_VERSION" ? "MIG_UNSUPPORTED_LEGACY" : "MIG_CORRUPT_LEGACY" });
  if (policy.history === "preserve") return result;
  const existing = existingSource(item.source, inspection.archive);
  if (existing === "same") {
    const record = inspection.archive.records.find((r) => r.id === archiveId(item.source))!;
    if (policy.history === "archive-surviving" && item.source.observation.artifacts.some((a) => a.observation.status === "present" &&
      !record.artifacts.some((b) => b.path === a.path && a.observation.status === "present" && b.blob.hash === a.observation.bytes.hash)))
      return stop({ kind: "manual", code: "MIG_SOURCE_CONFLICT" }); // Immutable metadata-only import cannot silently gain new bytes.
    return stop({ kind: "already-imported", archive_id: archiveId(item.source) });
  }
  if (existing === "conflict") return stop({ kind: "manual", code: "MIG_SOURCE_CONFLICT" });
  if (!["available", "absent"].includes(inspection.format.v2.status) || inspection.format.kind === "ambiguous")
    return stop({ kind: "manual", code: "MIG_V2_UNAVAILABLE" });
  if (policy.unavailable_artifacts === "manual" && item.source.observation.artifacts.some((a) => a.observation.status !== "present"))
    return stop({ kind: "manual", code: "MIG_ARTIFACT_UNREADABLE" });
  const run = item.source.observation.run_json;
  if (!run) throw new Error("MIG_SOURCE_BYTES_REQUIRED");
  result.push({ kind: "register-history", archive_id: archiveId(item.source), run_json: run.hash });
  if (policy.history === "archive-surviving") for (const a of item.source.observation.artifacts) if (a.observation.status === "present")
    result.push({ kind: "copy-observed-blob", path: a.path, hash: a.observation.bytes.hash, bytes: a.observation.bytes.bytes, provenance: "observed-during-import" });
  return result;
}
/** Immutable deterministic plan, including operation identity, explicit policy, exact
 * source observations and archive CAS. Inspection clocks are deliberately excluded.
 */
export function planMigration(input: MigrationInspection, policyInput: MigrationPolicy, operation: string): MigrationPlan {
  const inspection = inspectMigration(input), policy = migrationPolicySchema.parse(policyInput);
  const body = migrationPlanBodySchema.parse({ schema: "aira.dev/migration-plan/v1", project: inspection.project, operation, policy,
    expected_archive_head: inspection.archive.head, entries: inspection.sources.map((item) => ({ source: item.source, validity: item.status,
      actions: actions(item, inspection, policy), warnings: legacyWarnings(item) })) });
  return freeze(migrationPlanSchema.parse({ id: identityHash(body), body }));
}
export class MigrationConflict extends Error {
  constructor(readonly code: "MIG_STALE_PLAN" | "MIG_ARCHIVE_CONFLICT" | "MIG_PLAN_INVALID" | "MIG_OPERATION_REUSE", message: string) { super(message); this.name = "MigrationConflict"; }
}
/** Pure preflight used after NEW safe source observations, before any future writes.
 * This is not an executor and does not freeze a concurrently mutable filesystem.
 */
export function validateMigrationPlan(planInput: MigrationPlan, freshInput: MigrationInspection): MigrationPlan {
  const parsed = migrationPlanSchema.safeParse(planInput);
  if (!parsed.success) throw new MigrationConflict("MIG_PLAN_INVALID", parsed.error.message);
  const plan = parsed.data, fresh = inspectMigration(freshInput);
  if (fresh.project !== plan.body.project) throw new MigrationConflict("MIG_STALE_PLAN", "Source project identity changed");
  for (const entry of plan.body.entries) {
    const current = fresh.sources.find((s) => identityHash(s.source.observation.locator) === identityHash(entry.source.observation.locator));
    if (!current || current.source.id !== entry.source.id || current.status !== entry.validity)
      throw new MigrationConflict("MIG_STALE_PLAN", `Source observation changed: ${entry.source.observation.locator.run_path}`);
  }
  const archive = archiveCatalogSchema.parse(fresh.archive);
  if (identityJSON(archive.head) !== identityJSON(plan.body.expected_archive_head))
    throw new MigrationConflict("MIG_ARCHIVE_CONFLICT", "Archive HEAD changed; reconcile committed operations before preparing fresh CAS");
  // Rebuild exact actions for the explicitly selected sources, not newly discovered runs.
  const selected = inspectMigration({ ...fresh, sources: fresh.sources.filter((s) => plan.body.entries.some((e) => e.source.id === s.source.id)) });
  const rebuilt = planMigration(selected, plan.body.policy, plan.body.operation);
  if (rebuilt.id !== plan.id) throw new MigrationConflict("MIG_PLAN_INVALID", "Plan no longer matches policy, compatibility or source findings");
  return freeze(plan);
}
