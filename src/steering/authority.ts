import { z } from "zod";
import { canonical, compareText, policyReferenceSchema, profileReferenceSchema, stableIssues, type DomainIssue } from "../spec/domain/primitives";
import { verifierReferenceSchema } from "../verification/schema";

export const steeringAuthoritySchema = z.enum(["descriptive", "normative", "enforceable"]);
export const steeringRuleEffectSchema = z.enum(["describe", "prefer", "require", "forbid"]);
export const steeringOverridePolicySchema = z.enum(["sealed", "narrower-scope", "explicit-replacement"]);
export const versionedContractSchema = z.string().max(240)
  .regex(/^[a-z][a-z0-9.-]*\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*\/v[1-9][0-9]*$/, "invalid-versioned-contract");
export const versionedEnforcementContractSchema = versionedContractSchema;

export const steeringEnforcementBindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("capability-policy"),
    policy: policyReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal("verifier"),
    verifier: verifierReferenceSchema,
    use: z.enum(["advisory", "required"]),
  }),
  z.strictObject({
    kind: z.literal("repository-check"),
    check: z.enum(["architecture-boundary", "static-analysis", "repository-state"]),
    verifier: verifierReferenceSchema,
    use: z.enum(["advisory", "required"]),
  }),
  z.strictObject({
    kind: z.literal("extension"),
    contract: versionedEnforcementContractSchema,
    mechanism: profileReferenceSchema,
    use: z.enum(["advisory", "required"]),
  }),
]);

export type SteeringAuthorityValue = z.infer<typeof steeringAuthoritySchema>;
export type SteeringEnforcementBindingValue = z.infer<typeof steeringEnforcementBindingSchema>;

export function enforcementBindingIdentity(binding: SteeringEnforcementBindingValue): string {
  switch (binding.kind) {
    case "capability-policy": return `capability-policy:${binding.policy.id}@${binding.policy.revision}`;
    case "verifier": return `verifier:${binding.verifier.id}@${binding.verifier.revision}`;
    case "repository-check": return `repository-check:${binding.check}:${binding.verifier.id}@${binding.verifier.revision}`;
    case "extension": return `extension:${binding.contract}:${binding.mechanism.id}@${binding.mechanism.revision}`;
  }
}

export function isRequiredEnforcementBinding(binding: SteeringEnforcementBindingValue): boolean {
  return binding.kind === "capability-policy" || binding.use === "required";
}

export const steeringEnforcementBindingsSchema = z.array(steeringEnforcementBindingSchema).superRefine((bindings, ctx) => {
  const identities = new Map<string, string>();
  for (const binding of bindings) {
    const identity = enforcementBindingIdentity(binding);
    const encoded = canonical(binding);
    const previous = identities.get(identity);
    if (previous === encoded) ctx.addIssue({ code: "custom", message: "duplicate-steering-enforcement-binding" });
    else if (previous !== undefined) ctx.addIssue({ code: "custom", message: "conflicting-steering-enforcement-binding-identity" });
    identities.set(identity, encoded);
  }
  if (bindings.some((binding, index) => index > 0 && compareText(canonical(bindings[index - 1]), canonical(binding)) >= 0))
    ctx.addIssue({ code: "custom", message: "noncanonical-steering-enforcement-order" });
});

export function authorityEnforcementIssues(
  authority: SteeringAuthorityValue,
  bindings: readonly SteeringEnforcementBindingValue[],
  subject?: string,
): DomainIssue[] {
  const required = bindings.filter(isRequiredEnforcementBinding);
  const issues: DomainIssue[] = [];
  if (authority === "descriptive" && bindings.length > 0)
    issues.push({ code: "descriptive-steering-enforcement-forbidden", subject });
  if (authority === "normative" && required.length > 0)
    issues.push({ code: "normative-steering-binding-must-be-advisory", subject });
  if (authority === "enforceable" && required.length === 0)
    issues.push({ code: "enforceable-steering-binding-required", subject });
  return stableIssues(issues);
}

export function authorityEffectIssues(
  authority: SteeringAuthorityValue,
  effect: z.infer<typeof steeringRuleEffectSchema>,
  subject?: string,
): DomainIssue[] {
  const valid = authority === "descriptive" ? effect === "describe" :
    authority === "normative" ? effect !== "describe" : effect === "require" || effect === "forbid";
  return valid ? [] : [{ code: "steering-authority-effect-mismatch", subject }];
}
