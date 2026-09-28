import { z } from "zod";
import { exact, compareText, createdMetadataSchema, type DeepReadonly, type DomainResult } from "../spec/domain/primitives";
import { workspaceIdSchema, controlProjectIdSchema, projectIdentitySchema, repositoryIdentitySchema,
  workspaceIncarnationSchema, workspaceClaimIdSchema, workspaceFenceEpochSchema } from "./ids";
import { createWorkspaceProviderCapabilities, workspaceProviderCapabilitiesSchema, workspaceProviderDescriptorSchema } from "./provider";
import { workspaceFingerprintPolicySchema } from "./fingerprint-v2";
import { workspaceRootsSchema, workspaceTopologySchema } from "./topology";
import { dirtyPolicySchema, sourceObservationSchema, sourceDecisionIssues } from "./source";
import { checked, required } from "./domain";

/** Names the future authority scope. It is NOT a claim, lock, or snapshot of lifecycle state. */
export const workspaceLifecycleReferenceSchema = z.strictObject({
  schema: z.literal("aira.dev/workspace-lifecycle-authority/v1"),
  control_project: controlProjectIdSchema, workspace_id: workspaceIdSchema,
  incarnation: workspaceIncarnationSchema, fence_scope: z.literal("workspace-id"),
});
export const workspaceClaimStatusSchema = z.enum(["reserved", "active", "released", "abandoned", "fenced"]);
export const workspaceClaimReferenceSchema = z.strictObject({
  claim: workspaceClaimIdSchema, workspace_id: workspaceIdSchema, incarnation: workspaceIncarnationSchema,
  epoch: workspaceFenceEpochSchema,
});
export const workspaceHandleV2Schema = z.strictObject({
  schema: z.literal("aira.dev/workspace-handle/v2"), id: workspaceIdSchema,
  incarnation: workspaceIncarnationSchema, control_project: controlProjectIdSchema,
  project: projectIdentitySchema, repository: repositoryIdentitySchema.optional(),
  provider: workspaceProviderDescriptorSchema, capabilities: workspaceProviderCapabilitiesSchema,
  topology: workspaceTopologySchema, roots: workspaceRootsSchema,
  source: sourceObservationSchema, dirty_policy: dirtyPolicySchema,
  dirty_decision: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("clean") }),
    z.strictObject({ kind: z.literal("omitted"), reviewed_overlay_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      reason: z.literal("base-only") }),
    z.strictObject({ kind: z.literal("included"), overlay_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
  ]),
  fingerprint_policy: workspaceFingerprintPolicySchema,
  lifecycle: workspaceLifecycleReferenceSchema, created: createdMetadataSchema,
  compatibility: z.strictObject({
    handle: z.literal("aira.dev/workspace-handle/v2"), source: z.literal("aira.dev/workspace-source-observation/v1"),
    fingerprint: z.literal("aira.dev/workspace-fingerprint/v2"),
    lifecycle: z.literal("aira.dev/workspace-lifecycle-authority/v1"),
  }),
}).superRefine((h, ctx) => {
  const add = (message: string) => ctx.addIssue({ code: "custom", message });
  for (const list of [h.capabilities.project_kinds, h.capabilities.topologies, h.capabilities.dirty_policies,
    h.capabilities.fingerprint_policies]) if (list.some((item, i) => i > 0 && compareText(list[i - 1]!, item) >= 0))
    add("workspace-provider-incompatible");
  const { subject } = h.source;
  if (h.control_project !== subject.control_project || h.project !== subject.project ||
      h.repository !== (subject.source.kind === "git" ? subject.source.repository : undefined) ||
      !exact(h.provider, subject.provider)) add("workspace-source-invalid");
  if (!exact(h.capabilities.provider, h.provider) ||
      !h.capabilities.topologies.includes(h.topology) || !h.capabilities.project_kinds.includes(subject.source.kind) ||
      !h.capabilities.dirty_policies.includes(h.dirty_policy) ||
      !h.capabilities.fingerprint_policies.includes(h.fingerprint_policy.hash) ||
      !h.capabilities.exact_immutable_base || !h.capabilities.deterministic_fingerprinting ||
      !h.capabilities.exclusive_claim_integration ||
      h.dirty_policy === "include-observed-overlay" && !h.capabilities.observed_dirty_overlay_reproduction ||
      h.provider.fingerprint_policy_schema !== h.fingerprint_policy.schema)
    add("workspace-provider-incompatible");
  const rootsEqual = exact(h.roots.control, h.roots.execution);
  const rootsOverlap = h.roots.control.kind === "local-absolute" && h.roots.execution.kind === "local-absolute" &&
    (h.roots.control.path === "/" || h.roots.execution.path === "/" ||
      h.roots.control.path.startsWith(`${h.roots.execution.path}/`) ||
      h.roots.execution.path.startsWith(`${h.roots.control.path}/`));
  if (h.topology === "in-place" ? h.roots.relationship !== "same-root" || !rootsEqual :
      h.roots.relationship !== "separate-root" || rootsEqual || rootsOverlap ||
      h.topology === "isolated-local" && (h.roots.control.kind !== "local-absolute" || h.roots.execution.kind !== "local-absolute") ||
      h.topology === "copied-snapshot" && subject.source.base.kind !== "snapshot") add("workspace-topology-incompatible");
  if (h.lifecycle.control_project !== h.control_project || h.lifecycle.workspace_id !== h.id ||
      h.lifecycle.incarnation !== h.incarnation) add("workspace-id-invalid");
  for (const issue of sourceDecisionIssues(h.source, h.dirty_policy, h.topology)) add(issue.code);
  if (h.dirty_policy === "require-clean" && h.dirty_decision.kind !== "clean" ||
      h.dirty_policy === "base-only" && (subject.overlay.kind === "observed" ?
        h.dirty_decision.kind !== "omitted" || h.dirty_decision.reviewed_overlay_hash !== subject.overlay.manifest_hash :
        h.dirty_decision.kind !== "clean") ||
      h.dirty_policy === "include-observed-overlay" && (subject.overlay.kind !== "observed" ||
        h.dirty_decision.kind !== "included" || h.dirty_decision.overlay_hash !== subject.overlay.manifest_hash))
    add("workspace-dirty-policy-invalid");
});
export type WorkspaceHandleV2 = DeepReadonly<z.infer<typeof workspaceHandleV2Schema>>;
export type WorkspaceClaimReference = DeepReadonly<z.infer<typeof workspaceClaimReferenceSchema>>;
export function validateWorkspaceHandle(input: unknown): DomainResult<WorkspaceHandleV2> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return checked(workspaceHandleV2Schema, input, "workspace-source-invalid");
  const candidate = input as Record<string, unknown>;
  const capability = workspaceProviderCapabilitiesSchema.safeParse(candidate.capabilities);
  return checked(workspaceHandleV2Schema, { ...candidate,
    capabilities: capability.success ? createWorkspaceProviderCapabilities(capability.data) : candidate.capabilities,
  }, "workspace-source-invalid");
}
export function createWorkspaceHandle(input: unknown): WorkspaceHandleV2 {
  return required(validateWorkspaceHandle(input));
}
