import { z } from "zod";
import { RUN_ID_PATTERN } from "./paths";
import { artifactObservationSchema } from "./artifacts";
import { digestSchema, locatorSchema, observedBytesSchema, identityHash, type ReadonlyData } from "./identity";

export const sourceObservationSchema = z.strictObject({
  schema: z.literal("aira.dev/legacy-v1-observation/v1"), locator: locatorSchema,
  original_run_id: z.string().regex(RUN_ID_PATTERN).nullable(),
  run_json: observedBytesSchema.nullable(), artifacts: z.array(artifactObservationSchema),
}).refine((s) => new Set(s.artifacts.map((a) => a.path)).size === s.artifacts.length && (s.run_json !== null || s.original_run_id === null));
export const sourceIdentitySchema = z.strictObject({ id: digestSchema, observation: sourceObservationSchema })
  .refine((s) => identityHash(s.observation) === s.id, "source-identity-mismatch");
export type SourceIdentity = ReadonlyData<z.infer<typeof sourceIdentitySchema>>;
