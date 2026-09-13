import { z } from "zod";
import type { RunState } from "./types";
import type { ReadonlyData } from "./identity";
import { observedBytesSchema, observeBytes } from "./identity";
import { isSafeStoredArtifactPath, isInspectionPath } from "./paths";
import type { LegacyFiles } from "./files";
import { legacyError } from "./errors";

export const artifactObservationSchema = z.strictObject({
  path: z.string(), references: z.array(z.string()).min(1), historical_bytes: z.literal("unknown"),
  observation: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("present"), bytes: observedBytesSchema }),
    z.strictObject({ status: z.enum(["missing", "unsafe", "unreadable"]), code: z.string() }),
  ]),
});
export type ArtifactObservation = ReadonlyData<z.infer<typeof artifactObservationSchema>>;
/** Includes step result paths and revision references, not only the current artifact map. */
export function artifactReferences(run: ReadonlyData<RunState>): { path: string; references: string[] }[] {
  const paths = new Map<string, string[]>();
  function add(path: string, reference: string) { const refs = paths.get(path) ?? []; refs.push(reference); paths.set(path, refs); }
  for (const [name, state] of Object.entries(run.artifacts)) {
    add(state.current, `artifact:${name}:current`);
    state.versions?.forEach((path, i) => add(path, `artifact:${name}:version:${i}`));
  }
  run.revisions?.forEach((r, i) => { if (r.previous_artifact) add(r.previous_artifact.path, `revision:${i}:previous:${r.previous_artifact.name}`); });
  for (const [id, step] of Object.entries(run.steps)) if (step.artifact !== undefined) add(step.artifact, `step:${id}:artifact`);
  return [...paths].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, references]) => ({ path, references: references.sort() }));
}
export async function observeArtifacts(files: LegacyFiles, runPath: string, run: ReadonlyData<RunState>): Promise<ArtifactObservation[]> {
  const result: ArtifactObservation[] = [];
  for (const ref of artifactReferences(run)) {
    let observation: ArtifactObservation["observation"];
    if (!isSafeStoredArtifactPath(ref.path) || !isInspectionPath(ref.path)) observation = { status: "unsafe", code: "LEGACY_PATH_UNSAFE" };
    else try { observation = { status: "present", bytes: observeBytes(await files.read(`${runPath}/${ref.path}`)) }; }
    catch (error) {
      const e = legacyError(error);
      observation = { status: e.code === "LEGACY_NOT_FOUND" ? "missing" : e.code === "LEGACY_PATH_UNSAFE" ? "unsafe" : "unreadable", code: e.code };
    }
    result.push({ ...ref, historical_bytes: "unknown", observation });
  }
  return result;
}
