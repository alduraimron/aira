import { z } from "zod";
import { sliceIdSchema, runIdV2Schema, verifierIdSchema, evidenceIdSchema } from "./ids";
import { artifactReferenceSchema } from "./artifacts";
import { runGenerationSchema } from "./generations";
import { nonBlankSchema, timestampSchema, unique, type DeepReadonly } from "./primitives";

export const sliceExecutionStatusSchema = z.enum(["pending", "ready", "running", "verifying", "completed", "failed", "blocked", "interrupted", "skipped", "cancelled", "unknown"]);
export const sliceExecutionStateSchema = z.strictObject({
  schema: z.literal("aira.dev/slice-state/v1"), slice: sliceIdSchema,
  plan: artifactReferenceSchema.refine((r) => r.kind === "slice-plan"), run: runIdV2Schema, run_generation: runGenerationSchema,
  status: sliceExecutionStatusSchema, current_evidence: z.array(z.strictObject({ verifier: verifierIdSchema, evidence: evidenceIdSchema })),
  reason: nonBlankSchema.optional(), updated_at: timestampSchema,
}).refine((s) => unique(s.current_evidence.map((e) => e.verifier)), "duplicate-slice-evidence-selection");
export type SliceExecutionState = DeepReadonly<z.infer<typeof sliceExecutionStateSchema>>;
export type SliceExecutionStatus = z.infer<typeof sliceExecutionStatusSchema>;
