import { z } from "zod";
import { hashCanonical } from "../canonical-json";
import { createdMetadataSchema, exact, compareText } from "../spec/domain/primitives";
import { freeze } from "../workspace/domain";
import { validateWorkspaceHandle } from "../workspace/handle";
import { createSourceObservation, sourceObservationSchema, type SourceObservation } from "../workspace/source";
import { createWorkspaceFingerprint, fingerprintHandleIssues, workspacePathManifestV2Schema } from "../workspace/fingerprint-v2";
import { workspaceProviderDescriptorSchema } from "../workspace/provider";
import type { GitObservation } from "../workspace-git/types";
import type { LocalTreeObservation } from "../workspace-local/types";
import type { WorkspaceFingerprintPolicy } from "../workspace/fingerprint-v2";
import { coherentInputs, closeGitPaths, report, type ClosedPaths } from "./coherence";
import type { ComposeGitWorkspaceInput, CaptureIssue, CaptureStatus, GitWorkspaceCapture, QuiescenceEvidence } from "./types";

const quiescenceSchema = z.strictObject({ schema: z.literal("aira.dev/workspace-capture-quiescence/v1"),
  token: z.string().min(1).max(256), held: z.literal(true) });
const diagnostic = (code: CaptureIssue["code"], detail?: string): CaptureIssue =>
  ({ code, ...(detail ? { detail } : {}) });
function createResult(status: CaptureStatus, diagnostics: readonly CaptureIssue[], extras: Partial<GitWorkspaceCapture> = {}): GitWorkspaceCapture {
  return freeze({ schema: "aira.dev/workspace-git-capture/v1" as const, status,
    report: extras.report ?? report(), diagnostics: [...diagnostics],
    ...(extras.git_before ? { git_before: extras.git_before } : {}),
    ...(extras.git_after ? { git_after: extras.git_after } : {}),
    ...(extras.local ? { local: extras.local } : {}),
    ...(extras.source ? { source: extras.source } : {}),
    ...(extras.fingerprint ? { fingerprint: extras.fingerprint } : {}),
  });
}
function byteCompleteSource(input: {
  git: GitObservation; tree: LocalTreeObservation; policy: WorkspaceFingerprintPolicy;
  closed: ClosedPaths; provider: SourceObservation["subject"]["provider"];
  audit: SourceObservation["audit"]; consistency: "stable" | "unknown";
}): SourceObservation {
  const { git, tree, policy, closed } = input, s = git.subject;
  const manifestSubject = { schema: "aira.dev/workspace-path-manifest/v2", entries: closed.entries };
  const manifestHash = hashCanonical(manifestSubject);
  if (!workspacePathManifestV2Schema.safeParse({ ...manifestSubject, hash: manifestHash }).success)
    throw new Error("invalid-git-path-manifest");
  const source = { kind: "git" as const, repository: s.repository,
    base: { kind: "git" as const, repository: s.repository, object_format: s.object_format, commit: s.base_commit! },
    head: { kind: s.head.kind === "attached" ? "attached" as const : "detached" as const },
    worktree: s.worktree, state: "normal" as const,
    submodule_policy: { schema: "aira.dev/workspace-submodules/reject/v1" as const, observations: [] },
    byte_closure: { schema: "aira.dev/workspace-git-byte-closure/v1" as const,
      status: "byte-complete" as const, git_observation_hash: git.hash, local_tree_hash: tree.hash,
      git_policy_hash: s.policy_hash, local_policy_hash: tree.policy_hash,
      capture_policy_hash: policy.hash, manifest_hash: manifestHash },
  };
  const overlay = closed.overlay.dirty ? { kind: "observed" as const,
    manifest_hash: closed.overlay.manifest_hash, staged: closed.overlay.staged, tracked: closed.overlay.tracked,
    untracked: closed.overlay.untracked, ignored: closed.overlay.ignored,
    exclusions: [...closed.overlay.exclusions].sort(compareText) } : { kind: "none" as const };
  return createSourceObservation({ subject: {
    schema: "aira.dev/workspace-source-observation-subject/v1", control_project: s.control_project,
    project: s.project, registered_root_association: s.registered_root_association,
    provider: input.provider,
    inspection_policy: { schema: "aira.dev/workspace-source-inspection/v1",
      hash: hashCanonical({ schema: "aira.dev/workspace-git-source-policy/v2", git: s.policy_hash,
        local: tree.policy_hash, capture: policy.hash, closure: source.byte_closure.schema }) },
    source, overlay, dirty_state: closed.overlay.dirty ? "dirty" : "clean", consistency: input.consistency,
  }, audit: input.audit, ...(s.head.kind === "attached" ? { diagnostics: { git_branch: s.head.ref } } : {}) });
}
/** Pure source bootstrap. A source may be byte-complete yet consistency-unknown without trusted quiescence. */
export function composeGitWorkspaceSource(input: ComposeGitWorkspaceInput): GitWorkspaceCapture {
  return compose(input, false);
}
/** Pure fingerprint composition. Both Git brackets and a complete, exact handle source are mandatory. */
export function composeGitWorkspaceFingerprint(input: ComposeGitWorkspaceInput): GitWorkspaceCapture {
  return compose(input, true);
}
function compose(input: ComposeGitWorkspaceInput, requireHandle: boolean): GitWorkspaceCapture {
  const coherent = coherentInputs(input?.git_before, input?.git_after, input?.local, input?.capture_policy);
  if (!coherent.ok) return createResult(coherent.status, [coherent.issue]);
  const { before, after, local, policy } = coherent.value;
  const context = { git_before: before, git_after: after, local };
  const provider = workspaceProviderDescriptorSchema.safeParse(input.provider), audit = createdMetadataSchema.safeParse(input.audit);
  if (!provider.success || !audit.success) return createResult("invalid-input", [diagnostic("workspace-capture-invalid-input", "provider-or-audit")], context);
  const h = requireHandle ? validateWorkspaceHandle(input.handle) : undefined;
  if (requireHandle && (!h || !h.ok)) return createResult("invalid-input", [diagnostic("workspace-capture-invalid-input", "handle")], context);
  const closed = closeGitPaths(before, local.tree, policy);
  const full = { ...context, report: closed.report };
  if (closed.report.mismatches.length) return createResult("incomplete", closed.report.mismatches, full);
  const q = quiescenceSchema.safeParse(input.quiescence);
  let source: SourceObservation;
  try { source = byteCompleteSource({ git: before, tree: local.tree, policy, closed,
    provider: provider.data, audit: audit.data, consistency: q.success ? "stable" : "unknown" }); }
  catch { return createResult("incomplete", [diagnostic("workspace-capture-source-incomplete")], full); }
  if (!q.success) return createResult("incomplete", [diagnostic("workspace-capture-source-incomplete", "trusted-quiescence-required")],
    { ...full, source });
  if (!requireHandle) return createResult("complete", [], { ...full, source });
  const handle = h!.ok ? h!.value : undefined;
  if (!handle) return createResult("invalid-input", [diagnostic("workspace-capture-invalid-input", "handle")], full);
  const reviewed = handle.source.subject.source, execution = source.subject.source;
  if (handle.roots.execution.kind !== "local-absolute" || handle.roots.execution.path !== before.audit.root ||
      handle.repository !== before.subject.repository || handle.project !== before.subject.project ||
      handle.control_project !== before.subject.control_project || !exact(handle.provider, provider.data) ||
      !exact(handle.fingerprint_policy, policy) ||
      handle.source.subject.registered_root_association !== before.subject.registered_root_association ||
      reviewed.kind !== "git" || reviewed.base.kind !== "git" || execution.kind !== "git" ||
      reviewed.base.commit !== before.subject.base_commit ||
      reviewed.base.object_format !== before.subject.object_format ||
      reviewed.byte_closure?.status !== "byte-complete")
    return createResult("incompatible", [diagnostic("workspace-capture-source-incomplete", "handle-source-or-base")], { ...full, source });
  if (handle.roots.relationship === "same-root") {
    if (handle.source.id !== source.id || !exact(handle.source.subject, source.subject))
      return createResult("incompatible", [diagnostic("workspace-capture-source-incomplete", "reviewed-source-stale")], { ...full, source });
  } else {
    const left = sourceObservationSchema.safeParse(input.reviewed_source_before);
    const right = sourceObservationSchema.safeParse(input.reviewed_source_after);
    if (!left.success || !right.success || left.data.id !== handle.source.id || right.data.id !== handle.source.id ||
        !exact(left.data.subject, handle.source.subject) || !exact(right.data.subject, handle.source.subject))
      return createResult("incomplete", [diagnostic("workspace-capture-source-incomplete", "registered-source-freshness-unproven")], { ...full, source });
  }
  const dirty = closed.overlay.dirty, reviewedOverlay = handle.source.subject.overlay;
  const executionOverlay = source.subject.overlay;
  if (handle.dirty_policy === "require-clean" && dirty ||
      handle.dirty_policy === "base-only" && dirty ||
      handle.dirty_policy === "include-observed-overlay" && (!dirty ||
        reviewedOverlay.kind !== "observed" || executionOverlay.kind !== "observed" ||
        reviewed.kind !== "git" || execution.kind !== "git" ||
        reviewed.byte_closure?.manifest_hash !== execution.byte_closure?.manifest_hash ||
        reviewedOverlay.kind === "observed" && executionOverlay.kind === "observed" &&
          reviewedOverlay.manifest_hash !== executionOverlay.manifest_hash))
    return createResult("incompatible", [diagnostic("workspace-capture-overlay-incomplete", "dirty-intent-vs-execution-tree")], { ...full, source });
  let fingerprint;
  try {
    fingerprint = createWorkspaceFingerprint({ binding: {
      control_project: handle.control_project, workspace_id: handle.id, incarnation: handle.incarnation,
      project: handle.project, repository: handle.repository, provider: handle.provider,
      source_observation: handle.source.id,
      base: { kind: "git", repository: before.subject.repository,
        object_format: before.subject.object_format, commit: before.subject.base_commit! },
      policy: handle.fingerprint_policy,
    }, entries: closed.entries, manifest_schema: "aira.dev/workspace-path-manifest/v2",
      repository_components: closed.repository_components });
  } catch { return createResult("incomplete", [diagnostic("workspace-capture-fingerprint-incomplete")], { ...full, source }); }
  if (fingerprint.subject.manifest.hash !== (execution.kind === "git" ? execution.byte_closure?.manifest_hash : undefined) ||
      fingerprintHandleIssues(fingerprint, handle).length)
    return createResult("incompatible", [diagnostic("workspace-capture-fingerprint-incomplete", "binding-mismatch")], { ...full, source });
  return createResult("complete", [], { ...full, source, fingerprint });
}
