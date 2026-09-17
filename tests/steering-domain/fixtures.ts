import {
  canonical,
  compareText,
  contentHashSchema,
  createdMetadataSchema,
  policyReferenceSchema,
  profileReferenceSchema,
} from "../../src/spec/domain/primitives";
import { verifierReferenceSchema } from "../../src/verification/schema";
import {
  steeringResourceRevisionSchema,
  steeringRuleSchema,
  type SteeringResourceRevisionValue,
  type SteeringRuleValue,
} from "../../src/steering/schema";
import type { SteeringEnforcementBindingValue } from "../../src/steering/authority";

export const hash = (digit = 1) => contentHashSchema.parse(`sha256:${digit.toString(16).padStart(64, "0")}`);
export const policy = (digit = 1) => policyReferenceSchema.parse({ id: "policy_project", revision: "rev_policy", hash: hash(digit) });
export const verifier = (digit = 1) => verifierReferenceSchema.parse({ id: "V1", revision: "rev_verifier", hash: hash(digit) });
export const profile = (digit = 1) => profileReferenceSchema.parse({ id: "profile_steering", revision: "rev_profile", hash: hash(digit) });
export const created = createdMetadataSchema.parse({
  at: "2025-01-02T03:04:05.000Z",
  by: { kind: "human", id: "local" },
  operation: "operation_steering",
  channel: "api",
});

export function ordered<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => compareText(canonical(left), canonical(right)));
}

export function rule(overrides: Partial<SteeringRuleValue> = {}): SteeringRuleValue {
  return steeringRuleSchema.parse({
    id: "rule.architecture.repository-access",
    title: "Use the repository boundary",
    authority: "normative",
    semantics: {
      key: "topic.architecture.data-access",
      effect: "require",
      value: "repository-layer",
    },
    override_policy: "narrower-scope",
    status: "active",
    rationale: "Keep transport and persistence boundaries separate.",
    enforcement: [],
    source: { content_hash: hash(), location: { kind: "heading", heading: "Repository access" } },
    ...overrides,
  });
}

export function resource(overrides: Partial<SteeringResourceRevisionValue> = {}): SteeringResourceRevisionValue {
  return steeringResourceRevisionSchema.parse({
    schema: "aira.dev/steering-resource/v1",
    identity: { id: "steering.architecture", revision: "1", hash: hash() },
    kind: "architecture",
    layer: "project-root",
    provenance: { kind: "project", project: "acme", authorship: "authored" },
    content: { hash: hash(), bytes: 101, media_type: "text/markdown; charset=utf-8" },
    content_encoding: "aira.dev/steering-bytes/raw/v1",
    default_authority: "normative",
    default_override_policy: "narrower-scope",
    default_enforcement: [],
    inclusion: { availability: "required", selector: { kind: "always" } },
    scope: { kind: "project-global" },
    rules: [rule()],
    composition: { parents: [], overrides: [] },
    compatibility: { resolver: "aira.dev/steering-resolution/v1", required_schemas: [] },
    metadata: { title: "Architecture constitution", labels: ["architecture"] },
    created,
    behavioral_assets: [],
    ...overrides,
  });
}

export function capabilityBinding(digit = 1): SteeringEnforcementBindingValue {
  return { kind: "capability-policy", policy: policy(digit) } as SteeringEnforcementBindingValue;
}

export function verifierBinding(use: "advisory" | "required" = "required", digit = 1): SteeringEnforcementBindingValue {
  return { kind: "verifier", verifier: verifier(digit), use } as SteeringEnforcementBindingValue;
}
