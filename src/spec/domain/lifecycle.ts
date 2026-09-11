import { z } from "zod";
import type { DomainResult } from "./primitives";

export const specModeSchema = z.enum(["requirements-first", "design-first", "quick"]);
export const lifecycleStatusSchema = z.enum(["draft", "drafting-requirements", "analyzing-requirements", "waiting-requirements-approval",
  "requirements-approved", "drafting-design", "analyzing-design", "waiting-design-approval", "design-approved", "validating-design",
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
  return mode === "quick" ? !["waiting-requirements-approval", "requirements-approved", "waiting-design-approval", "design-approved", "waiting-tasks-approval"].includes(state) :
    state !== "waiting-integrated-approval";
}

const common: Partial<Record<LifecycleStatus, readonly LifecycleStatus[]>> = {
  "drafting-requirements": ["analyzing-requirements"],
  "drafting-design": ["analyzing-design"],
  "drafting-tasks": ["analyzing-tasks"],
  ready: ["implementing", "drafting-requirements", "drafting-design", "drafting-tasks"],
  implementing: ["verifying"], verifying: ["implementing", "completed"],
  completed: ["drafting-requirements", "drafting-design", "drafting-tasks", "verifying"],
};
/** Structural transition check only. Artifact gates, approvals and completion are separately
 * evaluated by review/completion; this never grants authority or mutates a Spec.
 */
export function checkLifecycleTransition(mode: SpecMode, from: SpecLifecycle, to: SpecLifecycle,
  authoringOrder: "requirements-first" | "design-first" = mode === "design-first" ? "design-first" : "requirements-first",
): DomainResult<SpecLifecycle> {
  if (!specModeSchema.safeParse(mode).success || !lifecycleSchema.safeParse(from).success || !lifecycleSchema.safeParse(to).success)
    return { ok: false, issues: [{ code: "invalid-lifecycle-shape" }] };
  if (!lifecycleAllowedForMode(mode, from) || !lifecycleAllowedForMode(mode, to) ||
    (mode !== "quick" && authoringOrder !== mode)) return { ok: false, issues: [{ code: "invalid-lifecycle-mode" }] };
  let allowed: readonly LifecycleStatus[] = common[from.state] ?? [];
  if (from.state === "blocked" || from.state === "interrupted") allowed = [from.suspended_from!, "cancelled"];
  else if (from.state !== "cancelled") {
    if (to.state === "cancelled") return { ok: true, value: { ...to } };
    if (["blocked", "interrupted"].includes(to.state) && from.state !== "completed" && to.suspended_from === from.state)
      return { ok: true, value: { ...to } };
    const normal: Partial<Record<LifecycleStatus, readonly LifecycleStatus[]>> = {
      draft: [authoringOrder === "design-first" ? "drafting-design" : "drafting-requirements"],
      "analyzing-requirements": ["drafting-requirements", mode === "quick" ?
        (authoringOrder === "design-first" ? "validating-design" : "drafting-design") : "waiting-requirements-approval"],
      "waiting-requirements-approval": ["requirements-approved", "drafting-requirements"],
      "requirements-approved": mode === "design-first" ? ["validating-design"] : ["drafting-design", "validating-design"],
      "analyzing-design": mode === "quick" ? (authoringOrder === "design-first" ?
        ["drafting-design", "drafting-requirements", "validating-design"] : ["drafting-design", "drafting-tasks"]) : ["drafting-design", "waiting-design-approval"],
      "waiting-design-approval": ["design-approved", "drafting-design"],
      "design-approved": mode === "design-first" ? ["drafting-requirements", "validating-design"] : ["drafting-tasks"],
      "validating-design": ["drafting-tasks", "drafting-design"],
      "analyzing-tasks": ["drafting-tasks", mode === "quick" ? "waiting-integrated-approval" : "waiting-tasks-approval"],
      "waiting-tasks-approval": mode === "quick" ? [] : ["ready", "drafting-tasks"],
      "waiting-integrated-approval": mode === "quick" ? ["ready", "drafting-requirements", "drafting-design", "drafting-tasks"] : [],
    };
    allowed = normal[from.state] ?? allowed;
  }
  return allowed.includes(to.state) ? { ok: true, value: { ...to } } :
    { ok: false, issues: [{ code: "invalid-lifecycle-transition", subject: from.state, related: [to.state, mode] }] };
}
