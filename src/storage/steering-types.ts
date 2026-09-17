import { z } from "zod";
import { canonicalBytes, hashBytes } from "../canonical-json";
import { operationIdSchema, type OperationId } from "../spec/domain/ids";
import { commitSequenceSchema, type CommitSequence } from "../spec/domain/generations";
import {
  blobReferenceSchema,
  channelSchema,
  compareText,
  contentHashSchema,
  humanActorSchema,
  nonBlankSchema,
  safeUnsignedSchema,
  timestampSchema,
  type ContentHash,
  type DeepReadonly,
} from "../spec/domain/primitives";
import {
  steeringCustomCategorySchema,
  steeringGenerationSchema,
  steeringResourceIdSchema,
  steeringRevisionReferenceSchema,
  type SteeringGeneration,
  type SteeringResourceId,
  type SteeringRevisionReference,
} from "../steering/ids";
import {
  steeringCompatibilitySchema,
  steeringCompositionSchema,
  steeringLayerSchema,
  steeringProjectNamespaceSchema,
  steeringProvenanceSchema,
  steeringResourceKindSchema,
  steeringResourceRevisionSchema,
} from "../steering/schema";
import type { SteeringResourceRevision } from "../steering/types";

export const STEERING_REGISTRY_SCHEMA = "aira.dev/steering-registry/v1" as const;
export const STEERING_TRANSACTION_SCHEMA = "aira.dev/steering-store-transaction/v1" as const;
export const STEERING_COMMIT_PAYLOAD_SCHEMA = "aira.dev/steering-store-commit-payload/v1" as const;
export const STEERING_COMMIT_SCHEMA = "aira.dev/steering-store-commit/v1" as const;
export const STEERING_HEAD_SCHEMA = "aira.dev/steering-store-head/v1" as const;
export const STEERING_RESOURCE_RECORD_CONTRACT = "aira.dev/steering-resource/v1" as const;
export const STEERING_RESOURCE_RECORD_ENCODING = "aira.dev/canonical-json/v1" as const;
export const STEERING_RESOURCE_RECORD_MEDIA_TYPE = "application/vnd.aira.steering-resource+json" as const;

const canonicalIds = (values: readonly string[]): boolean => values.every((value, index) =>
  index === 0 || compareText(values[index - 1]!, value) < 0);

export const steeringRevisionRecordReferenceSchema = z.strictObject({
  contract: z.literal(STEERING_RESOURCE_RECORD_CONTRACT),
  hash: contentHashSchema,
  bytes: safeUnsignedSchema,
  encoding: z.literal(STEERING_RESOURCE_RECORD_ENCODING),
  media_type: z.literal(STEERING_RESOURCE_RECORD_MEDIA_TYPE),
});

/**
 * Commit-bound discovery metadata for one immutable Steering revision. The full
 * aira.dev/steering-resource/v1 record is addressed by `record`; `content`
 * addresses the exact unnormalized body bytes.
 */
export const steeringRegistryRevisionSchema = z.strictObject({
  identity: steeringRevisionReferenceSchema,
  record: steeringRevisionRecordReferenceSchema,
  kind: steeringResourceKindSchema,
  custom_kind: steeringCustomCategorySchema.optional(),
  layer: steeringLayerSchema,
  provenance: steeringProvenanceSchema,
  content: blobReferenceSchema,
  content_encoding: z.literal("aira.dev/steering-bytes/raw/v1"),
  composition: steeringCompositionSchema,
  compatibility: steeringCompatibilitySchema,
  supersedes: steeringRevisionReferenceSchema.optional(),
}).superRefine((revision, ctx) => {
  if ((revision.kind === "custom") !== (revision.custom_kind !== undefined))
    ctx.addIssue({ code: "custom", message: "invalid-steering-custom-kind" });
  if (revision.identity.hash !== revision.content.hash)
    ctx.addIssue({ code: "custom", message: "steering-content-identity-mismatch" });
});

export const steeringRegistryResourceSchema = z.strictObject({
  id: steeringResourceIdSchema,
  status: z.enum(["active", "retired"]),
  current: steeringRevisionReferenceSchema.nullable(),
  revisions: z.array(steeringRegistryRevisionSchema).min(1),
}).superRefine((resource, ctx) => {
  if (resource.revisions.some((revision) => revision.identity.id !== resource.id))
    ctx.addIssue({ code: "custom", message: "steering-registry-resource-identity-mismatch" });
  if (resource.revisions.some((revision, index) => index > 0 &&
    BigInt(resource.revisions[index - 1]!.identity.revision) >= BigInt(revision.identity.revision)))
    ctx.addIssue({ code: "custom", message: "noncanonical-steering-registry-revision-order" });
  const last = resource.revisions.at(-1)!.identity;
  if (resource.status === "active" && (resource.current === null ||
    resource.current.id !== last.id || resource.current.revision !== last.revision || resource.current.hash !== last.hash))
    ctx.addIssue({ code: "custom", message: "steering-registry-current-revision-mismatch" });
  if (resource.status === "retired" && resource.current !== null)
    ctx.addIssue({ code: "custom", message: "retired-steering-resource-has-current-revision" });
});

export const steeringRegistrySchema = z.strictObject({
  schema: z.literal(STEERING_REGISTRY_SCHEMA),
  project: steeringProjectNamespaceSchema,
  generation: steeringGenerationSchema,
  resources: z.array(steeringRegistryResourceSchema),
}).refine((registry) => canonicalIds(registry.resources.map((resource) => resource.id)),
  "noncanonical-steering-registry-resource-order");

export const steeringHeadSchema = z.strictObject({
  schema: z.literal(STEERING_HEAD_SCHEMA),
  project: steeringProjectNamespaceSchema,
  commit_id: contentHashSchema,
  sequence: commitSequenceSchema.refine((sequence) => sequence !== "0", "genesis-sequence-is-one"),
  steering_generation: steeringGenerationSchema,
});

export const steeringResourceExpectationSchema = z.discriminatedUnion("status", [
  z.strictObject({ id: steeringResourceIdSchema, status: z.literal("absent") }),
  z.strictObject({ id: steeringResourceIdSchema, status: z.literal("active"), current: steeringRevisionReferenceSchema }),
  z.strictObject({ id: steeringResourceIdSchema, status: z.literal("retired") }),
]);

export const steeringExpectedStateSchema = z.strictObject({
  head: steeringHeadSchema,
  resources: z.array(steeringResourceExpectationSchema)
    .refine((resources) => canonicalIds(resources.map((resource) => resource.id)),
      "noncanonical-steering-resource-expectations"),
});

export const steeringMutationSchema = z.strictObject({
  kind: z.enum(["create", "publish", "retire", "registry", "audit"]),
  resources: z.array(steeringResourceIdSchema)
    .refine(canonicalIds, "noncanonical-steering-mutation-resources"),
  reason: nonBlankSchema,
}).refine((mutation) => mutation.kind === "create" || mutation.kind === "audit" || mutation.resources.length > 0,
  "steering-semantic-mutation-requires-resource").refine((mutation) => mutation.kind !== "audit" || mutation.resources.length === 0,
  "steering-audit-mutation-cannot-name-resource");

export const steeringStoreActorSchema = z.discriminatedUnion("kind", [
  humanActorSchema,
  z.strictObject({ kind: z.literal("system"), id: nonBlankSchema, implementation: nonBlankSchema }),
]);

export const steeringAuditEventSchema = z.strictObject({
  kind: nonBlankSchema,
  resources: z.array(steeringResourceIdSchema)
    .refine(canonicalIds, "noncanonical-steering-audit-resources"),
  detail: nonBlankSchema.optional(),
  payloads: z.array(blobReferenceSchema),
});

export const steeringTransactionSchema = z.strictObject({
  schema: z.literal(STEERING_TRANSACTION_SCHEMA),
  project: steeringProjectNamespaceSchema,
  operation: operationIdSchema,
  expected: steeringExpectedStateSchema.nullable(),
  mutation: steeringMutationSchema,
  actor: steeringStoreActorSchema,
  channel: channelSchema.optional(),
  registry: steeringRegistrySchema,
  events: z.array(steeringAuditEventSchema).min(1),
}).superRefine((transaction, ctx) => {
  if (transaction.project !== transaction.registry.project)
    ctx.addIssue({ code: "custom", message: "steering-transaction-project-mismatch" });
  const creation = transaction.expected === null;
  if (creation !== (transaction.mutation.kind === "create"))
    ctx.addIssue({ code: "custom", message: "invalid-steering-transaction-scope" });
  if (transaction.expected !== null) {
    if (transaction.expected.head.project !== transaction.project)
      ctx.addIssue({ code: "custom", message: "steering-expected-project-mismatch" });
    const expectedIds = transaction.expected.resources.map((resource) => resource.id);
    if (expectedIds.length !== transaction.mutation.resources.length ||
      expectedIds.some((id, index) => id !== transaction.mutation.resources[index]))
      ctx.addIssue({ code: "custom", message: "steering-mutation-resource-expectations-incomplete" });
  } else {
    const ids = transaction.registry.resources.map((resource) => resource.id);
    if (ids.length !== transaction.mutation.resources.length || ids.some((id, index) => id !== transaction.mutation.resources[index]))
      ctx.addIssue({ code: "custom", message: "steering-genesis-resource-list-mismatch" });
  }
});

export const steeringCommitPayloadSchema = z.strictObject({
  schema: z.literal(STEERING_COMMIT_PAYLOAD_SCHEMA),
  project: steeringProjectNamespaceSchema,
  sequence: commitSequenceSchema.refine((sequence) => sequence !== "0", "genesis-sequence-is-one"),
  parent: contentHashSchema.nullable(),
  at: timestampSchema,
  steering_generation: steeringGenerationSchema,
  operation_hash: contentHashSchema,
  transaction: steeringTransactionSchema,
});

export const steeringCommitSchema = z.strictObject({
  schema: z.literal(STEERING_COMMIT_SCHEMA),
  id: contentHashSchema,
  payload: steeringCommitPayloadSchema,
});

export type SteeringRevisionRecordReference = DeepReadonly<z.infer<typeof steeringRevisionRecordReferenceSchema>>;
export type SteeringRegistryRevision = DeepReadonly<z.infer<typeof steeringRegistryRevisionSchema>>;
export type SteeringRegistryResource = DeepReadonly<z.infer<typeof steeringRegistryResourceSchema>>;
export type SteeringRegistry = DeepReadonly<z.infer<typeof steeringRegistrySchema>>;
export type SteeringHead = DeepReadonly<z.infer<typeof steeringHeadSchema>>;
export type SteeringResourceExpectation = DeepReadonly<z.infer<typeof steeringResourceExpectationSchema>>;
export type SteeringExpectedState = DeepReadonly<z.infer<typeof steeringExpectedStateSchema>>;
export type SteeringTransaction = DeepReadonly<z.infer<typeof steeringTransactionSchema>>;
export type SteeringCommit = DeepReadonly<z.infer<typeof steeringCommitSchema>>;

export interface SteeringRevisionPublication {
  readonly revision: SteeringResourceRevision;
  readonly body: Uint8Array;
}
export interface SteeringStoreSnapshot {
  readonly head: SteeringHead;
  readonly registry: SteeringRegistry;
  readonly revisions: readonly SteeringResourceRevision[];
}
export type SteeringTransactionResult = SteeringStoreSnapshot & {
  readonly project: SteeringHead["project"];
  readonly commit_id: ContentHash;
  readonly sequence: CommitSequence;
  readonly steering_generation: SteeringGeneration;
  readonly operation: OperationId;
  readonly replayed: boolean;
};
export interface SteeringHistoryOptions {
  readonly limit?: number;
  readonly before?: ContentHash;
}
export interface SteeringVerificationReport {
  readonly head: SteeringHead;
  readonly commits: number;
  readonly revisions: number;
  readonly blobs: number;
}
export type SteeringLoadMode = "current" | "full" | "deep";

/** Exact immutable record locator for a validated pure-domain revision. */
export function steeringRegistryRevisionOf(input: SteeringResourceRevision): SteeringRegistryRevision {
  const revision = steeringResourceRevisionSchema.parse(input);
  const bytes = canonicalBytes(revision);
  return steeringRegistryRevisionSchema.parse({
    identity: revision.identity,
    record: {
      contract: STEERING_RESOURCE_RECORD_CONTRACT,
      hash: hashBytes(bytes),
      bytes: bytes.length,
      encoding: STEERING_RESOURCE_RECORD_ENCODING,
      media_type: STEERING_RESOURCE_RECORD_MEDIA_TYPE,
    },
    kind: revision.kind,
    ...(revision.custom_kind === undefined ? {} : { custom_kind: revision.custom_kind }),
    layer: revision.layer,
    provenance: revision.provenance,
    content: revision.content,
    content_encoding: revision.content_encoding,
    composition: revision.composition,
    compatibility: revision.compatibility,
    ...(revision.supersedes === undefined ? {} : { supersedes: revision.supersedes }),
  });
}

export function steeringExpectationFor(
  registry: SteeringRegistry,
  id: SteeringResourceId,
): SteeringResourceExpectation {
  const resource = registry.resources.find((entry) => entry.id === id);
  if (!resource) return { id, status: "absent" };
  if (resource.status === "retired") return { id, status: "retired" };
  return { id, status: "active", current: resource.current as SteeringRevisionReference };
}
