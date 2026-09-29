import { z } from "zod";
import { hashCanonical } from "../canonical-json";
import { contentHashSchema } from "../spec/domain/primitives";
import { workspacePathStateSchema } from "../workspace/fingerprint-v2";
import { exactPathSchema } from "../context/declarations";
import { compareText } from "../spec/domain/primitives";
import { freeze } from "../workspace/domain";
import type { WorkspaceFingerprintPolicy, WorkspaceManifestEntry } from "../workspace/fingerprint-v2";
import type { LocalInspectionPolicy } from "./policy";
import type { LocalTreeEntry, LocalTreeObservation, SnapshotEvidence } from "./types";

export function validLogicalPath(path: string, maxBytes: number): boolean {
  return path.length <= 4096 && Buffer.byteLength(path, "utf8") <= maxBytes && exactPathSchema.safeParse(path).success &&
    Buffer.from(path, "utf8").toString("utf8") === path;
}
export const aliasKey = (path: string): string => path.normalize("NFC").toLowerCase().normalize("NFC");
/** Exact, canonical local-tree decoder for composition. No bytes are reread. */
export const localTreeObservationSchema = z.strictObject({
  schema: z.literal("aira.dev/workspace-local-tree/v1"), policy_hash: contentHashSchema,
  capture_policy_hash: contentHashSchema,
  entries: z.array(z.strictObject({ path: z.string(), state: workspacePathStateSchema })).max(250000),
  hash: contentHashSchema,
}).superRefine((tree, ctx) => {
  const aliases = new Set<string>();
  for (const [i, entry] of tree.entries.entries()) {
    const alias = aliasKey(entry.path);
    if (!validLogicalPath(entry.path, 4096) || aliases.has(alias) ||
        i > 0 && compareText(tree.entries[i - 1]!.path, entry.path) >= 0 ||
        !["regular", "symlink", "empty-directory"].includes(entry.state.kind))
      ctx.addIssue({ code: "custom", message: "workspace-inspection-path-invalid" });
    aliases.add(alias);
  }
  if (tree.hash !== hashCanonical({ schema: tree.schema, policy_hash: tree.policy_hash,
    capture_policy_hash: tree.capture_policy_hash, entries: tree.entries }))
    ctx.addIssue({ code: "custom", message: "workspace-inspection-incomplete" });
});

export function makeLocalTree(entries: readonly LocalTreeEntry[], inspection: LocalInspectionPolicy,
  capture: WorkspaceFingerprintPolicy): LocalTreeObservation {
  const subject = { schema: "aira.dev/workspace-local-tree/v1" as const, policy_hash: inspection.hash,
    capture_policy_hash: capture.hash, entries: [...entries].sort((a, b) => compareText(a.path, b.path)) };
  return freeze({ ...subject, hash: hashCanonical(subject) });
}

/** A one-to-one externally classified view. A missing or extra category fails closed. */
export function snapshotManifest(tree: LocalTreeObservation, evidence: SnapshotEvidence): readonly WorkspaceManifestEntry[] | undefined {
  if (evidence.categories.length !== tree.entries.length) return undefined;
  const categories = new Map<string, "tracked" | "untracked" | "ignored">();
  for (const item of evidence.categories) {
    if (!validLogicalPath(item.path, 4096) || categories.has(item.path) ||
        !["tracked", "untracked", "ignored"].includes(item.category)) return undefined;
    categories.set(item.path, item.category);
  }
  if (new Set([...categories.keys()].map(aliasKey)).size !== categories.size) return undefined;
  const result: WorkspaceManifestEntry[] = [];
  for (const item of tree.entries) {
    const category = categories.get(item.path);
    if (!category) return undefined;
    result.push({ path: item.path, worktree: { category, state: item.state } });
  }
  return result;
}
