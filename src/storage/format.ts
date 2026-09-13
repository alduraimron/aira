import { z } from "zod";

/** File-store version is distinct from SDD domain version and legacy numeric version. */
export const fileStoreFormatSchema = z.strictObject({
  schema: z.literal("aira.dev/file-store/v1"), store: z.literal("v2"),
  canonical_json: z.literal("aira.dev/canonical-json/v1"), hash: z.literal("sha256"),
  spec_keys: z.literal("hex-utf8/v1"), publication: z.literal("immutable-link-atomic-head/v1"),
});
export const fileStoreFormat = Object.freeze(fileStoreFormatSchema.parse({
  schema: "aira.dev/file-store/v1", store: "v2", canonical_json: "aira.dev/canonical-json/v1",
  hash: "sha256", spec_keys: "hex-utf8/v1", publication: "immutable-link-atomic-head/v1",
}));
export type FormatRecordResult =
  | { readonly status: "supported"; readonly version: 1 }
  | { readonly status: "unsupported"; readonly schema: string }
  | { readonly status: "corrupt" };
/** Bytes must separately pass the advertised encoding's canonical decoder. */
export function dispatchFormatRecord(value: unknown): FormatRecordResult {
  if (value && typeof value === "object" && "schema" in value && typeof value.schema === "string" &&
    /^aira\.dev\/file-store\/v[1-9][0-9]*$/.test(value.schema) && value.schema !== "aira.dev/file-store/v1")
    return { status: "unsupported", schema: value.schema };
  return fileStoreFormatSchema.safeParse(value).success ? { status: "supported", version: 1 } : { status: "corrupt" };
}
