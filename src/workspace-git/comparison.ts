import { hashCanonical } from "../canonical-json";
import { compareText, exact } from "../spec/domain/primitives";
import { freeze } from "../workspace/domain";
import { gitObservationSchema } from "./observation";
import type { GitObservation } from "./types";

export type GitDriftCode = "invalid-observation" | "repository-changed" | "worktree-changed" |
  "head-base-changed" | "index-changed" | "tracked-worktree-changed" | "untracked-changed" |
  "ignored-changed" | "submodule-changed" | "policy-changed" | "project-changed";
export interface GitDrift { readonly status: "identical" | "changed" | "incompatible-policy" | "invalid-input";
  readonly reasons: readonly GitDriftCode[] }
/** Pure semantic freshness comparison; audit timestamps, filesystem stat cache and scan order do not decide equality. */
export function compareGitObservations(reviewed: GitObservation | unknown, current: GitObservation | unknown): GitDrift {
  const a = gitObservationSchema.safeParse(reviewed), b = gitObservationSchema.safeParse(current);
  if (!a.success || !b.success) return freeze({ status: "invalid-input" as const, reasons: ["invalid-observation" as const] });
  const x = a.data.subject, y = b.data.subject, reasons: GitDriftCode[] = [];
  if (x.control_project !== y.control_project || x.project !== y.project ||
    x.registered_root_association !== y.registered_root_association) reasons.push("project-changed");
  if (x.repository !== y.repository || x.object_format !== y.object_format) reasons.push("repository-changed");
  if (!exact(x.worktree, y.worktree)) reasons.push("worktree-changed");
  if (!exact(x.head, y.head) || x.base_commit !== y.base_commit) reasons.push("head-base-changed");
  if (!exact(x.index, y.index) || !exact(x.staged, y.staged)) reasons.push("index-changed");
  if (!exact(x.tracked, y.tracked)) reasons.push("tracked-worktree-changed");
  if (!exact(x.untracked, y.untracked)) reasons.push("untracked-changed");
  if (!exact(x.ignored, y.ignored)) reasons.push("ignored-changed");
  if (!exact(x.submodules, y.submodules) || x.state !== y.state) reasons.push("submodule-changed");
  if (x.policy_hash !== y.policy_hash || x.capture_policy_hash !== y.capture_policy_hash ||
    !exact(x.exclusions, y.exclusions)) reasons.push("policy-changed");
  if (!reasons.length && a.data.hash !== b.data.hash) reasons.push("invalid-observation");
  reasons.sort(compareText);
  return freeze({ status: reasons.includes("policy-changed") ? "incompatible-policy" as const :
    reasons.length ? "changed" as const : "identical" as const, reasons });
}
/** Hashes Git classifications only. File content and index stage-0 blob bytes are NOT rehashed here. */
export function gitOverlayDescriptor(observation: GitObservation) {
  const subject = gitObservationSchema.parse(observation).subject;
  const component = (category: string, entries: unknown) => hashCanonical({ schema: "aira.dev/workspace-git-overlay-component/v1", category, entries });
  const staged = component("staged", subject.staged);
  const tracked = component("tracked", subject.tracked);
  const untracked = component("untracked", subject.untracked);
  const ignored = component("ignored", subject.ignored);
  const exclusions = subject.exclusions.paths;
  return freeze({ staged, tracked, untracked, ignored, exclusions,
    manifest_hash: hashCanonical({ schema: "aira.dev/workspace-git-overlay/v1", staged, tracked, untracked, ignored, exclusions }) });
}
export function gitIsClean(observation: GitObservation): boolean {
  const s = gitObservationSchema.parse(observation).subject;
  return s.state === "normal" && !s.staged.length && !s.tracked.length && !s.untracked.length && !s.ignored.length;
}
