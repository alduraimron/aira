import { z } from "zod";
import { specKindSchema } from "../spec/domain/kinds";
import { specModeSchema } from "../spec/domain/lifecycle";
import { nonBlankSchema, unique, type DeepReadonly } from "../spec/domain/primitives";
import { behavioralAssetReferenceSchema } from "./assets";
import { behavioralRoleSchema, behavioralSelectionsSchema } from "./roles";

const profileSelections = behavioralSelectionsSchema.refine((ps) => ps.every((p) => !["spec-kind-profile", "mode-profile"].includes(p.role)), "recursive-profile-selection-forbidden");
export const specKindProfileSchema = z.strictObject({
  schema: z.literal("aira.dev/spec-kind-profile/v1"),
  asset: behavioralAssetReferenceSchema.refine((a) => a.kind === "spec-kind-profile", "spec-kind-asset-required"),
  kind: specKindSchema, custom_kind: nonBlankSchema.optional(),
  selections: profileSelections.refine((ps) => ps.length > 0, "behavioral-profile-must-select-behavior"),
  required_roles: z.array(behavioralRoleSchema).min(1).refine(unique),
}).refine((p) => (p.kind === "custom") === (p.custom_kind !== undefined) &&
  p.required_roles.every((r) => p.selections.some((s) => s.role === r)), "invalid-spec-kind-profile");
export const modeProfileSchema = z.strictObject({
  schema: z.literal("aira.dev/mode-profile/v1"),
  asset: behavioralAssetReferenceSchema.refine((a) => a.kind === "mode-profile", "mode-asset-required"),
  mode: specModeSchema, authoring_order: z.enum(["requirements-first", "design-first"]),
  approval_presentation: z.enum(["per-artifact", "integrated"]),
  review_presentation: z.enum(["phase-specific", "integrated-with-canonical-analyses"]),
  selections: profileSelections,
}).refine((p) => (p.mode === "quick" || p.mode === p.authoring_order) &&
  (p.mode === "quick" ? p.approval_presentation === "integrated" && p.review_presentation === "integrated-with-canonical-analyses" :
    p.approval_presentation === "per-artifact" && p.review_presentation === "phase-specific"), "mode-profile-lifecycle-mismatch");
export type SpecKindProfile = DeepReadonly<z.infer<typeof specKindProfileSchema>>;
export type ModeProfile = DeepReadonly<z.infer<typeof modeProfileSchema>>;
