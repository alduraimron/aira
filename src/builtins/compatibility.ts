import { z } from "zod";
import { exact, stableIssues, unique, type DeepReadonly, type DomainIssue } from "../spec/domain/primitives";
import { backendCapabilitySchema, executionBackendSchema, implementationIdentitySchema } from "../workspace/schema";
import { checkBackendRequirements } from "../workspace/fingerprint";

export const versionedContractIdSchema = z.string().regex(/^aira\.dev\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*\/v[1-9][0-9]*$/);
export const runtimeAssetCapabilitySchema = z.enum(["structured-output", "tool-calling", "context-snapshots", "human-decisions", "asset-content-by-hash"]);
export const assetCompatibilitySchema = z.strictObject({
  domain_schemas: z.array(versionedContractIdSchema).min(1).refine(unique),
  required_schemas: z.array(versionedContractIdSchema).refine(unique),
  runtime_capabilities: z.array(runtimeAssetCapabilitySchema).refine(unique),
  backend_capabilities: z.array(backendCapabilitySchema).refine(unique),
  // Empty means no implementation restriction, not a guessed backend guarantee.
  backend_implementations: z.array(implementationIdentitySchema).refine((xs) => unique(xs.map((x) => x.id))),
  required_interfaces: z.array(versionedContractIdSchema).refine(unique),
  provided_interfaces: z.array(versionedContractIdSchema).refine(unique),
});
export const assetCompatibilityEnvironmentSchema = z.strictObject({
  domain_schema: versionedContractIdSchema, supported_schemas: z.array(versionedContractIdSchema).refine(unique),
  runtime_capabilities: z.array(runtimeAssetCapabilitySchema).refine(unique),
  backend: executionBackendSchema.optional(),
  // Interfaces actually supplied by the host. Resolution adds only effective pinned assets.
  host_interfaces: z.array(versionedContractIdSchema).refine(unique),
});
export type AssetCompatibility = DeepReadonly<z.infer<typeof assetCompatibilitySchema>>;
export type AssetCompatibilityEnvironment = DeepReadonly<z.infer<typeof assetCompatibilityEnvironmentSchema>>;
export function evaluateAssetCompatibility(requirements: AssetCompatibility, environment: AssetCompatibilityEnvironment,
  selectedInterfaces: readonly string[] = []): DomainIssue[] {
  if (!assetCompatibilitySchema.safeParse(requirements).success || !assetCompatibilityEnvironmentSchema.safeParse(environment).success)
    return [{ code: "invalid-asset-compatibility-contract" }];
  const issues: DomainIssue[] = [];
  if (!requirements.domain_schemas.includes(environment.domain_schema)) issues.push({ code: "asset-domain-incompatible", subject: environment.domain_schema });
  for (const schema of requirements.required_schemas) if (!environment.supported_schemas.includes(schema)) issues.push({ code: "asset-schema-unavailable", subject: schema });
  for (const capability of requirements.runtime_capabilities) if (!environment.runtime_capabilities.includes(capability)) issues.push({ code: "asset-runtime-capability-unavailable", subject: capability });
  const interfaces = [...environment.host_interfaces, ...selectedInterfaces];
  for (const contract of requirements.required_interfaces) if (!interfaces.includes(contract)) issues.push({ code: "asset-interface-unavailable", subject: contract });
  if (requirements.backend_capabilities.length || requirements.backend_implementations.length) {
    if (!environment.backend) issues.push({ code: "asset-backend-unavailable" });
    else {
      issues.push(...checkBackendRequirements(requirements.backend_capabilities, environment.backend));
      if (requirements.backend_implementations.length && !requirements.backend_implementations.some((b) => exact(b, environment.backend!.identity)))
        issues.push({ code: "asset-backend-incompatible", subject: environment.backend.identity.id });
    }
  }
  return stableIssues(issues);
}
