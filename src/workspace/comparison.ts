import { exact, stableIssues, type DomainIssue } from "../spec/domain/primitives";
import { workspaceFingerprintV2Schema, type WorkspaceFingerprintV2 } from "./fingerprint-v2";
import { sourceObservationSchema, dirtyPolicySchema } from "./source";

export type FingerprintComparisonStatus = "identical" | "changed" | "incompatible-policy" |
  "different-workspace" | "different-incarnation" | "different-base" | "invalid-input";
export interface FingerprintComparison {
  readonly status: FingerprintComparisonStatus;
  readonly reasons: readonly DomainIssue[];
}
/** Both arguments must be self-consistent v2 records. Audit time is not identity. */
export function compareWorkspaceFingerprints(left: unknown, right: unknown): FingerprintComparison {
  const a = workspaceFingerprintV2Schema.safeParse(left), b = workspaceFingerprintV2Schema.safeParse(right);
  if (!a.success || !b.success) return { status: "invalid-input", reasons: [{ code: "workspace-fingerprint-invalid" }] };
  const x = a.data.subject, y = b.data.subject;
  const reasons: DomainIssue[] = [];
  const add = (code: string, subject?: string) => reasons.push({ code, ...(subject ? { subject } : {}) });
  if (x.control_project !== y.control_project || x.workspace_id !== y.workspace_id ||
      x.project !== y.project || x.repository !== y.repository) add("workspace-fingerprint-workspace-mismatch");
  if (x.incarnation !== y.incarnation) add("workspace-fingerprint-incarnation-mismatch");
  if (!exact(x.policy, y.policy)) add("workspace-fingerprint-policy-mismatch");
  if (!exact(x.provider, y.provider)) add("provider-semantics-changed");
  if (!exact(x.base, y.base)) add("base-changed");
  if (x.source_observation !== y.source_observation) add("source-observation-changed");
  for (const category of ["staged", "tracked", "untracked", "ignored"] as const) {
    if (x.state_components.find((c) => c.category === category)?.hash !==
        y.state_components.find((c) => c.category === category)?.hash)
      add(category === "staged" ? "staged-state-changed" : `${category}-content-changed`);
  }
  if (!exact(x.repository_components, y.repository_components)) add("repository-components-changed");
  const paths = new Set([...x.manifest.entries.map((e) => e.path), ...y.manifest.entries.map((e) => e.path)]);
  for (const path of [...paths].sort()) {
    const before = x.manifest.entries.find((e) => e.path === path), after = y.manifest.entries.find((e) => e.path === path);
    if (exact(before, after)) continue;
    if (before?.worktree.state.kind === "symlink" || after?.worktree.state.kind === "symlink") add("symlink-changed", path);
    if (before?.worktree.state.kind === "deleted" || after?.worktree.state.kind === "deleted") add("deletion-changed", path);
    if (before?.worktree.state.kind === "nested-repository" || after?.worktree.state.kind === "nested-repository") add("submodule-changed", path);
    if (before?.worktree.state.kind === "regular" && after?.worktree.state.kind === "regular" &&
        before.worktree.state.executable !== after.worktree.state.executable) add("mode-changed", path);
  }
  const status: FingerprintComparisonStatus = !reasons.length && a.data.digest === b.data.digest &&
    a.data.id === b.data.id ? "identical" :
    reasons.some((r) => r.code === "workspace-fingerprint-workspace-mismatch") ? "different-workspace" :
    reasons.some((r) => r.code === "workspace-fingerprint-incarnation-mismatch") ? "different-incarnation" :
    reasons.some((r) => r.code === "workspace-fingerprint-policy-mismatch" || r.code === "provider-semantics-changed") ? "incompatible-policy" :
    reasons.some((r) => r.code === "base-changed") ? "different-base" : "changed";
  if (status === "changed" && !reasons.length) add("workspace-content-changed");
  return { status, reasons: stableIssues(reasons) };
}
export function sameWorkspaceFingerprintV2(a: WorkspaceFingerprintV2, b: WorkspaceFingerprintV2): boolean {
  return compareWorkspaceFingerprints(a, b).status === "identical";
}
/** This helper only decides fingerprint identity, not evidence stability or run/Spec authority. */
export function workspaceFingerprintApplicable(evidenceFingerprint: unknown, currentFingerprint: unknown): {
  readonly applicable: boolean; readonly reasons: readonly DomainIssue[];
} {
  const comparison = compareWorkspaceFingerprints(evidenceFingerprint, currentFingerprint);
  return { applicable: comparison.status === "identical", reasons: comparison.reasons };
}
export function compareSourceObservations(left: unknown, right: unknown, leftPolicy: unknown, rightPolicy: unknown): {
  readonly status: "identical" | "changed" | "incompatible-policy" | "different-repository" | "different-base" | "invalid-input";
  readonly reasons: readonly DomainIssue[];
} {
  const a = sourceObservationSchema.safeParse(left), b = sourceObservationSchema.safeParse(right);
  const p = dirtyPolicySchema.safeParse(leftPolicy), q = dirtyPolicySchema.safeParse(rightPolicy);
  if (!a.success || !b.success || !p.success || !q.success)
    return { status: "invalid-input", reasons: [{ code: "workspace-source-invalid" }] };
  const x = a.data.subject, y = b.data.subject;
  const reasons: DomainIssue[] = [];
  if (x.control_project !== y.control_project || x.project !== y.project ||
      x.registered_root_association !== y.registered_root_association || x.source.kind !== y.source.kind ||
      (x.source.kind === "git" ? x.source.repository : undefined) !== (y.source.kind === "git" ? y.source.repository : undefined))
    reasons.push({ code: "repository-identity-changed" });
  if (!exact(x.source.base, y.source.base)) reasons.push({ code: "base-changed" });
  if (!exact(x.overlay, y.overlay) || x.dirty_state !== y.dirty_state) reasons.push({ code: "overlay-changed" });
  if (p.data !== q.data) reasons.push({ code: "dirty-policy-incompatible" });
  if (!exact(x.provider, y.provider) || !exact(x.inspection_policy, y.inspection_policy))
    reasons.push({ code: "source-policy-changed" });
  if (!exact(x.source, y.source) && !reasons.length) reasons.push({ code: "source-state-changed" });
  if (x.consistency !== y.consistency) reasons.push({ code: "source-consistency-changed" });
  const status = reasons.some((r) => r.code === "repository-identity-changed") ? "different-repository" :
    reasons.some((r) => r.code === "dirty-policy-incompatible" || r.code === "source-policy-changed") ? "incompatible-policy" :
    reasons.some((r) => r.code === "base-changed") ? "different-base" : reasons.length ? "changed" : "identical";
  return { status, reasons: stableIssues(reasons) };
}
