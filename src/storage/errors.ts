export const storageErrorCodes = [
  "STORE_NOT_FOUND", "STORE_ALREADY_EXISTS", "STORE_CONFLICT", "STORE_LOCKED", "STORE_LOCK_OWNERSHIP",
  "STORE_INTEGRITY", "STORE_CORRUPT_HEAD", "STORE_CORRUPT_COMMIT", "STORE_CORRUPT_BLOB",
  "STORE_SCHEMA_UNSUPPORTED", "STORE_OPERATION_REUSE", "STORE_PATH_UNSAFE",
  "STORE_DURABILITY_UNSUPPORTED", "STORE_IO",
] as const;
export type StorageErrorCode = typeof storageErrorCodes[number];
export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = "StorageError";
  }
}
export function fail(code: StorageErrorCode, message: string): never { throw new StorageError(code, message); }
export function errno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
export function storageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  return new StorageError(errno(error, "ELOOP") ? "STORE_PATH_UNSAFE" : "STORE_IO", "Storage I/O failed", { cause: error });
}
export async function io<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { throw storageError(error); }
}
