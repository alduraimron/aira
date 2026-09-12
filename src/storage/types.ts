import { z } from "zod";
import { specSchema } from "../spec/domain/schema";
import { executionRunSchema, taskDefinitionReferenceSchema, taskExecutionStatusSchema } from "../execution/schema";
import { artifactSubjectSchema } from "../spec/domain/artifacts";
import { commitSequenceSchema, specGenerationSchema, runGenerationSchema, fenceTokenSchema } from "../spec/domain/generations";
import { specIdSchema, runIdV2Schema, operationIdSchema, attemptIdSchema, claimIdSchema } from "../spec/domain/ids";
import { actorSchema, channelSchema, contentHashSchema, blobReferenceSchema, nonBlankSchema, timestampSchema, unique, type DeepReadonly } from "../spec/domain/primitives";
import { recordReferenceSchema, type DomainRecord } from "./records";
import { assetCompatibilityEnvironmentSchema } from "../builtins/compatibility";

export const positiveSequenceSchema = commitSequenceSchema.refine((s) => s !== "0", "genesis-sequence-is-one");
export const runCounterSchema = z.strictObject({ run: runIdV2Schema, generation: runGenerationSchema });
export const stateSchema = z.strictObject({
  schema: z.literal("aira.dev/store-state/v1"), spec: specSchema, runs: z.array(executionRunSchema),
  records: z.array(recordReferenceSchema), blobs: z.array(blobReferenceSchema),
  behavioral_environment: assetCompatibilityEnvironmentSchema.nullable(),
}).refine((s) => unique(s.runs.map((r) => r.id)) && unique(s.records.map((r) => r.hash)) && unique(s.blobs.map((b) => b.hash)), "duplicate-state-reference");
export const headSchema = z.strictObject({
  schema: z.literal("aira.dev/store-head/v1"), spec_id: specIdSchema, commit_id: contentHashSchema,
  sequence: positiveSequenceSchema, spec_generation: specGenerationSchema,
  run_id: runIdV2Schema.nullable(), run_generation: runGenerationSchema,
  run_generations: z.array(runCounterSchema),
}).refine((h) => unique(h.run_generations.map((r) => r.run)) && (h.run_id === null ? h.run_generation === "0" :
  h.run_generations.some((r) => r.run === h.run_id && r.generation === h.run_generation)), "invalid-head-run-binding");
export const executionExpectationSchema = z.strictObject({
  run: runIdV2Schema, task: taskDefinitionReferenceSchema, status: taskExecutionStatusSchema,
  attempt: attemptIdSchema.nullable(), claim: claimIdSchema.nullable(), fence: fenceTokenSchema.nullable(),
});
export const expectedStateSchema = z.strictObject({
  head: headSchema, current_artifacts: z.array(artifactSubjectSchema),
  execution: z.array(executionExpectationSchema),
});
export const mutationSchema = z.strictObject({
  kind: z.enum(["create", "spec", "run", "spec-and-run", "audit"]),
  spec: z.boolean(), runs: z.array(runIdV2Schema), reason: nonBlankSchema,
}).refine((m) => unique(m.runs) && (m.kind === "create" ||
  m.kind === (m.spec ? (m.runs.length ? "spec-and-run" : "spec") : (m.runs.length ? "run" : "audit"))), "mutation-category-mismatch");
export const auditEventSchema = z.strictObject({
  kind: nonBlankSchema, identities: z.array(nonBlankSchema), detail: nonBlankSchema.optional(),
  payloads: z.array(blobReferenceSchema),
});
/** The entire intent, including expectations and resulting state, is fingerprinted. */
export const transactionSchema = z.strictObject({
  schema: z.literal("aira.dev/store-transaction/v1"), spec_id: specIdSchema, operation: operationIdSchema,
  expected: expectedStateSchema.nullable(), mutation: mutationSchema, actor: actorSchema, channel: channelSchema.optional(),
  state: stateSchema, events: z.array(auditEventSchema).min(1),
}).refine((t) => t.spec_id === t.state.spec.id && (t.expected === null ? t.mutation.kind === "create" :
  t.expected.head.spec_id === t.spec_id && t.mutation.kind !== "create"), "invalid-transaction-scope");
export const commitPayloadSchema = z.strictObject({
  schema: z.literal("aira.dev/store-commit-payload/v1"), spec_id: specIdSchema, sequence: positiveSequenceSchema,
  parent: contentHashSchema.nullable(), at: timestampSchema, spec_generation: specGenerationSchema,
  run_id: runIdV2Schema.nullable(), run_generation: runGenerationSchema, run_generations: z.array(runCounterSchema),
  operation_hash: contentHashSchema, transaction: transactionSchema,
});
export const commitSchema = z.strictObject({
  schema: z.literal("aira.dev/store-commit/v1"), id: contentHashSchema, payload: commitPayloadSchema,
});
export type StoreState = DeepReadonly<z.infer<typeof stateSchema>>;
export type StoreHead = DeepReadonly<z.infer<typeof headSchema>>;
export type StoreTransaction = DeepReadonly<z.infer<typeof transactionSchema>>;
export type StoreCommit = DeepReadonly<z.infer<typeof commitSchema>>;
export type StoreSnapshot = { readonly head: StoreHead; readonly state: StoreState; readonly records: readonly DomainRecord[] };
export type TransactionResult = StoreSnapshot & { readonly spec_id: StoreHead["spec_id"]; readonly commit_id: StoreHead["commit_id"];
  readonly sequence: StoreHead["sequence"]; readonly spec_generation: StoreHead["spec_generation"];
  readonly run_generation: StoreHead["run_generation"]; readonly run_generations: StoreHead["run_generations"];
  readonly operation: StoreTransaction["operation"]; readonly replayed: boolean };
export interface BlobInput { readonly hash: z.infer<typeof contentHashSchema>; readonly bytes: Uint8Array }
export interface HistoryOptions { readonly limit?: number; readonly before?: StoreHead["commit_id"] }
export interface VerificationReport { readonly head: StoreHead; readonly commits: number; readonly records: number; readonly blobs: number }
export type LoadMode = "current" | "full" | "deep";
