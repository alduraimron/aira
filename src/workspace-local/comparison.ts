import { hashCanonical } from "../canonical-json";
import { compareText } from "../spec/domain/primitives";
import { freeze } from "../workspace/domain";
import { workspacePathStateSchema } from "../workspace/fingerprint-v2";
import { aliasKey, validLogicalPath } from "./manifest";
import type { LocalTreeObservation, WorkspaceLocalInspection } from "./types";

export type DriftCode = "observation-incomplete" | "workspace-changed" | "inspection-policy-changed" |
  "capture-policy-changed" | "root-replaced" | "file-added" | "file-removed" | "content-changed" |
  "symlink-changed" | "executable-changed" | "entry-kind-changed";
export interface DriftReason { readonly code: DriftCode; readonly path?: string }
export interface LocalDrift { readonly status: "match" | "drift" | "incomplete"; readonly reasons: readonly DriftReason[] }
function validTree(tree: LocalTreeObservation | undefined): tree is LocalTreeObservation {
  if (!tree || tree.schema !== "aira.dev/workspace-local-tree/v1" || !Array.isArray(tree.entries)) return false;
  const seen = new Set<string>();
  for (const [i, entry] of tree.entries.entries()) {
    if (!validLogicalPath(entry.path, 4096) || !workspacePathStateSchema.safeParse(entry.state).success ||
        !["regular", "symlink", "empty-directory"].includes(entry.state.kind) ||
        seen.has(aliasKey(entry.path)) || i > 0 && compareText(tree.entries[i - 1]!.path, entry.path) >= 0) return false;
    seen.add(aliasKey(entry.path));
  }
  return tree.hash === hashCanonical({ schema: tree.schema, policy_hash: tree.policy_hash,
    capture_policy_hash: tree.capture_policy_hash, entries: tree.entries });
}
/** Semantic drift plus operational root identity drift. Timestamps are never compared. */
export function compareLocalInspections(reviewed: WorkspaceLocalInspection, current: WorkspaceLocalInspection): LocalDrift {
  if (reviewed.status !== "complete" || current.status !== "complete" || !validTree(reviewed.tree) || !validTree(current.tree) ||
      !reviewed.root || !current.root || reviewed.fingerprint && !current.fingerprint)
    return freeze({ status: "incomplete" as const, reasons: [{ code: "observation-incomplete" as const }] });
  const reasons: DriftReason[] = [];
  if (reviewed.workspace_id !== current.workspace_id || reviewed.incarnation !== current.incarnation)
    reasons.push({ code: "workspace-changed" });
  if (reviewed.tree.policy_hash !== current.tree.policy_hash) reasons.push({ code: "inspection-policy-changed" });
  if (reviewed.tree.capture_policy_hash !== current.tree.capture_policy_hash) reasons.push({ code: "capture-policy-changed" });
  if (reviewed.root.path !== current.root.path || reviewed.root.device !== current.root.device || reviewed.root.inode !== current.root.inode)
    reasons.push({ code: "root-replaced" });
  const left = new Map(reviewed.tree.entries.map((entry) => [entry.path, entry.state]));
  const right = new Map(current.tree.entries.map((entry) => [entry.path, entry.state]));
  for (const path of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(path), b = right.get(path);
    if (!a) { reasons.push({ code: "file-added", path }); continue; }
    if (!b) { reasons.push({ code: "file-removed", path }); continue; }
    if (a.kind !== b.kind) { reasons.push({ code: "entry-kind-changed", path }); continue; }
    if (a.kind === "regular" && b.kind === "regular") {
      if (a.hash !== b.hash || a.bytes !== b.bytes) reasons.push({ code: "content-changed", path });
      if (a.executable !== b.executable) reasons.push({ code: "executable-changed", path });
    } else if (a.kind === "symlink" && b.kind === "symlink" &&
      (a.target_hash !== b.target_hash || a.target_bytes !== b.target_bytes)) reasons.push({ code: "symlink-changed", path });
  }
  const sorted = reasons.sort((a, b) => compareText(a.path ?? "", b.path ?? "") || compareText(a.code, b.code));
  return freeze({ status: sorted.length ? "drift" as const : "match" as const, reasons: sorted });
}
