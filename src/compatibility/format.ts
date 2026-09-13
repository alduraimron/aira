import { dispatchFormatRecord, fileStoreFormat } from "../storage/format";
import { identityJSON, freeze } from "../legacy/v1/identity";

export type EntryKind = "missing" | "directory" | "file" | "unsafe" | "other";
/** Provider-neutral, side-effect-free observation port. No discovery by cwd/defaults. */
export interface ReadLayout {
  kind(path: string): Promise<EntryKind>;
  list(path: string): Promise<readonly string[]>;
  read(path: string): Promise<Uint8Array>;
}
export interface SubsystemFormat {
  readonly status: "absent" | "available" | "unsupported" | "corrupt" | "inconsistent";
  readonly code: string; readonly detail: string; readonly schema?: string;
}
export interface ProjectReadFormat {
  readonly kind: "none" | "legacy-v1" | "v2" | "mixed" | "unsupported-v2" | "corrupt-v2" | "ambiguous";
  readonly legacy: SubsystemFormat; readonly v2: SubsystemFormat;
  readonly warnings: readonly string[];
}
export function canDecodeV2(format: ProjectReadFormat): boolean {
  return format.v2.status === "available" && !format.warnings.some((w) => w.startsWith("FORMAT_CONFLICTING_STATE") ||
    w.startsWith("FORMAT_UNKNOWN_V2") || w === "FORMAT_UNKNOWN_CONTROL_MARKER:FORMAT");
}
const absent = (): SubsystemFormat => ({ status: "absent", code: "FORMAT_ABSENT", detail: "No subsystem markers" });
export async function detectReadFormat(layout: ReadLayout): Promise<ProjectReadFormat> {
  let legacy = absent(), v2 = absent(); const warnings: string[] = [];
  let project: EntryKind;
  try { project = await layout.kind(".aira"); }
  catch { project = "unsafe"; }
  if (project === "missing") return freeze({ kind: "none", legacy, v2, warnings });
  if (project !== "directory") return freeze({ kind: "ambiguous", legacy: { status: "inconsistent", code: "FORMAT_CONTROL_UNSAFE", detail: "Control root is not a safe directory" },
    v2: { status: "inconsistent", code: "FORMAT_CONTROL_UNSAFE", detail: "Control root is not a safe directory" }, warnings });
  try {
    const markers = await layout.list(".aira");
    const known = ["runs", "config.yaml", "workflows", "commands", "state"];
    for (const name of markers) if (!known.includes(name)) warnings.push(`FORMAT_UNKNOWN_CONTROL_MARKER:${name}`);
    let found = false, inconsistent = false;
    for (const [name, type] of [["runs", "directory"], ["workflows", "directory"], ["commands", "directory"], ["config.yaml", "file"]] as const) {
      const kind = await layout.kind(`.aira/${name}`);
      if (kind !== "missing") { found = true; if (kind !== type) inconsistent = true; }
    }
    legacy = inconsistent ? { status: "inconsistent", code: "FORMAT_LEGACY_LAYOUT", detail: "Legacy marker type is unsafe/inconsistent; independently safe runs can still be inspected" } :
      found ? { status: "available", code: "FORMAT_LEGACY_V1", detail: "Legacy project/history markers; configuration contents are irrelevant to historical reads" } : absent();
  } catch { legacy = { status: "inconsistent", code: "FORMAT_LEGACY_IO", detail: "Legacy markers could not be inspected" }; }
  try {
    const state = await layout.kind(".aira/state");
    if (state !== "missing" && state !== "directory") v2 = { status: "inconsistent", code: "FORMAT_STATE_UNSAFE", detail: "State marker is not a safe directory" };
    else if (state === "directory") {
      const names = await layout.list(".aira/state");
      if (names.some((n) => n !== "v2")) warnings.push("FORMAT_CONFLICTING_STATE_MARKERS");
      const root = await layout.kind(".aira/state/v2");
      if (root === "missing") v2 = { status: "inconsistent", code: "FORMAT_STATE_UNVERSIONED", detail: "State exists without a supported version root" };
      else if (root !== "directory") v2 = { status: "inconsistent", code: "FORMAT_V2_UNSAFE", detail: "V2 root is not a safe directory" };
      else {
        const marker = await layout.kind(".aira/state/v2/FORMAT");
        if (marker !== "file") v2 = { status: "inconsistent", code: "FORMAT_V2_MISSING_OR_UNSAFE", detail: "V2 directory has no safe FORMAT; never initialize it during inspection" };
        else {
          const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await layout.read(".aira/state/v2/FORMAT"));
          const decoded = dispatchFormatRecord(JSON.parse(text));
          if (decoded.status === "unsupported") v2 = { status: "unsupported", code: "FORMAT_V2_UNSUPPORTED", schema: decoded.schema, detail: "Unknown version; current state decoding is forbidden" };
          else if (decoded.status === "corrupt" || text !== identityJSON(fileStoreFormat))
            v2 = { status: "corrupt", code: "FORMAT_V2_CORRUPT", detail: "Malformed, noncanonical or incompatible FORMAT" };
          else {
            v2 = { status: "available", code: "FORMAT_V2_AVAILABLE", detail: "Supported FORMAT; each authoritative HEAD still requires integrity validation" };
            for (const [name, kind] of [["blobs", "directory"], ["specs", "directory"], ["locks", "directory"]] as const) {
              const entry = await layout.kind(`.aira/state/v2/${name}`);
              if (entry !== "missing" && entry !== kind) v2 = { status: "inconsistent", code: "FORMAT_V2_LAYOUT", detail: "Unsafe v2 namespace" };
            }
            for (const name of await layout.list(".aira/state/v2"))
              if (!["FORMAT", "blobs", "specs", "locks"].includes(name) && !/^\.publish-tmp-[a-f0-9]{32,64}$/.test(name)) warnings.push(`FORMAT_UNKNOWN_V2_MARKER:${name}`);
          }
        }
      }
    }
  } catch { v2 = { status: "corrupt", code: "FORMAT_V2_UNREADABLE", detail: "V2 format could not be decoded safely" }; }
  const kind: ProjectReadFormat["kind"] = v2.status === "unsupported" ? "unsupported-v2" : v2.status === "corrupt" ? "corrupt-v2" :
    legacy.status === "inconsistent" || v2.status === "inconsistent" || warnings.length ? "ambiguous" :
    legacy.status === "available" ? v2.status === "available" ? "mixed" : "legacy-v1" : v2.status === "available" ? "v2" : "ambiguous";
  return freeze({ kind, legacy, v2, warnings });
}
