import { z } from "zod";
import { attemptIdSchema, operationIdSchema } from "../spec/domain/ids";
import { blobReferenceSchema, createdMetadataSchema, nonBlankSchema, profileReferenceSchema, safeUnsignedSchema, unique, canonical, compareText } from "../spec/domain/primitives";

export const attemptOutcomeSchema = z.enum(["succeeded", "failed", "interrupted", "cancelled", "timed_out", "unknown"]);
export const recoveryCharacteristicSchema = z.enum(["replay_safe", "idempotent", "reconcilable", "non_replayable"]);
export const recoveryDeclarationSchema = z.strictObject({
  characteristic: recoveryCharacteristicSchema, scope: nonBlankSchema, assumptions: z.array(nonBlankSchema),
  guarantee: profileReferenceSchema,
  idempotency_operation: operationIdSchema.optional(), reconciliation: profileReferenceSchema.optional(),
}).refine((r) => (r.characteristic !== "idempotent" || r.idempotency_operation !== undefined) &&
  (r.characteristic !== "reconcilable" || r.reconciliation !== undefined), "recovery-safeguard-required");
export const retryPolicySchema = z.strictObject({
  schema: z.literal("aira.dev/retry-policy/v1"), automatic: z.boolean(),
  max_attempts: safeUnsignedSchema.refine((n) => n > 0), outcomes: z.array(attemptOutcomeSchema).refine(unique),
});
export const reconciliationRecordSchema = z.strictObject({
  schema: z.literal("aira.dev/reconciliation/v1"), operation: operationIdSchema, attempt: attemptIdSchema,
  mechanism: profileReferenceSchema, created: createdMetadataSchema,
  disposition: z.enum(["retry-safe", "succeeded", "failed", "unknown"]), evidence: z.array(blobReferenceSchema).min(1),
});
export type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>;
export type RecoveryDeclaration = z.infer<typeof recoveryDeclarationSchema>;
export type RetryPolicy = z.infer<typeof retryPolicySchema>;
export type ReconciliationRecord = z.infer<typeof reconciliationRecordSchema>;
export interface RetryInput {
  readonly attempt: z.infer<typeof attemptIdSchema>;
  readonly operation: z.infer<typeof operationIdSchema>;
  readonly outcome: AttemptOutcome;
  readonly external_effects: "none" | "known" | "unknown";
  readonly authority: "current" | "fenced";
  readonly attempts_so_far: number;
  readonly declarations: readonly RecoveryDeclaration[];
  readonly policy: RetryPolicy;
  readonly reconciliations: readonly ReconciliationRecord[];
}
export interface RetryDecision { readonly action: "retry-allowed" | "forbidden" | "reconciliation-required" | "human-intervention"; readonly code: string }
export function automaticRetryDecision(input: RetryInput): RetryDecision {
  if (input.authority !== "current") return { action: "forbidden", code: "attempt-fenced" };
  if (input.outcome === "succeeded") return { action: "forbidden", code: "attempt-already-succeeded" };
  if (!input.policy.automatic || !input.policy.outcomes.includes(input.outcome)) return { action: "forbidden", code: "retry-policy-denied" };
  if (!Number.isSafeInteger(input.attempts_so_far) || input.attempts_so_far < 1 || input.attempts_so_far >= input.policy.max_attempts)
    return { action: "forbidden", code: "retry-budget-exhausted" };
  if (!input.declarations.length) return { action: "human-intervention", code: "recovery-undeclared" };
  let reconcile = false;
  for (const declaration of [...input.declarations].sort((a, b) => compareText(canonical(a), canonical(b)))) {
    if (declaration.characteristic === "idempotent" && declaration.idempotency_operation !== input.operation)
      return { action: "human-intervention", code: "idempotency-identity-mismatch" };
    // Even known failures can have effects. Never infer replay safety from a negative exit.
    if (declaration.characteristic === "reconcilable" || declaration.characteristic === "non_replayable") {
      const resolution = input.reconciliations.filter((r) => r.attempt === input.attempt &&
        r.mechanism.id === declaration.reconciliation?.id && r.mechanism.revision === declaration.reconciliation.revision &&
        r.mechanism.hash === declaration.reconciliation.hash);
      if (resolution.length === 1 && resolution[0]!.disposition === "retry-safe") continue;
      if (declaration.characteristic === "non_replayable" && !declaration.reconciliation)
        return { action: "human-intervention", code: "non-replayable-operation" };
      reconcile = true;
    }
  }
  return reconcile ? { action: "reconciliation-required", code: "reconciliation-required" } : { action: "retry-allowed", code: "declared-recovery-safe" };
}
