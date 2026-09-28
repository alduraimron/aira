import type { ContentHash, DeepReadonly } from "../spec/domain/primitives";
import type { z } from "zod";
import { workspacePathStateSchema, type WorkspaceFingerprintV2 } from "../workspace/fingerprint-v2";
type WorkspacePathState = z.infer<typeof workspacePathStateSchema>;
import type { WorkspaceHandleV2 } from "../workspace/handle";
import type { SourceObservation } from "../workspace/source";
import type { LocalInspectionPolicy, ExclusionReason } from "./policy";

export type LocalPathState = Extract<WorkspacePathState, { kind: "regular" | "symlink" | "empty-directory" }>;
export interface LocalTreeEntry { readonly path: string; readonly state: LocalPathState }
export interface LocalTreeObservation {
  readonly schema: "aira.dev/workspace-local-tree/v1";
  readonly policy_hash: ContentHash;
  readonly capture_policy_hash: ContentHash;
  readonly entries: readonly LocalTreeEntry[];
  /** SHA-256 of canonical JSON over the four fields above except hash itself. */
  readonly hash: ContentHash;
}
export type InspectionIssueCode =
  | "workspace-inspection-root-invalid" | "workspace-inspection-root-unsafe" | "workspace-inspection-root-changed"
  | "workspace-inspection-entry-unsafe" | "workspace-inspection-entry-changed" | "workspace-inspection-nonregular"
  | "workspace-inspection-depth-limit" | "workspace-inspection-entry-limit" | "workspace-inspection-byte-budget"
  | "workspace-inspection-path-invalid" | "workspace-inspection-policy-incompatible"
  | "workspace-inspection-incomplete" | "workspace-inspection-fingerprint-incomplete";
export interface InspectionIssue { readonly code: InspectionIssueCode; readonly path: string; readonly detail?: string }
export interface RootAudit { readonly path: string; readonly device: string; readonly inode: string }
export interface WorkspaceLocalInspection {
  readonly schema: "aira.dev/workspace-local-inspection-result/v1";
  readonly policy: LocalInspectionPolicy;
  readonly workspace_id: string;
  readonly incarnation: string;
  readonly root?: RootAudit;
  /** Completeness of the local filesystem walk, independent of Git/snapshot evidence. */
  readonly status: "complete" | "incomplete";
  readonly fingerprint_status: "constructed" | "incomplete";
  /** Partial entries are diagnostics only; never use as an exact fingerprint. */
  readonly tree?: LocalTreeObservation;
  readonly excluded: readonly { readonly path: string; readonly reason: ExclusionReason }[];
  readonly rejected: readonly string[];
  readonly diagnostics: readonly InspectionIssue[];
  /** Constructed means exact v2 structure under trusted supplied evidence, NOT an atomic snapshot or verifier-stable interval. */
  readonly fingerprint?: WorkspaceFingerprintV2;
}
export interface SnapshotEvidence {
  readonly kind: "snapshot";
  /** Explicit, exhaustive provider classification; no Git classification is inferred from paths. */
  readonly categories: readonly { readonly path: string; readonly category: "tracked" | "untracked" | "ignored" }[];
  /** Trusted caller checks retained manifest AND bytes, returning the verified exact base. This adapter never retains bytes. */
  readonly verifyRetainedBase: () => Promise<SourceObservation["subject"]["source"]["base"]>;
}
export interface InspectWorkspaceLocalOptions {
  readonly handle: WorkspaceHandleV2 | unknown;
  readonly executionRoot: string;
  /** Trusted source observer must freshly re-observe the registered source before AND after the scan. */
  readonly observeSource: () => Promise<SourceObservation | unknown>;
  readonly snapshotEvidence?: SnapshotEvidence;
}
export type FrozenInspection = DeepReadonly<WorkspaceLocalInspection>;
