import { exact } from "../spec/domain/primitives";
import { createWorkspaceFingerprint, fingerprintHandleIssues, type WorkspaceFingerprintV2 } from "../workspace/fingerprint-v2";
import type { WorkspaceHandleV2 } from "../workspace/handle";
import { snapshotManifest } from "./manifest";
import type { LocalTreeObservation, SnapshotEvidence } from "./types";

/** Git cannot be completed here: index/tree/classification are not filesystem facts. */
export async function constructLocalFingerprint(handle: WorkspaceHandleV2, tree: LocalTreeObservation,
  evidence?: SnapshotEvidence): Promise<WorkspaceFingerprintV2 | undefined> {
  const source = handle.source.subject.source;
  if (source.kind !== "snapshot" || source.base.kind !== "snapshot" || !evidence || evidence.kind !== "snapshot" ||
      handle.dirty_policy === "include-observed-overlay" || handle.source.subject.overlay.kind !== "none" ||
      handle.source.subject.dirty_state !== "clean") return undefined;
  // A clean in-place tree uses the same versioned local-tree digest in the reviewed source observation.
  // No source observer may silently assign a digest for another algorithm.
  if (handle.roots.relationship === "same-root" && source.observed_tree !== tree.hash) return undefined;
  const entries = snapshotManifest(tree, evidence);
  if (!entries || tree.policy_hash === undefined || tree.capture_policy_hash !== handle.fingerprint_policy.hash) return undefined;
  try {
    const verifiedBefore = await evidence.verifyRetainedBase();
    if (!exact(verifiedBefore, source.base)) return undefined;
    const fingerprint = createWorkspaceFingerprint({ binding: {
      control_project: handle.control_project, workspace_id: handle.id, incarnation: handle.incarnation,
      project: handle.project, provider: handle.provider, source_observation: handle.source.id,
      base: source.base, policy: handle.fingerprint_policy,
    }, entries, repository_components: [] });
    const verifiedAfter = await evidence.verifyRetainedBase();
    if (!exact(verifiedAfter, source.base) || fingerprintHandleIssues(fingerprint, handle).length) return undefined;
    return fingerprint;
  } catch { return undefined; }
}
