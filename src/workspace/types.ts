import type { z } from "zod";
import type { DeepReadonly } from "../spec/domain/primitives";
import type { workspaceProviderKindSchema, workspaceHandleSchema, workspaceFingerprintSchema,
  executionBackendCapabilitiesSchema, executionBackendSchema, backendCapabilitySchema, workspaceRequirementsSchema, workspaceObservationSchema } from "./schema";
export type WorkspaceProviderKind = z.infer<typeof workspaceProviderKindSchema>;
export type WorkspaceHandle = z.infer<typeof workspaceHandleSchema>;
export type WorkspaceFingerprint = DeepReadonly<z.infer<typeof workspaceFingerprintSchema>>;
export type ExecutionBackendCapabilities = z.infer<typeof executionBackendCapabilitiesSchema>;
export type ExecutionBackend = z.infer<typeof executionBackendSchema>;
export type BackendCapability = z.infer<typeof backendCapabilitySchema>;
export type WorkspaceRequirements = z.infer<typeof workspaceRequirementsSchema>;
export type WorkspaceObservation = DeepReadonly<z.infer<typeof workspaceObservationSchema>>;
