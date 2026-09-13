import { freeze, identityHash, projectIdentitySchema } from "../legacy/v1/identity";
import { legacyInspectionSchema, archiveCatalogSchema, findingSchema } from "./schema";
import { existingSource } from "./compatibility";
import type { ArchiveCatalog, MigrationFinding, MigrationInspection } from "./types";
import type { LegacyRunInspection } from "../legacy/v1/reader";
import type { ProjectReadFormat } from "../compatibility/format";

/** Pure inspection of supplied read observations, not a filesystem traversal or a
 * trust/authentication oracle. No defaults, commands, workflows or source repairs.
 */
export function inspectMigration(input: { project: string; sources: readonly LegacyRunInspection[]; format: ProjectReadFormat; archive: ArchiveCatalog }): MigrationInspection {
  const project = projectIdentitySchema.parse(input.project), archive = archiveCatalogSchema.parse(input.archive);
  if (archive.project !== project) throw new Error("MIG_PROJECT_MISMATCH");
  const sources = input.sources.map((s) => legacyInspectionSchema.parse(s));
  const locators = sources.map((s) => identityHash(s.source.observation.locator));
  if (new Set(locators).size !== locators.length || sources.some((s) => s.source.observation.locator.project !== project)) throw new Error("MIG_SOURCE_SCOPE_INVALID");
  sources.sort((a, b) => a.source.observation.locator.run_path < b.source.observation.locator.run_path ? -1 : a.source.observation.locator.run_path > b.source.observation.locator.run_path ? 1 : 0);
  const findings: MigrationFinding[] = [];
  const add = (code: MigrationFinding["code"], detail: string, subject: string | null = null) => findings.push(findingSchema.parse({ code, detail, subject }));
  if (input.format.v2.status === "available") add("MIG_V2_EXISTS", "V2 already exists; legacy sources remain separate historical data.");
  else if (input.format.v2.status !== "absent") add("MIG_V2_UNAVAILABLE", input.format.v2.detail);
  if (input.format.kind === "ambiguous") add("MIG_LAYOUT_WARNING", "Inconsistent layout requires inspection before any new publication.");
  for (const item of sources) {
    const id = item.source.id;
    if (item.status === "invalid") add(item.code === "LEGACY_UNSUPPORTED_VERSION" ? "MIG_UNSUPPORTED_LEGACY" : "MIG_CORRUPT_LEGACY", item.detail, id);
    else {
      add("MIG_VALID_LEGACY", "Valid historical numeric-v1 run; not a v2 Spec.", id);
      add("MIG_DIAGNOSTIC_IMPORTABLE", "Exact run.json and surviving referenced artifacts are eligible for historical archive planning only. Shell output is diagnostic data, never v2 evidence.", id);
      for (const revision of item.run.revisions ?? []) add(revision.status === "resolved" ? "MIG_REVISION_RESOLVED" : "MIG_REVISION_PENDING", `${revision.approval_step}: ${revision.status}; no inferred lineage.`, id);
      if (Object.values(item.run.steps).some((s) => s.result === "approved")) add("MIG_APPROVAL_UNATTRIBUTABLE", "Generic approval result is not bound to cryptographic content identity.", id);
      if (item.run.status === "interrupted" || Object.values(item.run.steps).some((s) => s.status === "interrupted")) add("MIG_INTERRUPTED_RUN", "Interruption does not establish absence of external effects.", id);
    }
    add("MIG_CONTINUATION_UNSUPPORTED", "No v1 run can be resumed as v2 by this contract.", id);
    add("MIG_HISTORICAL_BYTES_UNKNOWN", "V1 recorded no execution-time content digests; overwritten bytes, model/config/profile attribution and missing attempts remain unknown.", id);
    for (const artifact of item.source.observation.artifacts) {
      const status = artifact.observation.status;
      add(status === "present" ? "MIG_ARTIFACT_PRESENT" : status === "missing" ? "MIG_ARTIFACT_MISSING" : status === "unsafe" ? "MIG_ARTIFACT_UNSAFE" : "MIG_ARTIFACT_UNREADABLE",
        `${artifact.path}: ${status}; observations are not historical content proofs.`, id);
    }
    const existing = existingSource(item.source, archive);
    if (existing !== "absent") add(existing === "same" ? "MIG_ALREADY_IMPORTED" : "MIG_SOURCE_CONFLICT", existing === "same" ? "Committed archive maps this exact source." : "Same logical source has different previously imported observations.", id);
  }
  // Detach the format observation too; freezing the result must not freeze caller memory.
  return freeze({ schema: "aira.dev/migration-inspection/v1", project, sources, findings,
    format: structuredClone(input.format), archive });
}
