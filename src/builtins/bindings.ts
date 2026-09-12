import { z } from "zod";
import { exact, type PolicyReference, type ProfileReference } from "../spec/domain/primitives";
import { behavioralPinsSchema, hasRoles, type BehavioralAssetPin, type BehavioralRole } from "./roles";

export const attemptBehaviorSchema = z.strictObject({
  purpose: z.enum(["clarification", "requirements-generation", "requirements-analysis", "design-generation", "design-analysis", "task-generation", "task-analysis",
    "implementation", "repair", "implementation-review", "verification-review", "final-spec-review"]),
  pins: behavioralPinsSchema,
}).refine((b) => hasRoles(b.pins, [b.purpose, "context-profile", "capability-profile", "execution-profile"]), "attempt-behavioral-input-missing");
export function pinsProfile(pins: readonly BehavioralAssetPin[], role: BehavioralRole, profile: ProfileReference): boolean {
  return pins.some((p) => p.role === role && "profile" in p.asset && exact(p.asset.profile, profile));
}
export function pinsPolicy(pins: readonly BehavioralAssetPin[], policy: PolicyReference): boolean {
  return pins.some((p) => p.role === "capability-profile" && p.asset.kind === "capability-policy-profile" && exact(p.asset.policy, policy));
}
