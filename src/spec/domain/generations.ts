import { z } from "zod";
import { attemptIdSchema, claimIdSchema, operationIdSchema, runIdV2Schema, specIdSchema } from "./ids";
import { contentHashSchema, nonBlankSchema, type DomainResult } from "./primitives";

const MAX = (1n << 64n) - 1n;
// Canonical decimal u64 strings avoid JSON floating-point precision loss.
const counter = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine((s) => {
  try { return BigInt(s) <= MAX; } catch { return false; }
}, "counter-overflow");
export const commitSequenceSchema = counter.brand<"CommitSequence">();
export const specGenerationSchema = counter.brand<"SpecGeneration">();
export const runGenerationSchema = counter.brand<"RunGeneration">();
export const fenceEpochSchema = counter.brand<"FenceEpoch">();
export type CommitSequence = z.infer<typeof commitSequenceSchema>;
export type SpecGeneration = z.infer<typeof specGenerationSchema>;
export type RunGeneration = z.infer<typeof runGenerationSchema>;
export type FenceEpoch = z.infer<typeof fenceEpochSchema>;
export function successor<T extends CommitSequence | SpecGeneration | RunGeneration | FenceEpoch>(value: T): DomainResult<T> {
  if (BigInt(value) === MAX) return { ok: false, issues: [{ code: "generation-overflow" }] };
  return { ok: true, value: (BigInt(value) + 1n).toString() as T };
}
export const fenceTokenSchema = z.strictObject({
  run: runIdV2Schema, claim: claimIdSchema, attempt: attemptIdSchema,
  owner: nonBlankSchema, epoch: fenceEpochSchema,
});
export type FenceToken = z.infer<typeof fenceTokenSchema>;
export const transactionPreconditionsSchema = z.strictObject({
  schema: z.literal("aira.dev/transaction-preconditions/v1"),
  operation: operationIdSchema,
  expected_commit: z.strictObject({ sequence: commitSequenceSchema, hash: contentHashSchema }),
  spec: specIdSchema.optional(), expected_spec_generation: specGenerationSchema.optional(),
  run: runIdV2Schema.optional(), expected_run_generation: runGenerationSchema.optional(),
  expected_fence: fenceTokenSchema.optional(),
}).refine((p) => (p.spec !== undefined) === (p.expected_spec_generation !== undefined) &&
  (p.run !== undefined) === (p.expected_run_generation !== undefined) &&
  (p.expected_fence === undefined || p.expected_fence.run === p.run), "invalid-transaction-preconditions");
/** Bookkeeping is explicitly separate from Spec semantic mutation (INV-GEN-002). */
export function advanceGenerations(
  current: { commit: CommitSequence; spec: SpecGeneration; run: RunGeneration },
  mutation: { spec: boolean; run: boolean },
): DomainResult<typeof current> {
  const commit = successor(current.commit);
  const spec = mutation.spec ? successor(current.spec) : { ok: true as const, value: current.spec };
  const run = mutation.run ? successor(current.run) : { ok: true as const, value: current.run };
  if (!commit.ok || !spec.ok || !run.ok) return { ok: false, issues: [{ code: "generation-overflow" }] };
  return { ok: true, value: { commit: commit.value, spec: spec.value, run: run.value } };
}
