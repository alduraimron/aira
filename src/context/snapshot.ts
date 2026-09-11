import { z } from "zod";
import { contextDeclarationIdSchema, contextSnapshotIdSchema, taskIdSchema, workspaceIdSchema } from "../spec/domain/ids";
import { contentHashSchema, nonBlankSchema, profileReferenceSchema, safeUnsignedSchema, timestampSchema, unique,
  compareText, stableIssues, type DomainIssue, type DeepReadonly } from "../spec/domain/primitives";
import { workspaceFingerprintSchema } from "../workspace/schema";
import { contextPhaseSchema, exactPathSchema, matchesPath, type ContextDeclaration } from "./declarations";
export const contextSnapshotReferenceSchema = z.strictObject({ id: contextSnapshotIdSchema, hash: contentHashSchema });
export const contextSnapshotEntrySchema = z.strictObject({
  logical_path: exactPathSchema, canonical_path_identity: nonBlankSchema,
  content_hash: contentHashSchema, byte_size: safeUnsignedSchema, order: safeUnsignedSchema,
  inclusion: z.enum(["inline", "reference", "summary"]),
  classification: z.enum(["public", "internal", "confidential", "secret", "untrusted"]),
  reasons: z.array(z.strictObject({ declaration: contextDeclarationIdSchema, description: nonBlankSchema })).min(1),
  source: z.strictObject({ identity: nonBlankSchema, revision: nonBlankSchema, original_hash: contentHashSchema }).optional(),
}).refine((e) => e.inclusion !== "summary" || e.source !== undefined, "summary-source-required");
export const contextSnapshotSchema = z.strictObject({
  schema: z.literal("aira.dev/context-snapshot/v1"), id: contextSnapshotIdSchema,
  workspace_id: workspaceIdSchema, fingerprint: workspaceFingerprintSchema,
  resolver: profileReferenceSchema, resolver_policy: profileReferenceSchema,
  phase: contextPhaseSchema, task: taskIdSchema.optional(), at: timestampSchema,
  ordering: z.literal("logical-path-codepoint"), entries: z.array(contextSnapshotEntrySchema), total_bytes: safeUnsignedSchema,
}).refine((s) => s.workspace_id === s.fingerprint.workspace_id &&
  s.entries.every((entry, i) => entry.order === i && (i === 0 || compareText(s.entries[i - 1]!.logical_path, entry.logical_path) < 0)) &&
  unique(s.entries.map((e) => e.logical_path)) &&
  s.entries.reduce((total, e) => total + BigInt(e.byte_size), 0n) === BigInt(s.total_bytes), "invalid-snapshot-order-or-size");
export type ContextSnapshot = DeepReadonly<z.infer<typeof contextSnapshotSchema>>;
export function validateSnapshotDeclarations(snapshot: ContextSnapshot, declarations: readonly ContextDeclaration[]): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const selected = declarations.filter((d) => d.phases.includes(snapshot.phase) &&
    (d.tasks.kind === "all" || (snapshot.task !== undefined && d.tasks.ids.includes(snapshot.task))));
  for (const declaration of selected) {
    const entries = snapshot.entries.filter((entry) => entry.reasons.some((r) => r.declaration === declaration.id));
    if (declaration.required && entries.length === 0) issues.push({ code: "required-context-missing", subject: declaration.id });
    if (entries.reduce((n, e) => n + BigInt(e.byte_size), 0n) > BigInt(declaration.max_bytes))
      issues.push({ code: "context-size-exceeded", subject: declaration.id });
    for (const entry of entries) if (!matchesPath(declaration.selector, entry.logical_path) ||
      entry.inclusion !== declaration.inclusion || entry.classification !== declaration.classification)
      issues.push({ code: "context-declaration-mismatch", subject: entry.logical_path, related: [declaration.id] });
  }
  for (const entry of snapshot.entries) for (const reason of entry.reasons)
    if (!selected.some((d) => d.id === reason.declaration)) issues.push({ code: "unknown-context-declaration", subject: reason.declaration });
  return stableIssues(issues);
}
