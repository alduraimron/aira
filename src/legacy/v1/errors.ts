export const legacyErrorCodes = ["LEGACY_NOT_FOUND", "LEGACY_INVALID_JSON", "LEGACY_INVALID_SCHEMA", "LEGACY_UNSUPPORTED_VERSION",
  "LEGACY_ID_MISMATCH", "LEGACY_PATH_UNSAFE", "LEGACY_SOURCE_CHANGED", "LEGACY_IO"] as const;
export type LegacyErrorCode = typeof legacyErrorCodes[number];
export class LegacyReadError extends Error {
  constructor(readonly code: LegacyErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = "LegacyReadError"; }
}
export function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}
export function legacyError(error: unknown): LegacyReadError {
  if (error instanceof LegacyReadError) return error;
  return new LegacyReadError(hasCode(error, "ENOENT") ? "LEGACY_NOT_FOUND" : hasCode(error, "ELOOP") ? "LEGACY_PATH_UNSAFE" : "LEGACY_IO", "Historical data could not be read", { cause: error });
}
