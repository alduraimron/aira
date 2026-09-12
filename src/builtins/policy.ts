import { capabilityPolicySchema } from "../capabilities/schema";
import { compileCapabilityPolicy, composeCapabilityPolicies, type PolicyCompilation } from "../capabilities/policy";
import type { CapabilityPolicy } from "../capabilities/types";
import { exact, stableIssues, type DomainIssue, type DomainResult } from "../spec/domain/primitives";
import type { ExecutionBackend } from "../workspace/types";
import { behavioralResolutionSchema, effectiveBehavioralPins, type BehavioralResolution } from "./resolution";

/** Bridge exact asset selections to the existing restriction-only policy algebra. */
export function compileBehavioralCapabilityPolicy(resolution: BehavioralResolution, policies: readonly CapabilityPolicy[],
  backend: ExecutionBackend): DomainResult<PolicyCompilation> {
  if (!behavioralResolutionSchema.safeParse(resolution).success || policies.some((p) => !capabilityPolicySchema.safeParse(p).success))
    return { ok: false, issues: [{ code: "invalid-behavioral-policy-input" }] };
  const issues: DomainIssue[] = [], layers: CapabilityPolicy[] = [];
  for (const pin of effectiveBehavioralPins(resolution)) if (pin.asset.kind === "capability-policy-profile") {
    const reference = pin.asset.policy;
    const matches = policies.filter((p) => exact(p.identity, reference));
    if (matches.length !== 1) issues.push({ code: "behavioral-policy-unavailable-or-ambiguous", subject: reference.id });
    else layers.push(matches[0]!);
  }
  if (!layers.length) issues.push({ code: "behavioral-capability-profile-missing" });
  if (issues.length) return { ok: false, issues: stableIssues(issues) };
  const compilation = compileCapabilityPolicy(composeCapabilityPolicies(layers[0]!, ...layers.slice(1)), backend);
  return compilation.blockers.length ? { ok: false, issues: compilation.blockers } : { ok: true, value: compilation };
}
