import { z } from "zod";
import { specSchema, completionPolicySchema } from "../spec/domain/schema";
import { artifactRevisionSchema, intentSchema, approvedSpecSnapshotSchema, validationRecordSchema, artifactInvalidationSchema } from "../spec/domain/artifacts";
import { requirementsSchema } from "../spec/domain/requirements";
import { architectureSchema } from "../spec/domain/architecture";
import { productDefinitionSchema } from "../spec/domain/product";
import { programDesignSchema } from "../spec/domain/program-design";
import { slicePlanSchema } from "../spec/domain/slices";
import { sliceExecutionStateSchema } from "../spec/domain/slice-state";
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
  "aira.dev/spec/v2": specSchema,
  "aira.dev/spec-completion-policy/v2": completionPolicySchema,
  "aira.dev/spec-decision-policy/v2": specDecisionPolicySchema,
  "aira.dev/identity-registry/v2": identityRegistrySchema,
  "aira.dev/artifact-revision/v2": artifactRevisionSchema,
  "aira.dev/intent/v1": intentSchema,
  "aira.dev/requirements/v2": requirementsSchema,
  "aira.dev/architecture/v1": architectureSchema,
  "aira.dev/product/v1": productDefinitionSchema,
  "aira.dev/program-design/v1": programDesignSchema,
  "aira.dev/slice-plan/v1": slicePlanSchema,
  "aira.dev/slice-state/v1": sliceExecutionStateSchema,
  "aira.dev/analysis/v2": analysisSchema,
  "aira.dev/tasks/v2": tasksSchema,
  "aira.dev/task-definition/v2": taskDefinitionSchema,
  "aira.dev/approved-spec-snapshot/v2": approvedSpecSnapshotSchema,
  "aira.dev/lineage-validation/v2": validationRecordSchema,
  "aira.dev/artifact-invalidation/v2": artifactInvalidationSchema,
  "aira.dev/spec-approval/v2": specApprovalRecordSchema,
  "aira.dev/approval-applicability/v2": approvalApplicabilitySchema,
  "aira.dev/human-waiver/v2": humanWaiverSchema,
  "aira.dev/waiver-applicability/v1": waiverApplicabilitySchema,
  "aira.dev/revision-request/v2": revisionRequestSchema,
  "aira.dev/execution-run/v2": executionRunSchema,
  "aira.dev/execution-profile/v1": executionProfileSchema,
  "aira.dev/attempt/v2": attemptRecordSchema,
  "aira.dev/task-claim/v2": claimRecordSchema,
  "aira.dev/task-state/v1": taskExecutionStateSchema,
  "aira.dev/transaction-preconditions/v1": transactionPreconditionsSchema,
  "aira.dev/retry-policy/v1": retryPolicySchema,
  "aira.dev/reconciliation/v1": reconciliationRecordSchema,
  "aira.dev/context-declaration/v2": contextDeclarationSchema,
  "aira.dev/context-snapshot/v2": contextSnapshotSchema,
  "aira.dev/capability-policy/v1": capabilityPolicySchema,
  "aira.dev/effective-capability-policy/v1": effectiveCapabilityPolicySchema,
  "aira.dev/capability-escalation/v1": capabilityEscalationSchema,
  "aira.dev/verification-plan/v2": verificationPlanSchema,
  "aira.dev/verifier/v2": verifierDefinitionSchema,
  "aira.dev/evidence/v2": verificationEvidenceSchema,
  "aira.dev/workspace-handle/v1": workspaceHandleSchema,
  "aira.dev/workspace-fingerprint/v1": workspaceFingerprintSchema,
  "aira.dev/workspace-observation/v1": workspaceObservationSchema,
  "aira.dev/execution-backend/v1": executionBackendSchema,
  "aira.dev/behavioral-asset/v1": behavioralAssetRevisionSchema,
  "aira.dev/builtin-bundle/v2": builtinBundleManifestSchema,
  "aira.dev/behavioral-profile-snapshot/v2": behavioralProfileSnapshotSchema,
  "aira.dev/spec-kind-profile/v2": specKindProfileSchema,
  "aira.dev/mode-profile/v2": modeProfileSchema,
  "aira.dev/behavioral-resolution-request/v2": behavioralResolutionRequestSchema,
  "aira.dev/behavioral-resolution/v2": behavioralResolutionSchema,
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
  if ("schema" in value && typeof value.schema === "string" && value.schema.startsWith("aira.dev/") && !Object.hasOwn(recordSchemas, value.schema) &&
    !["aira.dev/store-head/v1", "aira.dev/store-commit/v1", "aira.dev/store-commit-payload/v1", "aira.dev/store-transaction/v1", "aira.dev/store-state/v1",
      "aira.dev/evidence-applicability/exact-workspace/v1"].includes(value.schema))
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
