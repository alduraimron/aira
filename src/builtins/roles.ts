import { z } from "zod";
import { exact, unique, type DeepReadonly } from "../spec/domain/primitives";
import { behavioralAssetReferenceSchema, type BehavioralAssetKind } from "./assets";
import { assetKey, builtinBundleReferenceSchema } from "./identity";

export const behavioralRoleSchema = z.enum(["clarification", "requirements-generation", "requirements-analysis", "design-generation", "design-analysis",
  "task-generation", "task-analysis", "implementation", "repair", "implementation-review", "verification-review", "final-spec-review",
  "context-profile", "capability-profile", "verification-profile", "execution-profile", "execution-recipe", "spec-kind-profile", "mode-profile", "host-skill"]);
export const authoringBehavioralPhaseSchema = z.enum(["clarification", "requirements-generation", "requirements-analysis", "design-generation", "design-analysis",
  "task-generation", "task-analysis", "final-spec-review"]);
export type BehavioralRole = z.infer<typeof behavioralRoleSchema>;
export type AuthoringBehavioralPhase = z.infer<typeof authoringBehavioralPhaseSchema>;
const roleKinds: Record<BehavioralRole, readonly BehavioralAssetKind[]> = {
  clarification: ["prompt-profile"], "requirements-generation": ["prompt-profile"], "requirements-analysis": ["analysis-profile"],
  "design-generation": ["prompt-profile"], "design-analysis": ["analysis-profile"], "task-generation": ["prompt-profile"], "task-analysis": ["analysis-profile"],
  implementation: ["prompt-profile"], repair: ["prompt-profile", "analysis-profile"], "implementation-review": ["analysis-profile"],
  "verification-review": ["analysis-profile"], "final-spec-review": ["analysis-profile"], "context-profile": ["context-profile"],
  "capability-profile": ["capability-policy-profile"], "verification-profile": ["verification-profile"], "execution-profile": ["execution-profile"],
  "execution-recipe": ["execution-recipe"], "spec-kind-profile": ["spec-kind-profile"], "mode-profile": ["mode-profile"], "host-skill": ["skill"],
};
export const roleAcceptsAsset = (role: BehavioralRole, kind: BehavioralAssetKind): boolean => roleKinds[role].includes(kind);
export const behavioralAssetSelectionSchema = z.strictObject({ role: behavioralRoleSchema, asset: behavioralAssetReferenceSchema })
  .refine((s) => roleAcceptsAsset(s.role, s.asset.kind), "behavioral-role-kind-mismatch");
export const behavioralAssetPinSchema = behavioralAssetSelectionSchema.safeExtend({ bundle: builtinBundleReferenceSchema.optional() })
  .refine((p) => !p.bundle || p.asset.provenance.kind === "aira-builtin", "project-asset-cannot-claim-builtin-bundle");
export type BehavioralAssetPin = DeepReadonly<z.infer<typeof behavioralAssetPinSchema>>;
export const behavioralSelectionsSchema = z.array(behavioralAssetPinSchema).refine((ps) => unique(ps.map((p) => p.role)), "duplicate-behavioral-role");
// Effective capability layers deliberately retain multiple pins for the same slot.
export const behavioralPinsSchema = z.array(behavioralAssetPinSchema).refine((ps) =>
  unique(ps.map((p) => `${p.role}:${assetKey(p.asset)}`)) &&
  unique(ps.filter((p) => p.role !== "capability-profile").map((p) => p.role)), "duplicate-behavioral-pin");
export function taskRoleAllowed(role: BehavioralRole): boolean {
  return ["implementation", "repair", "implementation-review", "verification-review", "context-profile", "capability-profile",
    "verification-profile", "execution-profile", "execution-recipe"].includes(role);
}
export const taskBehavioralSelectionsSchema = behavioralSelectionsSchema.refine((ps) => ps.every((p) => taskRoleAllowed(p.role)), "task-behavioral-role-forbidden");
export const hasRoles = (pins: readonly BehavioralAssetPin[], roles: readonly BehavioralRole[]): boolean => roles.every((role) => pins.some((p) => p.role === role));
export const containsPins = (pins: readonly BehavioralAssetPin[], required: readonly BehavioralAssetPin[]): boolean => required.every((p) => pins.some((candidate) => exact(candidate, p)));
export const sameBehavioralPins = (a: readonly BehavioralAssetPin[], b: readonly BehavioralAssetPin[]): boolean => a.length === b.length && containsPins(a, b);
/** Parent-first restriction layers. Re-selecting the exact same asset through another
 * bundle does not add a new restriction; retain the original attribution and inspect
 * all candidate references separately before use.
 */
export function distinctCapabilityPins(pins: readonly BehavioralAssetPin[]): BehavioralAssetPin[] {
  const capabilities = pins.filter((p) => p.role === "capability-profile");
  return capabilities.filter((p, i) => capabilities.findIndex((other) => exact(other.asset, p.asset)) === i);
}
