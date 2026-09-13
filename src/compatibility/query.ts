import type { SpecId } from "../spec/domain/ids";
import type { StoreSnapshot } from "../storage/types";
import type { LegacyRunInspection } from "../legacy/v1/reader";
import { legacyRunView, type LegacyV1RunView } from "../legacy/v1/view";
import { canDecodeV2, type ProjectReadFormat } from "./format";

export interface QueryFailure { readonly source_format: "v1" | "v2"; readonly id: string | null; readonly code: string; readonly detail: string }
export interface LegacyHistoryReader {
  discover(): Promise<{ readonly ids: readonly string[]; readonly warnings: readonly { path: string; code: string }[] }>;
  inspect(id: string, at: string): Promise<LegacyRunInspection>;
}
export interface V2SpecReader {
  list(): Promise<{ readonly ids: readonly SpecId[]; readonly failures: readonly QueryFailure[] }>;
  load(id: SpecId): Promise<StoreSnapshot>;
}
export interface V2SpecView {
  readonly kind: "v2-spec"; readonly source_format: "v2"; readonly version: 2;
  readonly id: SpecId; readonly snapshot: StoreSnapshot;
  /** Domain mutable, NOT authorization or a backend capability guarantee. */
  readonly mutable: true; readonly resumable: false; readonly importable: false;
  readonly warnings: readonly { readonly code: string; readonly detail: string }[];
}
export type HistoryItem = LegacyV1RunView | V2SpecView;
function failure(source_format: "v1" | "v2", id: string | null, error: unknown): QueryFailure {
  return { source_format, id, code: error && typeof error === "object" && "code" in error ? String(error.code) : "QUERY_IO",
    detail: error instanceof Error ? error.message : "Query failed" };
}
/** Composition only above the two distinct domains. Never resumes, authorizes or mutates. */
export class CompatibilityQueries {
  constructor(readonly format: () => Promise<ProjectReadFormat>, readonly legacy: LegacyHistoryReader, readonly v2: V2SpecReader) {}
  async legacyDetail(id: string, at: string): Promise<LegacyV1RunView> { return legacyRunView(await this.legacy.inspect(id, at)); }
  async specDetail(id: SpecId): Promise<V2SpecView> {
    const format = await this.format();
    if (!canDecodeV2(format)) throw Object.assign(new Error(format.v2.detail), { code: format.v2.status === "available" ? "FORMAT_LAYOUT_AMBIGUOUS" : format.v2.code });
    return { kind: "v2-spec", source_format: "v2", version: 2, id, snapshot: await this.v2.load(id), mutable: true,
      resumable: false, importable: false, warnings: [{ code: "V2_RUNTIME_NOT_CONNECTED", detail: "Readability and domain mutability do not provide a resume operation." }] };
  }
  async list(at: string): Promise<{ format: ProjectReadFormat; items: readonly HistoryItem[]; failures: readonly QueryFailure[] }> {
    const format = await this.format(), items: HistoryItem[] = [], failures: QueryFailure[] = [];
    // A broken legacy config/commands marker is not a reason to hide safe runs.
    try {
      const found = await this.legacy.discover();
      for (const warning of found.warnings) failures.push({ source_format: "v1", id: null, code: warning.code, detail: warning.path });
      for (const id of found.ids) try { items.push(await this.legacyDetail(id, at)); } catch (error) { failures.push(failure("v1", id, error)); }
    } catch (error) { failures.push(failure("v1", null, error)); }
    if (canDecodeV2(format)) try {
      const found = await this.v2.list(); failures.push(...found.failures);
      for (const id of found.ids) try { items.push(await this.specDetail(id)); } catch (error) { failures.push(failure("v2", id, error)); }
    } catch (error) { failures.push(failure("v2", null, error)); }
    else if (format.v2.status !== "absent") failures.push({ source_format: "v2", id: null, code: format.v2.status === "available" ? "FORMAT_LAYOUT_AMBIGUOUS" : format.v2.code, detail: format.v2.detail });
    return { format, items, failures };
  }
}
