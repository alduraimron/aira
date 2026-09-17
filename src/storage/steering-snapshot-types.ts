import { z } from "zod";
import { canonicalBytes, hashBytes } from "../canonical-json";
import { operationIdSchema } from "../spec/domain/ids";
import {
  channelSchema,
  contentHashSchema,
  exact,
  safeUnsignedSchema,
  timestampSchema,
  type ContentHash,
  type DeepReadonly,
} from "../spec/domain/primitives";
import {
  steeringRevisionReferenceSchema,
  steeringSnapshotIdSchema,
  type SteeringSnapshotId,
} from "../steering/ids";
import {
  steeringSnapshotReferenceSchema,
  steeringSnapshotSchema,
  type SteeringSnapshot,
} from "../steering/snapshot";
import {
  steeringHeadSchema,
  steeringStoreActorSchema,
  type SteeringHead,
} from "./steering-types";

export const STEERING_SNAPSHOT_RECORD_SCHEMA = "aira.dev/steering-snapshot-record/v1" as const;
export const STEERING_SNAPSHOT_LOCATOR_SCHEMA = "aira.dev/steering-snapshot-locator/v1" as const;
export const STEERING_SNAPSHOT_RECORD_ENCODING = "aira.dev/canonical-json/v1" as const;
export const STEERING_SNAPSHOT_RECORD_MEDIA_TYPE = "application/vnd.aira.steering-snapshot-record+json" as const;

export const steeringSnapshotRecordReferenceSchema = z.strictObject({
  contract: z.literal(STEERING_SNAPSHOT_RECORD_SCHEMA),
  hash: contentHashSchema,
  bytes: safeUnsignedSchema,
  encoding: z.literal(STEERING_SNAPSHOT_RECORD_ENCODING),
  media_type: z.literal(STEERING_SNAPSHOT_RECORD_MEDIA_TYPE),
});

export const steeringSnapshotSourceSchema = z.strictObject({
  head: steeringHeadSchema,
  resources: z.array(steeringRevisionReferenceSchema),
}).refine((source) => new Set(source.resources.map((resource) =>
  `${resource.id}@${resource.revision}:${resource.hash}`)).size === source.resources.length,
"duplicate-steering-snapshot-source-resource");

export const steeringSnapshotPublicationSchema = z.strictObject({
  at: timestampSchema,
  by: steeringStoreActorSchema,
  operation: operationIdSchema,
  channel: channelSchema.optional(),
});

export const steeringSnapshotPublicationMetadataSchema = z.strictObject({
  source: steeringSnapshotSourceSchema,
  publication: steeringSnapshotPublicationSchema,
});

export const steeringSnapshotRecordSchema = z.strictObject({
  schema: z.literal(STEERING_SNAPSHOT_RECORD_SCHEMA),
  snapshot_id: steeringSnapshotIdSchema,
  semantic_hash: contentHashSchema,
  snapshot: steeringSnapshotSchema,
  source: steeringSnapshotSourceSchema,
  publication: steeringSnapshotPublicationSchema,
}).superRefine((record, ctx) => {
  if (record.snapshot_id !== record.snapshot.id)
    ctx.addIssue({ code: "custom", path: ["snapshot_id"], message: "steering-snapshot-record-id-mismatch" });
  if (record.semantic_hash !== record.snapshot.content.hash)
    ctx.addIssue({ code: "custom", path: ["semantic_hash"], message: "steering-snapshot-record-semantic-hash-mismatch" });
  if (record.source.head.project !== record.snapshot.semantic.project)
    ctx.addIssue({ code: "custom", path: ["source", "head", "project"], message: "steering-snapshot-record-project-mismatch" });
  const expected = record.snapshot.semantic.resources.map((resource) => resource.revision.identity);
  if (!exact(record.source.resources, expected))
    ctx.addIssue({ code: "custom", path: ["source", "resources"], message: "steering-snapshot-record-source-revisions-mismatch" });
});

export const steeringSnapshotLocatorSchema = z.strictObject({
  schema: z.literal(STEERING_SNAPSHOT_LOCATOR_SCHEMA),
  snapshot: steeringSnapshotReferenceSchema,
  project: steeringHeadSchema.shape.project,
  record: steeringSnapshotRecordReferenceSchema,
});

export type SteeringSnapshotRecordReference = DeepReadonly<z.infer<typeof steeringSnapshotRecordReferenceSchema>>;
export type SteeringSnapshotSource = DeepReadonly<z.infer<typeof steeringSnapshotSourceSchema>>;
export type SteeringSnapshotPublication = DeepReadonly<z.infer<typeof steeringSnapshotPublicationSchema>>;
export type SteeringSnapshotPublicationMetadata = DeepReadonly<z.infer<typeof steeringSnapshotPublicationMetadataSchema>>;
export type SteeringSnapshotRecord = DeepReadonly<z.infer<typeof steeringSnapshotRecordSchema>>;
export type SteeringSnapshotLocator = DeepReadonly<z.infer<typeof steeringSnapshotLocatorSchema>>;

export interface SteeringSnapshotPutResult {
  readonly snapshot: SteeringSnapshot;
  readonly record: SteeringSnapshotRecord;
  readonly locator: SteeringSnapshotLocator;
  readonly reused: boolean;
}

export interface SteeringSnapshotVerificationReport {
  readonly snapshot_id: SteeringSnapshotId;
  readonly semantic_hash: ContentHash;
  readonly record_hash: ContentHash;
  readonly source_head: SteeringHead;
  readonly resources: number;
  readonly blobs: number;
}

export function steeringSnapshotRecordOf(
  snapshot: SteeringSnapshot,
  metadata: SteeringSnapshotPublicationMetadata,
): SteeringSnapshotRecord {
  return steeringSnapshotRecordSchema.parse({
    schema: STEERING_SNAPSHOT_RECORD_SCHEMA,
    snapshot_id: snapshot.id,
    semantic_hash: snapshot.content.hash,
    snapshot,
    source: metadata.source,
    publication: metadata.publication,
  });
}

export function steeringSnapshotRecordReferenceOf(record: SteeringSnapshotRecord): SteeringSnapshotRecordReference {
  const bytes = canonicalBytes(record);
  return steeringSnapshotRecordReferenceSchema.parse({
    contract: STEERING_SNAPSHOT_RECORD_SCHEMA,
    hash: hashBytes(bytes),
    bytes: bytes.length,
    encoding: STEERING_SNAPSHOT_RECORD_ENCODING,
    media_type: STEERING_SNAPSHOT_RECORD_MEDIA_TYPE,
  });
}

export function steeringSnapshotLocatorOf(
  record: SteeringSnapshotRecord,
  reference = steeringSnapshotRecordReferenceOf(record),
): SteeringSnapshotLocator {
  return steeringSnapshotLocatorSchema.parse({
    schema: STEERING_SNAPSHOT_LOCATOR_SCHEMA,
    snapshot: { id: record.snapshot_id, hash: record.semantic_hash },
    project: record.snapshot.semantic.project,
    record: reference,
  });
}
