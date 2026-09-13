import type { LegacyRunInspection } from "./reader";
import { freeze } from "./identity";
export interface CompatibilityWarning { readonly code: string; readonly detail: string }
export function legacyWarnings(item: LegacyRunInspection): CompatibilityWarning[] {
  const warnings = [
    { code: "LEGACY_NOT_RESUMABLE", detail: "Readable v1 history is not executable or resumable as a v2 Spec." },
    { code: "LEGACY_LOSSY_HISTORY", detail: "Lineage, exact approvals, model/config selections and overwritten attempt/artifact bytes are unknown." },
  ];
  if (item.status === "invalid") warnings.push({ code: item.code, detail: item.detail });
  else if (Object.values(item.run.steps).some((s) => s.result === "approved"))
    warnings.push({ code: "LEGACY_APPROVAL_UNATTRIBUTABLE", detail: "Generic approved result has no cryptographic artifact attribution." });
  for (const a of item.source.observation.artifacts) warnings.push(a.observation.status === "present" ?
    { code: "LEGACY_OBSERVED_NOW", detail: `${a.path}: digest identifies surviving bytes observed now, not bytes approved at execution time.` } :
    { code: `LEGACY_ARTIFACT_${a.observation.status.toUpperCase()}`, detail: `${a.path}: bytes unavailable to safe inspection; historical content unknown.` });
  return warnings;
}
export function legacyRunView(item: LegacyRunInspection) {
  return freeze({ kind: "legacy-v1-run" as const, source_format: "v1" as const, version: 1 as const,
    mutable: false as const, resumable: false as const, convertible: false as const,
    importable: item.status === "valid", import_scope: "historical-archive-only" as const,
    id: item.source.observation.locator.run_directory_id, source: item.source,
    inspection: item, warnings: legacyWarnings(item) });
}
export type LegacyV1RunView = ReturnType<typeof legacyRunView>;
