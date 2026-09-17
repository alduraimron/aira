import { z } from "zod";
import { contentHashSchema } from "../spec/domain/primitives";

const dottedName = "[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)*";
const resourceNamespace = "(?:steering|project\\.steering|template\\.steering|interop\\.steering|imported\\.steering)";

/** Logical project-scoped identity. It is never a materialization path. */
export const steeringResourceIdSchema = z.string().max(240)
  .regex(new RegExp(`^${resourceNamespace}\\.${dottedName}$`), "invalid-steering-resource-id")
  .brand<"SteeringResourceId">();

export const steeringCustomCategorySchema = z.string().max(160)
  .regex(new RegExp(`^${dottedName}$`), "invalid-steering-custom-category")
  .brand<"SteeringCustomCategory">();

/** Stable structured-rule identity, independent of document position and headings. */
export const steeringRuleIdSchema = z.string().max(240)
  .regex(new RegExp(`^rule\\.${dottedName}$`), "invalid-steering-rule-id")
  .brand<"SteeringRuleId">();

/** Shared semantic slot used by the later conflict detector. */
export const steeringSemanticKeySchema = z.string().max(240)
  .regex(new RegExp(`^topic\\.${dottedName}$`), "invalid-steering-semantic-key")
  .brand<"SteeringSemanticKey">();

const MAX_U64 = 18446744073709551615n;
const canonicalU64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/, "invalid-steering-u64")
  .refine((value) => /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= MAX_U64, "steering-u64-overflow");
const positiveU64 = z.string().regex(/^[1-9][0-9]{0,19}$/, "invalid-steering-revision-id")
  .refine((value) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= MAX_U64, "steering-revision-overflow");

/** A revision is the immutable positive-u64 component of a resource identity. */
export const steeringRevisionIdSchema = positiveU64.brand<"SteeringRevisionId">();

/** Project Steering semantic generation, distinct from storage and Spec counters. */
export const steeringGenerationSchema = canonicalU64.brand<"SteeringGeneration">();

/** Declared now so later snapshots do not need to change the identity vocabulary. */
export const steeringSnapshotIdSchema = z.string()
  .regex(/^steering_snapshot_[a-z0-9][a-z0-9_-]{0,63}$/, "invalid-steering-snapshot-id")
  .brand<"SteeringSnapshotId">();

export const steeringRevisionReferenceSchema = z.strictObject({
  id: steeringResourceIdSchema,
  revision: steeringRevisionIdSchema,
  hash: contentHashSchema,
});

export type SteeringResourceId = z.infer<typeof steeringResourceIdSchema>;
export type SteeringCustomCategory = z.infer<typeof steeringCustomCategorySchema>;
export type SteeringRuleId = z.infer<typeof steeringRuleIdSchema>;
export type SteeringSemanticKey = z.infer<typeof steeringSemanticKeySchema>;
export type SteeringRevisionId = z.infer<typeof steeringRevisionIdSchema>;
export type SteeringGeneration = z.infer<typeof steeringGenerationSchema>;
export type SteeringSnapshotId = z.infer<typeof steeringSnapshotIdSchema>;
export type SteeringRevisionReference = Readonly<z.infer<typeof steeringRevisionReferenceSchema>>;

export const steeringRevisionKey = (reference: Pick<SteeringRevisionReference, "id" | "revision">): string =>
  `${reference.id}@${reference.revision}`;
