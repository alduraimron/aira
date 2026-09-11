import { z } from "zod";
import { workspaceIdSchema } from "../spec/domain/ids";
import { contentHashSchema, nonBlankSchema, profileReferenceSchema, timestampSchema, unique } from "../spec/domain/primitives";

export const workspaceProviderKindSchema = z.enum(["local", "git-worktree", "container", "custom"]);
export const implementationIdentitySchema = z.strictObject({
  id: nonBlankSchema, implementation: nonBlankSchema, version: nonBlankSchema,
  integrity: contentHashSchema, configuration_hash: contentHashSchema,
});
export const workspaceProviderIdentitySchema = z.strictObject({ kind: workspaceProviderKindSchema, identity: implementationIdentitySchema });
export const backendCapabilitySchema = z.enum(["filesystem_read_confinement", "filesystem_write_confinement", "process_confinement",
  "network_confinement", "environment_isolation", "force_termination"]);
export const executionBackendCapabilitiesSchema = z.strictObject({
  filesystem_read_confinement: z.boolean(), filesystem_write_confinement: z.boolean(), process_confinement: z.boolean(),
  network_confinement: z.boolean(), environment_isolation: z.boolean(), force_termination: z.boolean(),
});
export const executionBackendSchema = z.strictObject({
  schema: z.literal("aira.dev/execution-backend/v1"), identity: implementationIdentitySchema,
  capabilities: executionBackendCapabilitiesSchema,
});
export const workspaceHandleSchema = z.strictObject({
  schema: z.literal("aira.dev/workspace-handle/v1"), id: workspaceIdSchema, provider: workspaceProviderIdentitySchema,
  project_identity: nonBlankSchema, repository_identity: nonBlankSchema.optional(),
  location: nonBlankSchema,
  isolation: z.enum(["shared", "isolated-filesystem"]),
  // Explicit provider extension point, not ambient top-level unknown fields.
  provider_data: z.record(nonBlankSchema, z.json()),
});
export const workspaceRequirementsSchema = z.strictObject({
  providers: z.array(workspaceProviderKindSchema).min(1),
  isolation: z.enum(["shared-allowed", "isolated-required"]),
  repository_required: z.boolean(), backend_requirements: z.array(backendCapabilitySchema),
}).refine((w) => unique(w.providers) && unique(w.backend_requirements), "duplicate-workspace-requirement");
export const workspaceFingerprintSchema = z.strictObject({
  schema: z.literal("aira.dev/workspace-fingerprint/v1"), workspace_id: workspaceIdSchema,
  provider: workspaceProviderIdentitySchema, algorithm: profileReferenceSchema,
  capture_policy: z.strictObject({
    identity: profileReferenceSchema,
    ignored: z.enum(["included", "excluded"]), submodules: z.enum(["recursive", "identity-only", "excluded"]),
    symlinks: z.enum(["link-identity", "resolved-content", "forbidden"]),
    generated: z.enum(["included", "excluded"]), aira_storage: z.enum(["included", "excluded"]),
    exclusions: z.array(nonBlankSchema),
  }),
  digest: contentHashSchema,
  state: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("git"), repository_identity: nonBlankSchema,
      base_revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
      index_hash: contentHashSchema, tree_hash: contentHashSchema, tracked_content_hash: contentHashSchema,
      tracked_diff_hash: contentHashSchema, untracked_content_hash: contentHashSchema,
      submodule_state_hash: contentHashSchema,
    }),
    z.strictObject({ kind: z.literal("custom"), repository_identity: nonBlankSchema,
      base_revision: nonBlankSchema, tracked_content_hash: contentHashSchema, tracked_diff_hash: contentHashSchema,
      untracked_content_hash: contentHashSchema,
      components: z.record(nonBlankSchema, z.json()),
    }),
  ]),
});
export const workspaceObservationSchema = z.strictObject({
  schema: z.literal("aira.dev/workspace-observation/v1"), fingerprint: workspaceFingerprintSchema,
  at: timestampSchema, consistency: z.enum(["stable", "unknown"]),
  coordination: z.strictObject({ identity: nonBlankSchema, contract: profileReferenceSchema }),
});
