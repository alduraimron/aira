import { z } from "zod";
import { artifactRevisionIdSchema, attemptIdSchema, claimIdSchema, contextSnapshotIdSchema, evidenceIdSchema, operationIdSchema, runIdV2Schema, taskIdSchema, verifierIdSchema } from "../spec/domain/ids";
import { approvedSpecSnapshotSchema } from "../spec/domain/artifacts";
import { commitSequenceSchema, fenceTokenSchema, runGenerationSchema, specGenerationSchema } from "../spec/domain/generations";
import { blobReferenceSchema, contentHashSchema, nonBlankSchema, policyReferenceSchema, profileReferenceSchema, safeUnsignedSchema, timestampSchema, unique } from "../spec/domain/primitives";
import { contextSnapshotReferenceSchema } from "../context/snapshot";
import { executionBackendSchema, workspaceFingerprintSchema } from "../workspace/schema";
import { attemptOutcomeSchema, recoveryDeclarationSchema, retryPolicySchema } from "./recovery";
import { attemptBehaviorSchema, pinsPolicy, pinsProfile } from "../builtins/bindings";
import { containsPins } from "../builtins/roles";
import { sliceExecutionStateSchema } from "../spec/domain/slice-state";

export const taskDefinitionReferenceSchema = z.strictObject({ id: taskIdSchema, revision: artifactRevisionIdSchema, hash: contentHashSchema });
export const taskExecutionStatusSchema = z.enum(["pending", "ready", "claimed", "running", "verifying", "completed", "failed", "blocked", "interrupted", "skipped", "cancelled", "unknown"]);
export const taskExecutionStateSchema = z.strictObject({
  schema: z.literal("aira.dev/task-state/v1"), task: taskDefinitionReferenceSchema,
  run: runIdV2Schema, run_generation: runGenerationSchema, status: taskExecutionStatusSchema,
  current_attempt: attemptIdSchema.optional(), claim: claimIdSchema.optional(),
  reason: nonBlankSchema.optional(), updated_at: timestampSchema,
}).refine((s) => !["claimed", "running", "verifying", "completed"].includes(s.status) || s.current_attempt !== undefined, "task-attempt-required")
  .refine((s) => !["claimed", "running"].includes(s.status) || s.claim !== undefined, "task-claim-required");
export const runBindingSchema = z.strictObject({
  run: runIdV2Schema, snapshot: approvedSpecSnapshotSchema,
  applicable_generation: specGenerationSchema, status: z.enum(["applicable", "fenced", "historical"]),
});
export const claimRecordSchema = z.strictObject({
  schema: z.literal("aira.dev/task-claim/v2"), id: claimIdSchema, task: taskDefinitionReferenceSchema,
  run: runIdV2Schema, attempt: attemptIdSchema, owner: nonBlankSchema,
  generation: runGenerationSchema, fence: fenceTokenSchema, snapshot: approvedSpecSnapshotSchema,
  lease: z.strictObject({ issued_at: timestampSchema, expires_at: timestampSchema }),
  status: z.enum(["active", "released", "expired", "fenced"]),
}).refine((c) => c.fence.claim === c.id && c.fence.run === c.run && c.fence.attempt === c.attempt && c.fence.owner === c.owner &&
  Date.parse(c.lease.expires_at) > Date.parse(c.lease.issued_at), "invalid-claim-binding");
export const attemptRecordSchema = z.strictObject({
  schema: z.literal("aira.dev/attempt/v2"), id: attemptIdSchema, operation: operationIdSchema,
  run: runIdV2Schema, task: taskDefinitionReferenceSchema, fence: fenceTokenSchema,
  snapshot: approvedSpecSnapshotSchema, run_generation: runGenerationSchema,
  context: z.array(contextSnapshotReferenceSchema), policy: policyReferenceSchema,
  execution_profile: profileReferenceSchema, workspace: workspaceFingerprintSchema, backend: executionBackendSchema,
  behavior: attemptBehaviorSchema,
  recovery: z.array(recoveryDeclarationSchema),
  started_at: timestampSchema, ended_at: timestampSchema, outcome: attemptOutcomeSchema,
  external_effects: z.enum(["none", "known", "unknown"]), outputs: z.array(blobReferenceSchema),
}).refine((a) => a.id === a.fence.attempt && a.run === a.fence.run && Date.parse(a.ended_at) >= Date.parse(a.started_at) &&
  unique(a.context.map((c) => c.id)) && pinsPolicy(a.behavior.pins, a.policy) &&
  pinsProfile(a.behavior.pins, "execution-profile", a.execution_profile) &&
  containsPins(a.behavior.pins, a.snapshot.behavioral_assets.filter((p) => p.role === "capability-profile")), "invalid-attempt-binding");
export const attemptAuthoritySchema = z.strictObject({
  attempt: attemptIdSchema, fence: fenceTokenSchema, snapshot: approvedSpecSnapshotSchema,
  status: z.enum(["active", "published", "fenced"]), generation: runGenerationSchema,
}).refine((a) => a.fence.attempt === a.attempt, "authority-attempt-mismatch");
export const executionProfileSchema = z.strictObject({
  schema: z.literal("aira.dev/execution-profile/v1"), identity: profileReferenceSchema,
  recipe: profileReferenceSchema, recovery: z.array(recoveryDeclarationSchema), retry: retryPolicySchema,
  context: z.array(contextSnapshotIdSchema),
});
export const executionRunSchema = z.strictObject({
  schema: z.literal("aira.dev/execution-run/v2"), id: runIdV2Schema, commit_sequence: commitSequenceSchema,
  generation: runGenerationSchema, snapshot: approvedSpecSnapshotSchema,
  status: z.enum(["pending", "running", "verifying", "completed", "failed", "blocked", "interrupted", "cancelled", "unknown"]),
  scheduling: z.strictObject({ max_parallel: safeUnsignedSchema.refine((n) => n > 0), ordering: z.literal("priority-then-task-id-codepoint") }),
  slices: z.array(sliceExecutionStateSchema), tasks: z.array(taskExecutionStateSchema), claims: z.array(claimRecordSchema),
  attempts: z.array(attemptIdSchema), authorities: z.array(attemptAuthoritySchema),
  current_evidence: z.array(z.strictObject({ task: taskDefinitionReferenceSchema, verifier: verifierIdSchema,
    evidence: evidenceIdSchema, generation: runGenerationSchema })),
  created_at: timestampSchema, updated_at: timestampSchema,
}).refine((r) => unique(r.slices.map((s) => s.slice)) && r.slices.every((s) => s.run === r.id && BigInt(s.run_generation) <= BigInt(r.generation)) &&
  unique(r.tasks.map((t) => t.task.id)) && unique(r.claims.map((c) => c.id)) && unique(r.attempts) &&
  unique(r.authorities.map((a) => a.attempt)) && r.tasks.every((t) => t.run === r.id && BigInt(t.run_generation) <= BigInt(r.generation)) &&
  r.claims.every((c) => c.run === r.id && BigInt(c.generation) <= BigInt(r.generation)) &&
  r.authorities.every((a) => a.fence.run === r.id && r.attempts.includes(a.attempt) && BigInt(a.generation) <= BigInt(r.generation)) &&
  unique(r.current_evidence.map((e) => `${e.task.id}:${e.verifier}`)) &&
  r.current_evidence.every((e) => BigInt(e.generation) <= BigInt(r.generation)) &&
  unique(r.claims.filter((c) => c.status === "active").map((c) => c.task.id)) &&
  r.claims.filter((c) => c.status === "active").length <= r.scheduling.max_parallel &&
  Date.parse(r.updated_at) >= Date.parse(r.created_at), "invalid-run-aggregate");
