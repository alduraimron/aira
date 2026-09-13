import { z } from "zod";
import { specSchema, completionPolicySchema } from "../spec/domain/schema";
import { artifactRevisionSchema, intentSchema, approvedSpecSnapshotSchema, validationRecordSchema, artifactInvalidationSchema } from "../spec/domain/artifacts";
import { requirementsSchema } from "../spec/domain/requirements";
import { designSchema } from "../spec/domain/design";
import { analysisSchema } from "../spec/domain/analysis";
import { identityRegistrySchema } from "../spec/domain/ids";
import { transactionPreconditionsSchema } from "../spec/domain/generations";
import { tasksSchema, taskDefinitionSchema } from "../tasks/schema";
import { specApprovalRecordSchema, humanWaiverSchema, approvalApplicabilitySchema, waiverApplicabilitySchema, specDecisionPolicySchema } from "../approval/spec-records";
import { revisionRequestSchema } from "../revision/schema";
import { executionRunSchema, executionProfileSchema, attemptRecordSchema, claimRecordSchema, taskExecutionStateSchema } from "../execution/schema";
import { retryPolicySchema, reconciliationRecordSchema } from "../execution/recovery";
import { contextDeclarationSchema } from "../context/declarations";
import { contextSnapshotSchema } from "../context/snapshot";
import { capabilityPolicySchema, effectiveCapabilityPolicySchema, capabilityEscalationSchema } from "../capabilities/schema";
import { verificationPlanSchema, verifierDefinitionSchema, verificationEvidenceSchema } from "../verification/schema";
import { workspaceHandleSchema, workspaceFingerprintSchema, workspaceObservationSchema, executionBackendSchema } from "../workspace/schema";
import { behavioralAssetRevisionSchema } from "../builtins/assets";
import { builtinBundleManifestSchema } from "../builtins/bundle";
import { behavioralProfileSnapshotSchema } from "../builtins/snapshots";
import { specKindProfileSchema, modeProfileSchema } from "../builtins/profiles";
import { behavioralResolutionRequestSchema, behavioralResolutionSchema } from "../builtins/resolution";
import { contentHashSchema, type DeepReadonly } from "../spec/domain/primitives";
import { fail, type StorageErrorCode } from "./errors";

/** Explicit dispatch, never inference from fields or a directory version. */
export const recordSchemas = {
  "aira.dev/spec/v1": specSchema,
  "aira.dev/spec-completion-policy/v1": completionPolicySchema,
  "aira.dev/spec-decision-policy/v1": specDecisionPolicySchema,
  "aira.dev/identity-registry/v1": identityRegistrySchema,
  "aira.dev/artifact-revision/v1": artifactRevisionSchema,
  "aira.dev/intent/v1": intentSchema,
  "aira.dev/requirements/v1": requirementsSchema,
  "aira.dev/design/v1": designSchema,
  "aira.dev/analysis/v1": analysisSchema,
  "aira.dev/tasks/v1": tasksSchema,
  "aira.dev/task-definition/v1": taskDefinitionSchema,
  "aira.dev/approved-spec-snapshot/v1": approvedSpecSnapshotSchema,
  "aira.dev/lineage-validation/v1": validationRecordSchema,
  "aira.dev/artifact-invalidation/v1": artifactInvalidationSchema,
  "aira.dev/spec-approval/v1": specApprovalRecordSchema,
  "aira.dev/approval-applicability/v1": approvalApplicabilitySchema,
  "aira.dev/human-waiver/v1": humanWaiverSchema,
  "aira.dev/waiver-applicability/v1": waiverApplicabilitySchema,
  "aira.dev/revision-request/v1": revisionRequestSchema,
  "aira.dev/execution-run/v1": executionRunSchema,
  "aira.dev/execution-profile/v1": executionProfileSchema,
  "aira.dev/attempt/v1": attemptRecordSchema,
  "aira.dev/task-claim/v1": claimRecordSchema,
  "aira.dev/task-state/v1": taskExecutionStateSchema,
  "aira.dev/transaction-preconditions/v1": transactionPreconditionsSchema,
  "aira.dev/retry-policy/v1": retryPolicySchema,
  "aira.dev/reconciliation/v1": reconciliationRecordSchema,
  "aira.dev/context-declaration/v1": contextDeclarationSchema,
  "aira.dev/context-snapshot/v1": contextSnapshotSchema,
  "aira.dev/capability-policy/v1": capabilityPolicySchema,
  "aira.dev/effective-capability-policy/v1": effectiveCapabilityPolicySchema,
  "aira.dev/capability-escalation/v1": capabilityEscalationSchema,
  "aira.dev/verification-plan/v1": verificationPlanSchema,
  "aira.dev/verifier/v1": verifierDefinitionSchema,
  "aira.dev/evidence/v1": verificationEvidenceSchema,
  "aira.dev/workspace-handle/v1": workspaceHandleSchema,
  "aira.dev/workspace-fingerprint/v1": workspaceFingerprintSchema,
  "aira.dev/workspace-observation/v1": workspaceObservationSchema,
  "aira.dev/execution-backend/v1": executionBackendSchema,
  "aira.dev/behavioral-asset/v1": behavioralAssetRevisionSchema,
  "aira.dev/builtin-bundle/v1": builtinBundleManifestSchema,
  "aira.dev/behavioral-profile-snapshot/v1": behavioralProfileSnapshotSchema,
  "aira.dev/spec-kind-profile/v1": specKindProfileSchema,
  "aira.dev/mode-profile/v1": modeProfileSchema,
  "aira.dev/behavioral-resolution-request/v1": behavioralResolutionRequestSchema,
  "aira.dev/behavioral-resolution/v1": behavioralResolutionSchema,
} as const;
export type RecordContract = keyof typeof recordSchemas;
export type DomainRecord = DeepReadonly<z.infer<typeof recordSchemas[RecordContract]>>;
export const recordReferenceSchema = z.strictObject({
  contract: z.enum(Object.keys(recordSchemas) as [RecordContract, ...RecordContract[]]), hash: contentHashSchema,
});
export type RecordReference = z.infer<typeof recordReferenceSchema>;
/** Only called after strict decoding failed. Opaque custom JSON is not a schema dispatch site. */
export function rejectUnknownVersions(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if ("schema" in value && typeof value.schema === "string" && value.schema.startsWith("aira.dev/") && !value.schema.endsWith("/v1"))
    fail("STORE_SCHEMA_UNSUPPORTED", `Unsupported schema: ${value.schema}`);
  const object = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(object)) {
    if ((object.schema === "aira.dev/workspace-handle/v1" && key === "provider_data") ||
      (object.kind === "custom" && (("repository_identity" in object && key === "components") || ("contract" in object && key === "configuration")))) continue;
    rejectUnknownVersions(child);
  }
}
export function parseRecord(value: unknown, code: StorageErrorCode = "STORE_INTEGRITY"): DomainRecord {
  if (!value || typeof value !== "object" || !("schema" in value) || typeof value.schema !== "string") fail(code, "Record schema is missing");
  if (!Object.hasOwn(recordSchemas, value.schema)) fail("STORE_SCHEMA_UNSUPPORTED", `Unsupported domain record: ${value.schema}`);
  const result = recordSchemas[value.schema as RecordContract].safeParse(value);
  if (!result.success) {
    rejectUnknownVersions(value);
    fail(code, `Invalid domain record: ${result.error.message}`);
  }
  return result.data;
}
