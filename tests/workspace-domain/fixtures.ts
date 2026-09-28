import { hashCanonical } from "../../src/canonical-json";
import { workspaceIdSchema } from "../../src/spec/domain/ids";
import { repositoryIdentitySchema } from "../../src/workspace/ids";
import { createWorkspaceProviderCapabilities } from "../../src/workspace/provider";
import { createSourceObservation } from "../../src/workspace/source";
import { createWorkspaceHandle } from "../../src/workspace/handle";
import { createWorkspaceFingerprint, defaultWorkspaceFingerprintPolicy } from "../../src/workspace/fingerprint-v2";
import type { WorkspaceManifestEntry } from "../../src/workspace/fingerprint-v2";

export const hash = (value: string) => hashCanonical(value);
export const at = "2026-01-01T00:00:00Z";
export const audit = (time = at) => ({ at: time, by: { kind: "human" as const, id: "local" }, operation: "operation_setup" });
export const policy = defaultWorkspaceFingerprintPolicy();
export const provider = {
  schema: "aira.dev/workspace-provider/v1" as const, id: "provider_local", version: "1.2.3" as const,
  integrity: hash("provider-code"), configuration_hash: hash("config"),
  capability_schema: "aira.dev/workspace-provider-capabilities/v1" as const,
  source_schema: "aira.dev/workspace-source-observation/v1" as const,
  fingerprint_policy_schema: "aira.dev/workspace-capture/all-project-content/v1" as const,
  preparation_policy: { schema: "aira.dev/workspace-preparation-policy/v1" as const, hash: hash("prepare-v1") },
};
export const caps = () => createWorkspaceProviderCapabilities({
  schema: "aira.dev/workspace-provider-capabilities/v1", provider,
  project_kinds: ["snapshot", "git"], topologies: ["isolated-local", "copied-snapshot", "in-place"],
  dirty_policies: ["base-only", "require-clean", "include-observed-overlay"],
  fingerprint_policies: [policy.hash], exact_immutable_base: true, observed_dirty_overlay_reproduction: true,
  deterministic_fingerprinting: true, retention: true, disposal: true,
  recoverable_abandoned_lifecycle: true, exclusive_claim_integration: true,
  repository_native_topology_isolation: true,
});
export const gitBase = { kind: "git" as const, repository: repositoryIdentitySchema.parse("repository_one"), object_format: "sha1" as const, commit: "a".repeat(40) };
export const noOverlay = { kind: "none" as const };
export const overlay = { kind: "observed" as const, manifest_hash: hash("overlay"), staged: hash("index"),
  tracked: hash("tracked"), untracked: hash("untracked"), ignored: hash("ignored"), exclusions: [".aira"] };
export function source(options: { dirty?: boolean; detached?: boolean; snapshot?: boolean; time?: string } = {}) {
  const src = options.snapshot ? { kind: "snapshot" as const,
    base: { kind: "snapshot" as const, manifest_hash: hash("snap-manifest"), bytes_hash: hash("snap-bytes"),
      byte_count: 50, retained_reference: hash("retained"), captured_tree_hash: hash("tree") }, observed_tree: hash("tree") } :
    { kind: "git" as const, repository: "repository_one", base: gitBase,
      head: options.detached ? { kind: "detached" as const } : { kind: "attached" as const },
      worktree: { kind: "linked" as const, identity: hash("worktree") }, state: "normal" as const,
      submodule_policy: { schema: "aira.dev/workspace-submodules/reject/v1" as const, observations: [] } };
  return createSourceObservation({ subject: {
    schema: "aira.dev/workspace-source-observation-subject/v1", control_project: "control_project_one",
    project: "project_one", registered_root_association: hash("registered-root"), provider,
    inspection_policy: { schema: "aira.dev/workspace-source-inspection/v1", hash: hash("inspect-policy") },
    source: src, overlay: options.dirty ? overlay : noOverlay, dirty_state: options.dirty ? "dirty" : "clean", consistency: "stable",
  }, audit: audit(options.time), ...(!options.detached && !options.snapshot ? { diagnostics: { git_branch: "main" } } : {}) });
}
export function handle(options: { dirty?: boolean; topology?: "in-place" | "isolated-local" | "copied-snapshot"; snapshot?: boolean } = {}) {
  const src = source({ dirty: options.dirty, snapshot: options.snapshot });
  const topology = options.topology ?? "isolated-local";
  const control = { kind: "local-absolute", path: "/project" },
    execution = topology === "in-place" ? control : { kind: "local-absolute", path: "/managed/ws-one" };
  return createWorkspaceHandle({ schema: "aira.dev/workspace-handle/v2", id: workspaceIdSchema.parse("workspace_one"),
    incarnation: "1", control_project: "control_project_one", project: "project_one",
    ...(options.snapshot ? {} : { repository: "repository_one" }), provider, capabilities: caps(), topology,
    roots: { control, execution, relationship: topology === "in-place" ? "same-root" : "separate-root" },
    source: src, dirty_policy: options.dirty ? "include-observed-overlay" : "require-clean",
    dirty_decision: options.dirty ? { kind: "included", overlay_hash: overlay.manifest_hash } : { kind: "clean" },
    fingerprint_policy: policy, lifecycle: { schema: "aira.dev/workspace-lifecycle-authority/v1",
      control_project: "control_project_one", workspace_id: "workspace_one", incarnation: "1", fence_scope: "workspace-id" },
    created: audit(), compatibility: { handle: "aira.dev/workspace-handle/v2",
      source: "aira.dev/workspace-source-observation/v1", fingerprint: "aira.dev/workspace-fingerprint/v2",
      lifecycle: "aira.dev/workspace-lifecycle-authority/v1" },
  });
}
export const entry = (path: string, value = "bytes"): WorkspaceManifestEntry => ({ path,
  worktree: { category: "tracked", state: { kind: "regular", hash: hash(value), bytes: value.length, executable: false } },
  index: { stage: 0, state: { kind: "regular", hash: hash(value), bytes: value.length, executable: false } },
});
export function fingerprint(options: { entries?: readonly WorkspaceManifestEntry[]; source?: ReturnType<typeof source>;
  incarnation?: string; providerVersion?: string; time?: string } = {}) {
  const s = options.source ?? source();
  return createWorkspaceFingerprint({ binding: {
    control_project: s.subject.control_project, workspace_id: workspaceIdSchema.parse("workspace_one"),
    incarnation: options.incarnation ?? "1", project: s.subject.project,
    ...(s.subject.source.kind === "git" ? { repository: s.subject.source.repository } : {}),
    provider: options.providerVersion ? { ...provider, version: options.providerVersion } : provider,
    source_observation: s.id, base: s.subject.source.base.kind === "unmaterialized" ? gitBase : s.subject.source.base,
    policy,
  }, entries: options.entries ?? [entry("src/main.ts")],
    repository_components: s.subject.source.kind === "git" ? [
      { kind: "git-tree", hash: hash("git-tree") }, { kind: "git-index", hash: hash("git-index") }] : [],
    audit: audit(options.time),
  });
}
