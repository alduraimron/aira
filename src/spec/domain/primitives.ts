import { z } from "zod";
import { artifactRevisionIdSchema, operationIdSchema, policyIdSchema, profileIdSchema } from "./ids";

export const nonBlankSchema = z.string().refine((s) => s.trim().length > 0 && !s.includes("\0"), "nonblank-text-required");
export const contentHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/).brand<"ContentHash">();
export type ContentHash = z.infer<typeof contentHashSchema>;
export const safeUnsignedSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const timestampSchema = z.string().refine((s) => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(s);
  return !!match && Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString() === `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
}, "invalid-utc-timestamp");
export const humanActorSchema = z.strictObject({
  kind: z.literal("human"), id: nonBlankSchema, display_name: nonBlankSchema.optional(),
});
export const actorSchema = z.union([humanActorSchema, z.strictObject({
  kind: z.enum(["system", "model", "worker"]), id: nonBlankSchema,
  implementation: nonBlankSchema,
})]);
export const channelSchema = z.enum(["cli", "pi", "api", "other"]);
export const createdMetadataSchema = z.strictObject({
  at: timestampSchema, by: actorSchema, operation: operationIdSchema,
  channel: channelSchema.optional(),
});
export const blobReferenceSchema = z.strictObject({
  hash: contentHashSchema, bytes: safeUnsignedSchema, media_type: nonBlankSchema,
});
export const profileReferenceSchema = z.strictObject({
  id: profileIdSchema, revision: artifactRevisionIdSchema, hash: contentHashSchema,
});
export const policyReferenceSchema = z.strictObject({
  id: policyIdSchema, revision: artifactRevisionIdSchema, hash: contentHashSchema,
});
export type ProfileReference = z.infer<typeof profileReferenceSchema>;
export type PolicyReference = z.infer<typeof policyReferenceSchema>;
export type HumanActor = z.infer<typeof humanActorSchema>;
export type DeepReadonly<T> = T extends string | number | boolean | bigint | symbol | null | undefined ? T :
  T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] :
  T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export interface DomainIssue {
  readonly code: string;
  readonly subject?: string;
  readonly related?: readonly string[];
  readonly requirement?: string;
  readonly task?: string;
  readonly verifier?: string;
}
export type DomainResult<T> = { readonly ok: true; readonly value: T } |
  { readonly ok: false; readonly issues: readonly DomainIssue[] };
export const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
/** Canonical comparison only. This is NOT a blob/fingerprint hash algorithm. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareText(a, b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export const exact = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
export function stableIssues(issues: readonly DomainIssue[]): DomainIssue[] {
  return [...new Map(issues.map((issue) => [canonical(issue), issue])).values()]
    .sort((a, b) => compareText(canonical(a), canonical(b)));
}
export function unique(values: readonly unknown[]): boolean { return new Set(values).size === values.length; }

/** Deterministic SCC cycle reports. Members and components use code-point order. */
export function cyclicComponents(edges: ReadonlyMap<string, readonly string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], active = new Set<string>(), cycles: string[][] = [];
  const visit = (id: string): void => {
    index.set(id, next); low.set(id, next++); stack.push(id); active.add(id);
    for (const child of [...(edges.get(id) ?? [])].sort(compareText)) {
      if (!edges.has(child)) continue;
      if (!index.has(child)) { visit(child); low.set(id, Math.min(low.get(id)!, low.get(child)!)); }
      else if (active.has(child)) low.set(id, Math.min(low.get(id)!, index.get(child)!));
    }
    if (low.get(id) !== index.get(id)) return;
    const component: string[] = [];
    let child: string;
    do { child = stack.pop()!; active.delete(child); component.push(child); } while (child !== id);
    component.sort(compareText);
    if (component.length > 1 || edges.get(id)?.includes(id)) cycles.push(component);
  };
  for (const id of [...edges.keys()].sort(compareText)) if (!index.has(id)) visit(id);
  return cycles.sort((a, b) => compareText(canonical(a), canonical(b)));
}
