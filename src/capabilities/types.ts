import type { z } from "zod";
import type { DeepReadonly } from "../spec/domain/primitives";
import type { capabilityPolicySchema, effectiveCapabilityPolicySchema, toolIdentitySchema, capabilityEscalationSchema } from "./schema";
export type CapabilityPolicy = DeepReadonly<z.infer<typeof capabilityPolicySchema>>;
export type EffectiveCapabilityPolicy = DeepReadonly<z.infer<typeof effectiveCapabilityPolicySchema>>;
export type ToolIdentity = z.infer<typeof toolIdentitySchema>;
export type CapabilityEscalation = z.infer<typeof capabilityEscalationSchema>;
