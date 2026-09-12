import { behavioralAssetPinSchema } from "../../src/builtins/roles";
import { contentHashSchema, profileReferenceSchema, policyReferenceSchema } from "../../src/spec/domain/primitives";
import { behavioralAssetCatalogSchema } from "../../src/builtins/catalog";
import { assetCompatibilityEnvironmentSchema } from "../../src/builtins/compatibility";

export const syntheticCompatibility = { domain_schemas: ["aira.dev/spec/v1"], required_schemas: [], runtime_capabilities: [],
  backend_capabilities: [], backend_implementations: [], required_interfaces: [], provided_interfaces: [] };
export const syntheticEnvironment = () => assetCompatibilityEnvironmentSchema.parse({ domain_schema: "aira.dev/spec/v1", supported_schemas: [], runtime_capabilities: [], host_interfaces: [] });
export function baseBehavioralCatalog() {
  return behavioralAssetCatalogSchema.parse({ bundles: [], assets: baseBehavioralPins().map((pin) => ({
    revision: { schema: "aira.dev/behavioral-asset/v1", identity: pin.asset, content_encoding: "aira.dev/asset-bytes/raw/v1", compatibility: syntheticCompatibility,
      metadata: { title: "Synthetic reference", description: "Test-only metadata", labels: [], published: { at: "2026-08-26T12:00:00Z", by: { kind: "human", id: "local" }, operation: "operation_author" } } },
    verified_content_hash: pin.asset.hash,
  })) });
}

// Synthetic references only. These are not product content or real byte hash claims.
const hash = (n: number) => contentHashSchema.parse(`sha256:${n.toString(16).padStart(64, "0")}`);
const profile = (name: string) => profileReferenceSchema.parse({ id: `profile_${name}`, revision: `rev_profile_${name}`, hash: hash(100 + name.length) });
const policy = policyReferenceSchema.parse({ id: "policy_task", revision: "rev_policy_task", hash: hash(204) });
export function baseBehavioralPins() {
  return [
    { role: "implementation", kind: "prompt-profile" },
    { role: "context-profile", kind: "context-profile", profile: profile("context") },
    { role: "capability-profile", kind: "capability-policy-profile", policy },
    { role: "execution-profile", kind: "execution-profile", profile: profile("execute") },
    { role: "verification-profile", kind: "verification-profile", profile: profile("verify") },
  ].map(({ role, ...target }) => behavioralAssetPinSchema.parse({ role, asset: {
    id: `builtin.test.${role}`, revision: "1", hash: hash(300 + role.length), provenance: { kind: "aira-builtin", publisher: "aira" }, ...target,
  } }));
}
