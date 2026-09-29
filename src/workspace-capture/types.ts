import type { ContentHash } from "../spec/domain/primitives";
import type { WorkspaceHandleV2 } from "../workspace/handle";
import type { WorkspaceFingerprintV2, WorkspaceFingerprintPolicy } from "../workspace/fingerprint-v2";
import type { SourceObservation } from "../workspace/source";
import type { GitObservation, GitInspection } from "../workspace-git/types";
import type { LocalTreeCapture } from "../workspace-local/types";

export type CaptureIssueCode = "workspace-capture-git-local-mismatch" | "workspace-capture-path-unclassified" |
  "workspace-capture-path-missing" | "workspace-capture-type-mismatch" | "workspace-capture-index-mismatch" |
  "workspace-capture-mode-mismatch" | "workspace-capture-overlay-incomplete" |
  "workspace-capture-source-incomplete" | "workspace-capture-git-unstable" |
  "workspace-capture-policy-incompatible" | "workspace-capture-unsupported" |
  "workspace-capture-fingerprint-incomplete" | "workspace-capture-invalid-input";
export interface CaptureIssue { readonly code: CaptureIssueCode; readonly path?: string; readonly detail?: string }
export interface ClosureReport {
  readonly schema: "aira.dev/workspace-git-local-closure/v1";
  readonly counts: { readonly tracked: number; readonly staged: number; readonly tracked_dirty: number;
    readonly untracked: number; readonly ignored: number; readonly deletions: number; readonly local_only: number };
  readonly local_only: readonly string[]; readonly excluded: readonly string[];
  readonly unsupported: readonly string[]; readonly mismatches: readonly CaptureIssue[];
}
export type CaptureStatus = "complete" | "incomplete" | "incompatible" | "unstable" | "unsupported" | "invalid-input";
export interface GitWorkspaceCapture {
  readonly schema: "aira.dev/workspace-git-capture/v1"; readonly status: CaptureStatus;
  readonly git_before?: GitObservation; readonly git_after?: GitObservation;
  readonly local?: LocalTreeCapture; readonly report: ClosureReport;
  readonly source?: SourceObservation; readonly fingerprint?: WorkspaceFingerprintV2;
  readonly diagnostics: readonly CaptureIssue[];
}
/** A host assertion of uninterrupted quiescence. Neither adapter nor this value mints ownership. */
export interface QuiescenceEvidence {
  readonly schema: "aira.dev/workspace-capture-quiescence/v1";
  readonly token: string; readonly held: true;
}
export interface CaptureGitSourceInput {
  readonly executionRoot: string; readonly controlRoot: string;
  readonly relationship: "same-root" | "separate-root";
  readonly controlProject: GitObservation["subject"]["control_project"];
  readonly project: GitObservation["subject"]["project"];
  readonly registeredRootAssociation: ContentHash;
  readonly provider: SourceObservation["subject"]["provider"];
  readonly capturePolicy: WorkspaceFingerprintPolicy;
  readonly audit: SourceObservation["audit"];
  /** Caller-controlled host coordination; changing token/losing quiescence fails closed. */
  readonly observeQuiescence?: () => Promise<QuiescenceEvidence>;
}
export interface CaptureGitWorkspaceInput {
  readonly handle: WorkspaceHandleV2 | unknown;
  readonly executionRoot: string;
  readonly observeQuiescence?: () => Promise<QuiescenceEvidence>;
  /** Required for separate roots; must independently re-observe the registered control source. */
  readonly observeReviewedSource?: () => Promise<SourceObservation | unknown>;
}
export interface ComposeGitWorkspaceInput {
  readonly handle?: WorkspaceHandleV2 | unknown;
  readonly git_before: GitObservation | unknown;
  readonly git_after: GitObservation | unknown;
  readonly local: LocalTreeCapture | unknown;
  readonly capture_policy: WorkspaceFingerprintPolicy | unknown;
  readonly provider: SourceObservation["subject"]["provider"] | unknown;
  readonly audit: SourceObservation["audit"] | unknown;
  /** Explicit trusted host proof; Git/local agreement alone never establishes it. */
  readonly quiescence?: QuiescenceEvidence | unknown;
  readonly reviewed_source_before?: SourceObservation | unknown;
  readonly reviewed_source_after?: SourceObservation | unknown;
}
export interface CaptureHooks {
  readonly afterGitBefore?: () => Promise<void> | void;
  readonly afterLocal?: () => Promise<void> | void;
  readonly local?: { readonly afterFileOpen?: (logical: string) => Promise<void> | void;
    readonly beforeFinalCheck?: () => Promise<void> | void };
}
export interface AdapterPair {
  readonly git: (options: import("../workspace-git/types").InspectGitOptions) => Promise<GitInspection>;
  readonly local: (options: import("../workspace-local/types").InspectLocalTreeOptions,
    hooks?: import("../workspace-local/inspect").InspectionTestHooks) => Promise<LocalTreeCapture>;
}
