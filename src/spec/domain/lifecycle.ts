import { z } from "zod";
import type { DomainResult } from "./primitives";
import { planningKinds } from "./planning-kinds";

export const specModeSchema = z.enum(["requirements-first", "architecture-first", "quick"]);
export const lifecycleStatusSchema = z.enum(["draft", "drafting-product", "analyzing-product", "waiting-product-approval", "product-approved",
  "drafting-requirements", "analyzing-requirements", "waiting-requirements-approval", "requirements-approved",
  "drafting-architecture", "analyzing-architecture", "waiting-architecture-approval", "architecture-approved", "validating-architecture",
  "drafting-program-design", "analyzing-program-design", "waiting-program-design-approval", "program-design-approved",
  "drafting-slice-plan", "analyzing-slice-plan", "waiting-slice-plan-approval", "slice-plan-approved",
  "drafting-tasks", "analyzing-tasks", "waiting-tasks-approval", "waiting-integrated-approval", "ready", "implementing", "verifying",
  "completed", "cancelled", "blocked", "interrupted"]);
export const lifecycleSchema = z.strictObject({
  state: lifecycleStatusSchema, suspended_from: lifecycleStatusSchema.optional(), reason: z.string().refine((s) => s.trim().length > 0).optional(),
}).refine((s) => ["blocked", "interrupted"].includes(s.state) ?
  s.suspended_from !== undefined && !["blocked", "interrupted", "completed", "cancelled"].includes(s.suspended_from) && s.reason !== undefined :
  s.suspended_from === undefined, "invalid-lifecycle-suspension");
export type SpecMode = z.infer<typeof specModeSchema>;
export type LifecycleStatus = z.infer<typeof lifecycleStatusSchema>;
export type SpecLifecycle = z.infer<typeof lifecycleSchema>;
export function lifecycleAllowedForMode(mode: SpecMode, lifecycle: SpecLifecycle): boolean {
  const state = lifecycle.suspended_from ?? lifecycle.state;
  return mode === "quick" ? !planningKinds.some((k) => state === `waiting-${k}-approval` || state === `${k}-approved`) : state !== "waiting-integrated-approval";
}
/** Structural authoring transitions, not authority or a persisted execution cursor. */
export function checkLifecycleTransition(mode: SpecMode, from: SpecLifecycle, to: SpecLifecycle,
  authoringOrder: "requirements-first" | "architecture-first" = mode === "architecture-first" ? "architecture-first" : "requirements-first",
): DomainResult<SpecLifecycle> {
  if (!specModeSchema.safeParse(mode).success || !lifecycleSchema.safeParse(from).success || !lifecycleSchema.safeParse(to).success)
    return { ok: false, issues: [{ code: "invalid-lifecycle-shape" }] };
  if (!lifecycleAllowedForMode(mode, from) || !lifecycleAllowedForMode(mode, to) || (mode !== "quick" && authoringOrder !== mode))
    return { ok: false, issues: [{ code: "invalid-lifecycle-mode" }] };
  let allowed: readonly string[] = [];
  if (from.state === "blocked" || from.state === "interrupted") allowed = [from.suspended_from!, "cancelled"];
  else if (from.state !== "cancelled") {
    if (to.state === "cancelled") return { ok: true, value: { ...to } };
    if (["blocked", "interrupted"].includes(to.state) && from.state !== "completed" && to.suspended_from === from.state) return { ok: true, value: { ...to } };
    const architectureFirst = authoringOrder === "architecture-first";
    const next: Record<string, readonly string[]> = {
      product: [architectureFirst ? "drafting-architecture" : "drafting-requirements"],
      requirements: [architectureFirst ? "validating-architecture" : "drafting-architecture"],
      architecture: architectureFirst ? ["drafting-requirements", "validating-architecture", "drafting-program-design"] : ["drafting-program-design"],
      "program-design": ["drafting-slice-plan"], "slice-plan": ["drafting-tasks"], tasks: ["ready"],
    };
    const transitions: Record<string, readonly string[]> = {
      draft: ["drafting-product"], "validating-architecture": ["drafting-program-design", "drafting-architecture"],
      ready: ["implementing", ...planningKinds.map((k) => `drafting-${k}`)], implementing: ["verifying"], verifying: ["implementing", "completed"],
      completed: [...planningKinds.map((k) => `drafting-${k}`), "verifying"],
      "waiting-integrated-approval": ["ready", ...planningKinds.map((k) => `drafting-${k}`)],
    };
    for (const kind of planningKinds) {
      transitions[`drafting-${kind}`] = [`analyzing-${kind}`];
      transitions[`analyzing-${kind}`] = [`drafting-${kind}`, ...(mode === "quick" ? (kind === "tasks" ? ["waiting-integrated-approval"] : next[kind]!) : [`waiting-${kind}-approval`])];
      transitions[`waiting-${kind}-approval`] = [`drafting-${kind}`, kind === "tasks" ? "ready" : `${kind}-approved`];
      transitions[`${kind}-approved`] = next[kind]!;
    }
    allowed = transitions[from.state] ?? [];
  }
  return allowed.includes(to.state) ? { ok: true, value: { ...to } } :
    { ok: false, issues: [{ code: "invalid-lifecycle-transition", subject: from.state, related: [to.state, mode] }] };
}
