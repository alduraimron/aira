import { createHash } from "node:crypto";
import { z } from "zod";
import { isInspectionPath, RUN_ID_PATTERN } from "./paths";
import { isoTimestampSchema } from "./schema";

export const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type Digest = z.infer<typeof digestSchema>;
export const projectIdentitySchema = z.string().regex(/^project_[a-z0-9][a-z0-9_-]{0,127}$/);
export const relativePathSchema = z.string().refine(isInspectionPath);
export const locatorSchema = z.strictObject({
  schema: z.literal("aira.dev/legacy-v1-source/v1"), project: projectIdentitySchema,
  control_path: relativePathSchema, run_path: relativePathSchema,
  run_directory_id: z.string().regex(RUN_ID_PATTERN), version: z.literal(1),
}).refine((s) => s.run_path.endsWith(`/${s.run_directory_id}`) && s.run_path.startsWith(`${s.control_path}/`));
export const observedBytesSchema = z.strictObject({
  hash: digestSchema, bytes: z.number().int().nonnegative(),
  provenance: z.literal("observed-now"), historical_identity: z.literal("not-recorded-in-v1"),
});
export type ObservedBytes = z.infer<typeof observedBytesSchema>;
export const inspectionTimeSchema = isoTimestampSchema;
export type ReadonlyData<T> = T extends readonly unknown[] ? { readonly [K in keyof T]: ReadonlyData<T[K]> } :
  T extends object ? { readonly [K in keyof T]: ReadonlyData<T[K]> } : T;
export function freeze<T>(value: T): ReadonlyData<T> {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value as ReadonlyData<T>;
}
export function observeBytes(bytes: Uint8Array): ObservedBytes {
  return { hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes: bytes.length,
    provenance: "observed-now", historical_identity: "not-recorded-in-v1" };
}
/** Deterministic JSON identity for these versioned observation/plan contracts only.
 * Not the v2 storage/domain codec. No clock, filesystem, random or environment input.
 */
export function identityJSON(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(identityJSON).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${identityJSON((value as Record<string, unknown>)[k])}`).join(",")}}`;
  throw new TypeError("Observation identities require exact JSON data");
}
export function identityHash(value: unknown): Digest { return observeBytes(new TextEncoder().encode(identityJSON(value))).hash; }
