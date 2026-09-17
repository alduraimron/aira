import { canonical, policyReferenceSchema } from "../../../src/spec/domain/primitives";
import {
  STEERING_RESOLVER_POLICY, STEERING_RESOLVER_SCHEMA, canonicalSteeringSelectors, steeringResourceIdSchema,
  steeringRuleIdSchema, steeringSemanticKeySchema, steeringResourceRevisionSchema, steeringRuleSchema,
  type SteeringResolutionInputs, type SteeringResolutionRequest, type SteeringResourceRevision, type SteeringScope, type SteeringRule,
} from "../../../src/steering";
import { resource, rule, hash, created } from "../fixtures";
import type { SteeringResourceRevisionValue, SteeringRuleValue } from "../../../src/steering/schema";

export { resource, rule, hash, created };
export const tree = (path: string): SteeringScope => ({ kind: "path", selectors: [{ kind: "tree", path }] });
export const phase = (...phases: ("implementation" | "verification" | "review")[]): SteeringScope => ({ kind: "phase", phases });
export const globalScope: SteeringScope = { kind: "project-global" };
export function revision(name: string, overrides: Partial<SteeringResourceRevision> = {}): SteeringResourceRevisionValue {
  return steeringResourceRevisionSchema.parse({ ...resource(), identity: { id: steeringResourceIdSchema.parse(`project.steering.${name}`), revision: resource().identity.revision, hash: hash() }, ...overrides });
}
export function scoped(parent: SteeringResourceRevision, name = "child", scope: SteeringScope = tree("src/auth"), overrides: Partial<SteeringResourceRevision> = {}): SteeringResourceRevisionValue {
  return revision(name, { layer: "project-scoped", scope, composition: { parents: [parent.identity], overrides: [] }, ...overrides });
}
export function namedRule(name: string, value: unknown = "service", overrides: Partial<SteeringRule> = {}): SteeringRuleValue {
  return steeringRuleSchema.parse({ ...rule(), id: steeringRuleIdSchema.parse(`rule.${name}`), semantics: { key: steeringSemanticKeySchema.parse("topic.access"), effect: "require", value }, ...overrides });
}
export function fact(name: string, value: string): SteeringRuleValue {
  return namedRule(name, value, { authority: "descriptive", semantics: { key: steeringSemanticKeySchema.parse("topic.database"), effect: "describe", value }, override_policy: "explicit-replacement" });
}
export const policyBinding = (name: string) => ({ kind: "capability-policy" as const, policy: policyReferenceSchema.parse({ id: `policy_${name}`, revision: "rev_one", hash: hash() }) });
export function request(catalog: readonly SteeringResourceRevision[], overrides: Partial<SteeringResolutionInputs> = {}): SteeringResolutionRequest {
  return { schema: STEERING_RESOLVER_SCHEMA, policy: STEERING_RESOLVER_POLICY, project: "acme",
    action: { phase: "implementation", paths: { status: "known", paths: ["src/auth/handler.ts"] } },
    catalog, selections: catalog.filter((resource) => resource.layer !== "template").map((resource) => ({ resource: resource.identity, inclusion: resource.inclusion })),
    manual: [], supported_contracts: [],
    available_enforcement: [...new Map(catalog.flatMap((resource) => [...resource.default_enforcement, ...resource.rules.flatMap((rule) => rule.enforcement)]).map((binding) => [canonical(binding), binding])).values()],
    ...overrides,
  };
}
export const manualSelection = (resource: SteeringResourceRevision, rule?: SteeringRuleValue) => ({
  resource: resource.identity, ...(rule ? { rule: rule.id } : {}), availability: "required" as const,
  authorization: { project: "acme", by: { kind: "human" as const, id: "local" }, operation: created.operation, channel: "api" as const },
});
export const override = (parent: SteeringResourceRevision, mode: "specialize" | "strengthen" | "replace" = "specialize", targetRule = parent.rules[0]?.id) => ({
  parents: [parent.identity], overrides: [{ target: { resource: parent.identity, ...(targetRule ? { rule: targetRule } : {}) }, mode, rationale: "Explicit project-control decision" }],
});
export const andScope = (...scopes: SteeringScope[]): SteeringScope => ({ kind: "composite", operator: "and", scopes: canonicalSteeringSelectors(scopes) });
export const orScope = (...scopes: SteeringScope[]): SteeringScope => ({ kind: "composite", operator: "or", scopes: canonicalSteeringSelectors(scopes) });
