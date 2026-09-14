import { z } from "zod";
import { attemptIdSchema, operationIdSchema, revisionRequestIdSchema, specIdSchema } from "../spec/domain/ids";
import { artifactReferenceSchema } from "../spec/domain/artifacts";
import { channelSchema, humanActorSchema, nonBlankSchema, timestampSchema } from "../spec/domain/primitives";

export const revisionResolutionSchema = z.strictObject({
  resulting_artifact: artifactReferenceSchema, at: timestampSchema,
  attempt: attemptIdSchema.optional(), operation: operationIdSchema,
});
const common = {
  schema: z.literal("aira.dev/revision-request/v2"), id: revisionRequestIdSchema, spec_id: specIdSchema,
  previous_artifact: artifactReferenceSchema,
  // Validation checks content but never transforms exact human feedback.
  feedback: nonBlankSchema, actor: humanActorSchema, channel: channelSchema.optional(),
  requested_at: timestampSchema, operation: operationIdSchema,
};
export const revisionRequestSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...common, status: z.literal("pending") }),
  z.strictObject({ ...common, status: z.literal("resolved"), resolution: revisionResolutionSchema }),
  z.strictObject({ ...common, status: z.literal("cancelled"), at: timestampSchema, reason: nonBlankSchema }),
  z.strictObject({ ...common, status: z.literal("superseded"), at: timestampSchema, reason: nonBlankSchema, superseded_by: revisionRequestIdSchema }),
]).refine((r) => r.status !== "resolved" ||
  (r.resolution.resulting_artifact.kind === r.previous_artifact.kind &&
    r.resolution.resulting_artifact.revision !== r.previous_artifact.revision &&
    Date.parse(r.resolution.at) >= Date.parse(r.requested_at)), "invalid-revision-resolution");
