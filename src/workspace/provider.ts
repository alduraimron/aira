import { z } from "zod";
import { contentHashSchema, compareText, type DeepReadonly } from "../spec/domain/primitives";
import { workspaceProviderIdSchema, workspaceProviderVersionSchema } from "./ids";
import { workspaceTopologySchema } from "./topology";
import { checked, required } from "./domain";

// Provider/configuration and each policy interface are exact pins, not 'current' aliases.
export const workspaceProviderDescriptorSchema = z.strictObject({
  schema: z.literal("aira.dev/workspace-provider/v1"), id: workspaceProviderIdSchema,
  version: workspaceProviderVersionSchema, integrity: contentHashSchema, configuration_hash: contentHashSchema,
  capability_schema: z.literal("aira.dev/workspace-provider-capabilities/v1"),
  source_schema: z.literal("aira.dev/workspace-source-observation/v1"),
  fingerprint_policy_schema: z.literal("aira.dev/workspace-capture/all-project-content/v1"),
  preparation_policy: z.strictObject({ schema: z.literal("aira.dev/workspace-preparation-policy/v1"), hash: contentHashSchema }),
});
export const workspaceProviderCapabilitiesSchema = z.strictObject({
  schema: z.literal("aira.dev/workspace-provider-capabilities/v1"),
  provider: workspaceProviderDescriptorSchema,
  project_kinds: z.array(z.enum(["git", "snapshot"])).min(1).max(2),
  topologies: z.array(workspaceTopologySchema).min(1).max(3),
  dirty_policies: z.array(z.enum(["require-clean", "base-only", "include-observed-overlay"])).min(1).max(3),
  fingerprint_policies: z.array(contentHashSchema).max(32),
  exact_immutable_base: z.boolean(), observed_dirty_overlay_reproduction: z.boolean(),
  deterministic_fingerprinting: z.boolean(), retention: z.boolean(), disposal: z.boolean(),
  recoverable_abandoned_lifecycle: z.boolean(), exclusive_claim_integration: z.boolean(),
  repository_native_topology_isolation: z.boolean(),
}).superRefine((c, ctx) => {
  for (const key of ["project_kinds", "topologies", "dirty_policies", "fingerprint_policies"] as const) {
    if (new Set<string>(c[key]).size !== c[key].length) ctx.addIssue({ code: "custom", path: [key], message: "workspace-provider-incompatible" });
  }
  if ((c.dirty_policies.includes("include-observed-overlay") && !c.observed_dirty_overlay_reproduction) ||
      (c.deterministic_fingerprinting !== (c.fingerprint_policies.length > 0)) ||
      (c.repository_native_topology_isolation && !c.topologies.includes("isolated-local")))
    ctx.addIssue({ code: "custom", message: "workspace-provider-incompatible" });
});
export type WorkspaceProviderDescriptor = DeepReadonly<z.infer<typeof workspaceProviderDescriptorSchema>>;
export type WorkspaceProviderCapabilities = DeepReadonly<z.infer<typeof workspaceProviderCapabilitiesSchema>>;
export function createWorkspaceProviderCapabilities(input: unknown): WorkspaceProviderCapabilities {
  const parsed = required(checked(workspaceProviderCapabilitiesSchema, input, "workspace-provider-incompatible"));
  // Sets are unordered declarations. Re-parse to detach and freeze the canonical order.
  return required(checked(workspaceProviderCapabilitiesSchema, {
    ...parsed, project_kinds: [...parsed.project_kinds].sort(compareText),
    topologies: [...parsed.topologies].sort(compareText), dirty_policies: [...parsed.dirty_policies].sort(compareText),
    fingerprint_policies: [...parsed.fingerprint_policies].sort(compareText),
  }, "workspace-provider-incompatible"));
}
