import { identityHash } from "../legacy/v1/identity";
import type { SourceIdentity } from "../legacy/v1/reader";
import type { ArchiveCatalog } from "./types";
export function archiveId(source: SourceIdentity): string { return `legacy_${identityHash(source.observation.locator).slice(7)}`; }
/** A logical locator can only map to one observed source. Changed bytes never silently
 * replace a prior import, even if original run ID and timestamps are unchanged.
 */
export function existingSource(source: SourceIdentity, catalog: ArchiveCatalog): "absent" | "same" | "conflict" {
  const existing = catalog.records.find((r) => r.id === archiveId(source));
  return !existing ? "absent" : existing.source.id === source.id ? "same" : "conflict";
}
