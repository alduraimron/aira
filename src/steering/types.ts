import type { z } from "zod";
import type { DeepReadonly } from "../spec/domain/primitives";
import type {
  SteeringInclusionSelectorValue,
  SteeringScopeValue,
  steeringInclusionSchema,
  steeringPhaseSchema,
  steeringSpecKindSelectorSchema,
  steeringTaskKindSelectorSchema,
} from "./applicability";
import type {
  steeringAuthoritySchema,
  steeringEnforcementBindingSchema,
  steeringOverridePolicySchema,
  steeringRuleEffectSchema,
} from "./authority";
import type {
  steeringCompatibilitySchema,
  steeringCompositionSchema,
  steeringLayerSchema,
  steeringOverrideSchema,
  steeringProvenanceSchema,
  steeringResourceKindSchema,
  steeringResourceRevisionSchema,
  steeringRuleSchema,
  steeringSourceReferenceSchema,
} from "./schema";

export type SteeringAuthority = z.infer<typeof steeringAuthoritySchema>;
export type SteeringRuleEffect = z.infer<typeof steeringRuleEffectSchema>;
export type SteeringOverridePolicy = z.infer<typeof steeringOverridePolicySchema>;
export type SteeringEnforcementBinding = DeepReadonly<z.infer<typeof steeringEnforcementBindingSchema>>;
export type SteeringPhase = z.infer<typeof steeringPhaseSchema>;
export type SteeringSpecKindSelector = DeepReadonly<z.infer<typeof steeringSpecKindSelectorSchema>>;
export type SteeringTaskKindSelector = DeepReadonly<z.infer<typeof steeringTaskKindSelectorSchema>>;
export type SteeringInclusionSelector = DeepReadonly<SteeringInclusionSelectorValue>;
export type SteeringInclusion = DeepReadonly<z.infer<typeof steeringInclusionSchema>>;
export type SteeringScope = DeepReadonly<SteeringScopeValue>;
export type SteeringResourceKind = z.infer<typeof steeringResourceKindSchema>;
export type SteeringLayer = z.infer<typeof steeringLayerSchema>;
export type SteeringSourceReference = DeepReadonly<z.infer<typeof steeringSourceReferenceSchema>>;
export type SteeringProvenance = DeepReadonly<z.infer<typeof steeringProvenanceSchema>>;
export type SteeringRule = DeepReadonly<z.infer<typeof steeringRuleSchema>>;
export type SteeringOverride = DeepReadonly<z.infer<typeof steeringOverrideSchema>>;
export type SteeringComposition = DeepReadonly<z.infer<typeof steeringCompositionSchema>>;
export type SteeringCompatibility = DeepReadonly<z.infer<typeof steeringCompatibilitySchema>>;
export type SteeringResourceRevision = DeepReadonly<z.infer<typeof steeringResourceRevisionSchema>>;
