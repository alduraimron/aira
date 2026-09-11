import type { z } from "zod";
import type { DeepReadonly } from "../spec/domain/primitives";
import type { verifierReferenceSchema, verifierDefinitionSchema, verificationPlanSchema, evidenceOutcomeSchema, verificationEvidenceSchema, evidenceApplicabilityContractSchema } from "./schema";
export type VerifierReference = z.infer<typeof verifierReferenceSchema>;
export type VerifierDefinition = DeepReadonly<z.infer<typeof verifierDefinitionSchema>>;
export type VerifierProfile = z.infer<typeof verificationPlanSchema>["profile"];
export type VerificationPlan = DeepReadonly<z.infer<typeof verificationPlanSchema>>;
export type EvidenceOutcome = z.infer<typeof evidenceOutcomeSchema>;
export type VerificationEvidence = DeepReadonly<z.infer<typeof verificationEvidenceSchema>>;
export type EvidenceApplicabilityContract = z.infer<typeof evidenceApplicabilityContractSchema>;
export interface EvidenceApplicability { readonly applicable: boolean; readonly reasons: readonly import("../spec/domain/primitives").DomainIssue[] }
