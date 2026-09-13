import type { z } from "zod";
import type { ReadonlyData } from "../legacy/v1/identity";
import type { LegacyRunInspection } from "../legacy/v1/reader";
import type { ProjectReadFormat } from "../compatibility/format";
import type { archiveCatalogSchema, archiveRecordSchema, migrationPlanSchema, migrationPolicySchema, migrationReportSchema, findingSchema } from "./schema";
export type ArchiveCatalog = ReadonlyData<z.infer<typeof archiveCatalogSchema>>;
export type LegacyArchiveRecord = ReadonlyData<z.infer<typeof archiveRecordSchema>>;
export type MigrationPolicy = ReadonlyData<z.infer<typeof migrationPolicySchema>>;
export type MigrationPlan = ReadonlyData<z.infer<typeof migrationPlanSchema>>;
export type MigrationReport = ReadonlyData<z.infer<typeof migrationReportSchema>>;
export type MigrationFinding = ReadonlyData<z.infer<typeof findingSchema>>;
export interface MigrationInspection {
  readonly schema: "aira.dev/migration-inspection/v1";
  readonly project: string;
  readonly sources: readonly LegacyRunInspection[];
  readonly findings: readonly MigrationFinding[];
  readonly format: ProjectReadFormat;
  readonly archive: ArchiveCatalog;
}
