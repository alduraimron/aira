import { hashCanonical } from "../canonical-json";
import { freeze } from "../workspace/domain";

/** Fixed v1 operational limits. Changing any of these changes the inspection-policy identity. */
const subject = {
  schema: "aira.dev/workspace-local-inspection/v1" as const,
  traversal: "iterative-no-follow-same-device-ancestor-rechecks" as const,
  paths: "exact-path-utf8-reject-aliases" as const,
  hashing: "sha256-stream-65536" as const,
  executable: "posix-any-0111" as const,
  symlinks: "raw-target-bytes-no-follow" as const,
  empty_directories: "policy-visible-empty" as const,
  exclusions: "pinned-capture-policy-exact-subtrees" as const,
  bounds: { max_depth: 64, max_directory_entries: 50000, max_total_entries: 250000,
    max_path_bytes: 4096, max_manifest_entries: 250000, max_hashed_bytes: 16 * 1024 * 1024 * 1024,
    max_symlink_target_bytes: 16384 },
};
export const localInspectionPolicy = freeze({ ...subject, hash: hashCanonical(subject) });
export type LocalInspectionPolicy = typeof localInspectionPolicy;

export type ExclusionReason = "control-state" | "git-metadata" | "declared-provider-cache";
/** Exact subtree matching, not .gitignore matching or a case-insensitive skip. */
export function excludedByPolicy(path: string, exclusions: readonly { readonly path: string; readonly reason: ExclusionReason }[]): ExclusionReason | undefined {
  return exclusions.find((item) => path === item.path || path.startsWith(`${item.path}/`))?.reason;
}
