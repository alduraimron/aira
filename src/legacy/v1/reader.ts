import { runStateSchema } from "./schema";
import { RUN_ID_PATTERN, isSafeStoredArtifactPath, isInspectionPath } from "./paths";
import { LegacyFiles } from "./files";
import { LegacyReadError, legacyError, type LegacyErrorCode } from "./errors";
import { observeArtifacts, artifactReferences } from "./artifacts";
import { locatorSchema, observeBytes, identityHash, freeze, inspectionTimeSchema,
  type ReadonlyData } from "./identity";
import type { RunState } from "./types";

import { sourceObservationSchema, type SourceIdentity } from "./observations";
export { sourceObservationSchema, sourceIdentitySchema, type SourceIdentity } from "./observations";
export type LegacyRunInspection = ReadonlyData<{
  inspected_at: string; source: SourceIdentity;
} & ({ status: "valid"; run: RunState } | { status: "invalid"; code: LegacyErrorCode; detail: string })>;
export interface LegacyReaderOptions { projectIdentity: string; controlPath?: string; runsPath?: string }
export class LegacyV1Reader {
  readonly files: LegacyFiles;
  readonly options: Readonly<Required<LegacyReaderOptions>>;
  constructor(root: string, options: LegacyReaderOptions) {
    this.files = new LegacyFiles(root);
    this.options = Object.freeze({ ...options, controlPath: options.controlPath ?? ".aira", runsPath: options.runsPath ?? ".aira/runs" });
    this.locator("00000000-000000-00000000"); // Validate root identity and relative paths before I/O.
  }
  private locator(id: string) {
    if (!RUN_ID_PATTERN.test(id)) throw new LegacyReadError("LEGACY_PATH_UNSAFE", "Invalid legacy directory ID");
    return locatorSchema.parse({ schema: "aira.dev/legacy-v1-source/v1", project: this.options.projectIdentity,
      control_path: this.options.controlPath, run_path: `${this.options.runsPath}/${id}`, run_directory_id: id, version: 1 });
  }
  async discover(): Promise<{ readonly ids: readonly string[]; readonly warnings: readonly { path: string; code: string }[] }> {
    const ids: string[] = [], warnings: { path: string; code: string }[] = [];
    for (const name of await this.files.list(this.options.runsPath)) {
      if (RUN_ID_PATTERN.test(name)) ids.push(name); // Corrupt files/symlinks still get an explicit inspection result.
      else warnings.push({ path: `${this.options.runsPath}/${name}`, code: "LEGACY_UNRECOGNIZED_ENTRY" });
    }
    return freeze({ ids, warnings });
  }
  async inspect(id: string, inspectedAt: string): Promise<LegacyRunInspection> {
    const locator = this.locator(id); inspectionTimeSchema.parse(inspectedAt);
    let runJson: ReturnType<typeof observeBytes> | null = null, originalRunId: string | null = null;
    let outcome: { status: "valid"; run: RunState } | { status: "invalid"; code: LegacyErrorCode; detail: string };
    let artifacts: Awaited<ReturnType<typeof observeArtifacts>> = [];
    try {
      const bytes = await this.files.read(`${locator.run_path}/run.json`); runJson = observeBytes(bytes);
      let value: unknown;
      // Historical JSON interpretation matches v1's UTF-8 string / JSON.parse behavior;
      // unlike v2 it did not require canonical JSON or reject duplicate JSON keys.
      try { value = JSON.parse(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)); }
      catch { throw new LegacyReadError("LEGACY_INVALID_JSON", "Historical run.json contains invalid JSON"); }
      if (value && typeof value === "object" && "version" in value && value.version !== 1)
        throw new LegacyReadError("LEGACY_UNSUPPORTED_VERSION", "Historical version is not numeric v1");
      const parsed = runStateSchema.safeParse(value);
      if (!parsed.success) throw new LegacyReadError("LEGACY_INVALID_SCHEMA", parsed.error.message);
      originalRunId = parsed.data.id;
      if (parsed.data.id !== id) throw new LegacyReadError("LEGACY_ID_MISMATCH", "Stored run ID differs from directory ID");
      artifacts = await observeArtifacts(this.files, locator.run_path, parsed.data);
      if (observeBytes(await this.files.read(`${locator.run_path}/run.json`)).hash !== runJson.hash)
        throw new LegacyReadError("LEGACY_SOURCE_CHANGED", "run.json changed while inspecting artifacts");
      outcome = { status: "valid", run: parsed.data };
    } catch (error) { const e = legacyError(error); outcome = { status: "invalid", code: e.code, detail: e.message }; }
    const observation = sourceObservationSchema.parse({ schema: "aira.dev/legacy-v1-observation/v1", locator, original_run_id: originalRunId, run_json: runJson, artifacts });
    return freeze({ ...outcome, inspected_at: inspectedAt, source: { id: identityHash(observation), observation } });
  }
  /** Exact run.json capture for a reviewed observation, never a JSON reserialization. */
  async readRunBytes(inspection: LegacyRunInspection) {
    const expected = this.locator(inspection.source.observation.locator.run_directory_id);
    if (identityHash(expected) !== identityHash(inspection.source.observation.locator))
      throw new LegacyReadError("LEGACY_PATH_UNSAFE", "Source belongs to a different control root association");
    const bytes = await this.files.read(`${expected.run_path}/run.json`), observation = observeBytes(bytes);
    if (observation.hash !== inspection.source.observation.run_json?.hash)
      throw new LegacyReadError("LEGACY_SOURCE_CHANGED", "run.json no longer matches its observation");
    return { bytes, observation };
  }
  /** Explicit current read of a referenced artifact. Caller receives a new observation,
   * never a claim about historical approval bytes. Paths not in run.json cannot be read.
   */
  async readArtifact(inspection: LegacyRunInspection, path: string) {
    const expected = this.locator(inspection.source.observation.locator.run_directory_id);
    if (identityHash(expected) !== identityHash(inspection.source.observation.locator) || inspection.status !== "valid" ||
      !artifactReferences(inspection.run).some((r) => r.path === path) || !isSafeStoredArtifactPath(path) || !isInspectionPath(path))
      throw new LegacyReadError("LEGACY_PATH_UNSAFE", "Artifact is not a safe reference in this source");
    const bytes = await this.files.read(`${expected.run_path}/${path}`);
    return { bytes, observation: observeBytes(bytes) };
  }
}
