import { createHash } from "node:crypto";
import { contentHashSchema, type ContentHash } from "../../spec/domain/primitives";
import { fail, type StorageErrorCode } from "../errors";
import { parseRecord, type DomainRecord, type RecordReference } from "../records";

/** aira canonical JSON v1: UTF-16 key order, ECMAScript finite number rendering,
 * exact strings, UTF-8, no BOM/whitespace. Not the domain comparison helper.
 * Lone surrogates are escaped by JSON.stringify, never replaced by UTF-8 encoding.
 */
export function canonicalJSON(value: unknown): string {
  const active = new Set<object>();
  function encode(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number") {
      if (!Number.isFinite(v) || Object.is(v, -0)) fail("STORE_INTEGRITY", "Unsupported JSON number (including negative zero)");
      return JSON.stringify(v);
    }
    if (typeof v !== "object") fail("STORE_INTEGRITY", "Unsupported JSON value");
    if (active.has(v)) fail("STORE_INTEGRITY", "Cyclic JSON value");
    const prototype = Object.getPrototypeOf(v);
    if (Array.isArray(v) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      fail("STORE_INTEGRITY", "JSON requires plain data objects/arrays");
    if (Object.getOwnPropertySymbols(v).length) fail("STORE_INTEGRITY", "Symbol keys are unsupported");
    active.add(v);
    const keys = Object.getOwnPropertyNames(v);
    for (const key of keys) {
      if (Array.isArray(v) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) fail("STORE_INTEGRITY", "Accessors/non-enumerable JSON properties are unsupported");
    }
    let result: string;
    if (Array.isArray(v)) {
      if (keys.length !== v.length + 1 || Array.from({ length: v.length }, (_, i) => String(i)).some((k) => !Object.hasOwn(v, k)))
        fail("STORE_INTEGRITY", "Sparse or decorated arrays are unsupported");
      result = `[${v.map(encode).join(",")}]`;
    } else result = `{${keys.sort().map((k) => `${JSON.stringify(k)}:${encode((v as Record<string, unknown>)[k])}`).join(",")}}`;
    active.delete(v); return result;
  }
  return encode(value);
}
export const canonicalBytes = (value: unknown): Uint8Array => new TextEncoder().encode(canonicalJSON(value));
export const hashBytes = (bytes: Uint8Array): ContentHash => contentHashSchema.parse(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
export const hashCanonical = (value: unknown): ContentHash => hashBytes(canonicalBytes(value));
export function decodeCanonical(bytes: Uint8Array, code: StorageErrorCode): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (canonicalJSON(value) !== text) fail(code, "Record is not canonical JSON");
    return value;
  } catch (error) { fail(code, `Invalid canonical record: ${error instanceof Error ? error.message : "decode failed"}`); }
}
export function encodeRecord(value: DomainRecord): { reference: RecordReference; bytes: Uint8Array } {
  const bytes = canonicalBytes(value); // Reject undefined before schema parsing.
  const parsed = parseRecord(value);
  if (canonicalJSON(parsed) !== canonicalJSON(value)) fail("STORE_INTEGRITY", "Domain decoder changed record");
  return { reference: { contract: parsed.schema, hash: hashBytes(bytes) }, bytes };
}
