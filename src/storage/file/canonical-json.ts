import {
  canonicalBytes as encodeCanonicalBytes,
  canonicalJSON as encodeCanonicalJSON,
  hashBytes as digestBytes,
  hashCanonical as digestCanonical,
} from "../../canonical-json";
import type { ContentHash } from "../../spec/domain/primitives";
import { fail, type StorageErrorCode } from "../errors";
import { parseRecord, type DomainRecord, type RecordReference } from "../records";

/** Storage-facing wrappers preserve typed storage failures while sharing the
 * provider-neutral aira.dev/canonical-json/v1 byte and SHA-256 implementation.
 */
export function canonicalJSON(value: unknown): string {
  try { return encodeCanonicalJSON(value); }
  catch (error) { fail("STORE_INTEGRITY", error instanceof Error ? error.message : "Canonical JSON encoding failed"); }
}
export function canonicalBytes(value: unknown): Uint8Array {
  try { return encodeCanonicalBytes(value); }
  catch (error) { fail("STORE_INTEGRITY", error instanceof Error ? error.message : "Canonical JSON encoding failed"); }
}
export const hashBytes = (bytes: Uint8Array): ContentHash => digestBytes(bytes);
export function hashCanonical(value: unknown): ContentHash {
  try { return digestCanonical(value); }
  catch (error) { fail("STORE_INTEGRITY", error instanceof Error ? error.message : "Canonical JSON hashing failed"); }
}
export function decodeCanonical(bytes: Uint8Array, code: StorageErrorCode): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (encodeCanonicalJSON(value) !== text) fail(code, "Record is not canonical JSON");
    return value;
  } catch (error) { fail(code, `Invalid canonical record: ${error instanceof Error ? error.message : "decode failed"}`); }
}
export function encodeRecord(value: DomainRecord): { reference: RecordReference; bytes: Uint8Array } {
  const bytes = canonicalBytes(value); // Reject undefined before schema parsing.
  const parsed = parseRecord(value);
  if (canonicalJSON(parsed) !== canonicalJSON(value)) fail("STORE_INTEGRITY", "Domain decoder changed record");
  return { reference: { contract: parsed.schema, hash: hashBytes(bytes) }, bytes };
}
