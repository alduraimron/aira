import { hashCanonical } from "../canonical-json";
import { freeze } from "../workspace/domain";

/** Changing parsing, coverage, exclusions or a bound requires a new policy version. */
const subject = {
  schema: "aira.dev/workspace-git-inspection/v1" as const,
  protocol: "git-porcelain-v2-z-diff-index-cached-raw-z-no-renames-ls-files-stage-z" as const,
  index: "stage-0-oid-mode-diff-index-cached-separate-from-worktree;unmerged-reject" as const,
  tracked: "status-v2-index-and-worktree-separate" as const,
  untracked: "ls-files-others-exclude-standard-individual-files" as const,
  ignored: "ls-files-others-ignored-exclude-standard-individual-files" as const,
  submodules: "reject-gitlinks-and-gitmodules" as const,
  sparse: "reject" as const,
  paths: "nul-utf8-exact-path-reject-aliases" as const,
  exclusions: [".aira", ".git"] as const,
  bounds: { timeout_ms: 10000, stdout_bytes: 32 * 1024 * 1024, stderr_bytes: 64 * 1024,
    index_bytes: 64 * 1024 * 1024, max_paths: 250000, max_untracked: 250000,
    max_ignored: 250000, max_submodules: 10000, max_path_bytes: 4096 },
};
export const gitInspectionPolicy = freeze({ ...subject, hash: hashCanonical(subject) });
export type GitInspectionPolicy = typeof gitInspectionPolicy;
