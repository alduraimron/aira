import { hashCanonical } from "../canonical-json";
import type { z } from "zod";
import { createdMetadataSchema } from "../spec/domain/primitives";
import { createSourceObservation, type DirtyPolicy, type SourceObservation } from "../workspace/source";
import type { WorkspaceProviderDescriptor } from "../workspace/provider";
import { gitInspectionPolicy } from "./policy";
import { gitObservationSchema } from "./observation";
import { gitIsClean, gitOverlayDescriptor } from "./comparison";
import type { GitIssue, GitObservation } from "./types";

/** Provisional read-only source semantics; no retained overlay bytes or preparation authority. */
export function gitSourceObservation(observation: GitObservation, provider: WorkspaceProviderDescriptor,
  audit: z.input<typeof createdMetadataSchema>): SourceObservation {
  const s = gitObservationSchema.parse(observation).subject;
  if (s.state !== "normal" || !s.base_commit || s.policy_hash !== gitInspectionPolicy.hash)
    throw new Error("workspace-git-policy-incompatible");
  const clean = gitIsClean(observation), overlay = gitOverlayDescriptor(observation);
  return createSourceObservation({ subject: {
    schema: "aira.dev/workspace-source-observation-subject/v1",
    control_project: s.control_project, project: s.project, registered_root_association: s.registered_root_association,
    provider, inspection_policy: { schema: "aira.dev/workspace-source-inspection/v1",
      hash: hashCanonical({ schema: "aira.dev/workspace-git-source-policy/v1", git: s.policy_hash, capture: s.capture_policy_hash }) },
    source: { kind: "git", repository: s.repository,
      base: { kind: "git", repository: s.repository, object_format: s.object_format, commit: s.base_commit },
      head: { kind: s.head.kind === "attached" ? "attached" : "detached" }, worktree: s.worktree, state: "normal",
      submodule_policy: { schema: "aira.dev/workspace-submodules/reject/v1", observations: [] } },
    overlay: clean ? { kind: "none" } : { kind: "observed", ...overlay },
    dirty_state: clean ? "clean" : "dirty", consistency: "unknown",
  }, audit, ...(s.head.kind === "attached" ? { diagnostics: { git_branch: s.head.ref } } : {}) });
}
/** Caller intent is never chosen or rewritten by observation. Overlay reproduction remains unproven. */
export function gitDirtyPolicyIssues(observation: GitObservation, policy: DirtyPolicy,
  topology: "in-place" | "isolated-local" | "copied-snapshot"): readonly GitIssue[] {
  const clean = gitIsClean(observation);
  if (policy === "require-clean" && !clean || policy === "base-only" && !clean && topology === "in-place")
    return [{ code: "workspace-git-policy-incompatible", detail: "dirty-policy-unsatisfied" }];
  return [];
}
