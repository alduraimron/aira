// Historical lexical validity, frozen independently of src/artifacts and src/run.
export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[a-f0-9]{8}$/;
export const ARTIFACT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
export function isSafeStoredArtifactPath(value: string): boolean {
  return value.startsWith("artifacts/") && !value.includes("\0") && !value.includes("\\") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
/** Inspection is stricter than historical decoding. Never URL-decode stored paths. */
export function isInspectionPath(value: string): boolean {
  return value.length > 0 && !/[\\:%\x00-\x1f\x7f]/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
