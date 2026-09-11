import { matchesPath } from "../context/declarations";
import { canonical, exact, stableIssues, type DomainIssue, type ProfileReference } from "../spec/domain/primitives";
import { checkBackendRequirements } from "../workspace/fingerprint";
import type { ExecutionBackend } from "../workspace/types";
import { effectiveCapabilityPolicySchema } from "./schema";
import type { CapabilityPolicy, EffectiveCapabilityPolicy, ToolIdentity } from "./types";

export type CapabilityRequest =
  | { kind: "filesystem"; action: "read" | "write" | "create" | "delete"; logical_path: string }
  | { kind: "tool"; tool: ToolIdentity }
  | { kind: "process"; profile: ProfileReference; arbitrary_shell: boolean }
  | { kind: "network"; destination: { host: string; port: number; protocol: "tcp" | "udp" } }
  | { kind: "environment"; name: string; ambient: boolean };
export type CapabilityDecision = "allow" | "deny" | "requires-human-escalation";
export interface PolicyCompilation {
  readonly effective: EffectiveCapabilityPolicy;
  readonly backend_compatible: boolean;
  readonly blockers: readonly DomainIssue[];
  readonly enforcement_obligations: readonly ["canonical-path-at-io", "tool-implementation-identity", "all-execution-paths"];
}
export function composeCapabilityPolicies(parent: CapabilityPolicy, ...restrictions: CapabilityPolicy[]): EffectiveCapabilityPolicy {
  const layers = [parent, ...restrictions];
  return effectiveCapabilityPolicySchema.parse({ schema: "aira.dev/effective-capability-policy/v1", layers,
    required_backend: [...new Set(layers.flatMap((l) => l.required_backend))].sort() });
}
function layerDecision(policy: CapabilityPolicy, request: CapabilityRequest): CapabilityDecision {
  switch (request.kind) {
    case "filesystem": {
      const rules = policy.filesystem[request.action];
      if (policy.protected_paths.some((p) => matchesPath(p, request.logical_path)) || rules.deny.some((p) => matchesPath(p, request.logical_path))) return "deny";
      return rules.allow.some((p) => matchesPath(p, request.logical_path)) ? "allow" : "deny";
    }
    case "tool":
      if (policy.tools.deny.some((tool) => "implementation" in tool ? exact(tool, request.tool) : tool.name === request.tool.name)) return "deny";
      return policy.tools.allow.some((tool) => exact(tool, request.tool)) ? "allow" : "deny";
    case "environment":
      return !policy.environment.deny.includes(request.name) && policy.environment.allow.includes(request.name) &&
        (!request.ambient || policy.environment.inherit_ambient) ? "allow" : "deny";
    case "process":
      if (policy.process.mode === "deny" || !policy.process.profiles.some((p) => exact(p, request.profile)) ||
        (request.arbitrary_shell && !policy.process.arbitrary_shell)) return "deny";
      return policy.process.mode === "ask" ? "requires-human-escalation" : "allow";
    case "network":
      if (policy.network.mode === "deny" || policy.network.deny.some((d) => exact(d, request.destination)) ||
        !policy.network.destinations.some((d) => exact(d, request.destination))) return "deny";
      return policy.network.mode === "ask" ? "requires-human-escalation" : "allow";
  }
}
/** Selection semantics only, not actual path or process confinement (INV-CAP-003/004). */
export function capabilityDecision(effective: EffectiveCapabilityPolicy, request: CapabilityRequest): CapabilityDecision {
  const decisions = effective.layers.map((policy) => layerDecision(policy, request));
  return decisions.includes("deny") ? "deny" : decisions.includes("requires-human-escalation") ? "requires-human-escalation" : "allow";
}
export function compileCapabilityPolicy(effective: EffectiveCapabilityPolicy, backend: ExecutionBackend): PolicyCompilation {
  const blockers = checkBackendRequirements(effective.required_backend, backend);
  const identities = new Map<string, string>();
  for (const layer of effective.layers) {
    const key = `${layer.identity.id}:${layer.identity.revision}`;
    const previous = identities.get(key);
    if (previous !== undefined && previous !== canonical(layer)) blockers.push({ code: "conflicting-policy-identity", subject: key });
    identities.set(key, canonical(layer));
  }
  return { effective, backend_compatible: blockers.length === 0, blockers: stableIssues(blockers),
    enforcement_obligations: ["canonical-path-at-io", "tool-implementation-identity", "all-execution-paths"] };
}
