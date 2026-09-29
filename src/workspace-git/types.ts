import type { ContentHash } from "../spec/domain/primitives";
import type { ControlProjectId, ProjectIdentity, RepositoryIdentity } from "../workspace/ids";
import type { WorkspaceFingerprintPolicy } from "../workspace/fingerprint-v2";
import type { GitInspectionPolicy } from "./policy";

export type GitIssueCode =
  | "workspace-git-not-repository" | "workspace-git-root-mismatch" | "workspace-git-bare-unsupported"
  | "workspace-git-unborn-unsupported" | "workspace-git-head-invalid" | "workspace-git-sparse-unsupported"
  | "workspace-git-partial-unsupported" | "workspace-git-submodule-unsupported"
  | "workspace-git-nested-repository" | "workspace-git-unmerged-unsupported" | "workspace-git-path-unsupported"
  | "workspace-git-command-failed" | "workspace-git-output-limit" | "workspace-git-timeout"
  | "workspace-git-state-changed" | "workspace-git-index-changed" | "workspace-git-policy-incompatible";
export interface GitIssue { readonly code: GitIssueCode; readonly path?: string; readonly detail?: string }
export type GitObjectFormat = "sha1" | "sha256";
export type GitMode = "100644" | "100755" | "120000" | "160000";
export interface GitEntry { readonly path: string; readonly mode: GitMode; readonly oid: string }
export type ChangeKind = "addition" | "modification" | "deletion" | "mode-change" | "type-change" | "rename" | "copy";
export interface GitChange {
  readonly path: string; readonly kind: ChangeKind; readonly from?: string;
  readonly before?: { readonly mode: GitMode; readonly oid?: string };
  readonly after?: { readonly mode: GitMode; readonly oid?: string };
}
export type GitHead = { readonly kind: "attached"; readonly ref: string; readonly commit: string } |
  { readonly kind: "detached"; readonly commit: string } | { readonly kind: "unborn"; readonly ref: string } |
  { readonly kind: "invalid" };
export interface GitObservationSubject {
  readonly schema: "aira.dev/workspace-git-observation-subject/v1";
  readonly control_project: ControlProjectId; readonly project: ProjectIdentity;
  readonly registered_root_association: ContentHash;
  readonly repository: RepositoryIdentity;
  readonly worktree: { readonly kind: "main" | "linked"; readonly identity: ContentHash };
  readonly object_format: GitObjectFormat; readonly head: GitHead; readonly base_commit?: string;
  readonly state: "normal" | "unborn" | "bare" | "sparse" | "partial" | "unmerged-index" | "submodules" | "nested-repository";
  readonly index: readonly GitEntry[]; readonly staged: readonly GitChange[];
  readonly tracked: readonly GitChange[]; readonly untracked: readonly string[]; readonly ignored: readonly string[];
  readonly submodules: readonly GitEntry[];
  readonly exclusions: { readonly paths: readonly string[] };
  readonly policy_hash: ContentHash; readonly capture_policy_hash: ContentHash;
}
export interface GitObservation {
  readonly schema: "aira.dev/workspace-git-observation/v1";
  readonly subject: GitObservationSubject; readonly hash: ContentHash;
  readonly audit: { readonly root: string; readonly git_dir: string; readonly common_dir: string;
    readonly index_byte_hash: ContentHash | "absent"; readonly tracked_aira: readonly string[];
    readonly started_at: string; readonly ended_at: string };
}
export interface GitInspection {
  readonly status: "complete" | "unsupported" | "not-repository" | "unstable";
  readonly policy: GitInspectionPolicy; readonly observation?: GitObservation; readonly diagnostics: readonly GitIssue[];
}
export interface InspectGitOptions {
  /** Exact trusted execution root. No parent discovery, path rewriting or registration occurs. */
  readonly executionRoot: string;
  readonly controlProject: ControlProjectId; readonly project: ProjectIdentity;
  readonly registeredRootAssociation: ContentHash;
  readonly capturePolicy: WorkspaceFingerprintPolicy;
}
/** Trusted test instrumentation, not a public command execution interface. */
export interface GitInspectionHooks {
  readonly afterAnchor?: () => Promise<void> | void;
  readonly beforeFinalAnchor?: () => Promise<void> | void;
}
