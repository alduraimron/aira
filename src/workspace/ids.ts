import { z } from "zod";
import { workspaceIdSchema } from "../spec/domain/ids";

// WorkspaceId is the existing branded logical ID. Neither it nor these IDs encode a path.
export { workspaceIdSchema };
const opaque = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9][a-z0-9_-]{0,63}$`));
export const controlProjectIdSchema = opaque("control_project").brand<"ControlProjectId">();
export const projectIdentitySchema = opaque("project").brand<"ProjectIdentity">();
export const repositoryIdentitySchema = opaque("repository").brand<"RepositoryIdentity">();
export const workspaceProviderIdSchema = opaque("provider").brand<"WorkspaceProviderId">();
export const workspaceClaimIdSchema = opaque("workspace_claim").brand<"WorkspaceClaimId">();
// Semantic observation IDs are SHA-256 tokens in their own namespaces.
export const sourceObservationIdSchema = z.string().regex(/^source_observation_[a-f0-9]{64}$/).brand<"SourceObservationId">();
export const workspaceFingerprintIdSchema = z.string().regex(/^workspace_fingerprint_[a-f0-9]{64}$/).brand<"WorkspaceFingerprintId">();
const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine((value) => BigInt(value) <= 18446744073709551615n, "workspace-u64-overflow");
export const workspaceIncarnationSchema = u64.brand<"WorkspaceIncarnation">();
export const workspaceFenceEpochSchema = u64.brand<"WorkspaceFenceEpoch">();
export const workspaceProviderVersionSchema = z.string().max(128)
  .regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/)
  .brand<"WorkspaceProviderVersion">();

export type ControlProjectId = z.infer<typeof controlProjectIdSchema>;
export type ProjectIdentity = z.infer<typeof projectIdentitySchema>;
export type RepositoryIdentity = z.infer<typeof repositoryIdentitySchema>;
export type WorkspaceProviderId = z.infer<typeof workspaceProviderIdSchema>;
export type WorkspaceClaimId = z.infer<typeof workspaceClaimIdSchema>;
export type SourceObservationId = z.infer<typeof sourceObservationIdSchema>;
export type WorkspaceFingerprintId = z.infer<typeof workspaceFingerprintIdSchema>;
export type WorkspaceIncarnation = z.infer<typeof workspaceIncarnationSchema>;
export type WorkspaceFenceEpoch = z.infer<typeof workspaceFenceEpochSchema>;
export type WorkspaceProviderVersion = z.infer<typeof workspaceProviderVersionSchema>;
export type { WorkspaceId } from "../spec/domain/ids";
