import { exact, stableIssues, type DomainIssue } from "../spec/domain/primitives";
import type { TaskDefinition } from "../tasks/types";
import { attemptRecordSchema } from "./schema";
import type { AttemptRecord } from "./types";
import { containsPins, distinctCapabilityPins } from "../builtins/roles";
import { validatePinnedAssets, type BehavioralAssetCatalog } from "../builtins/catalog";
import type { AssetCompatibilityEnvironment } from "../builtins/compatibility";
import { contextSnapshotSchema, type ContextSnapshot } from "../context/snapshot";

/** Validate attribution against exact approved inputs and allowed explicit task
 * overrides. A new default is not an input to this predicate.
 */
export function validateAttemptBehavior(attempt: AttemptRecord, task: TaskDefinition,
  contexts: readonly { readonly snapshot: ContextSnapshot; readonly verified_content_hash: AttemptRecord["context"][number]["hash"] }[],
  catalog: BehavioralAssetCatalog, environment: AssetCompatibilityEnvironment): DomainIssue[] {
  if (!attemptRecordSchema.safeParse(attempt).success) return [{ code: "invalid-attempt-behavior" }];
  const issues: DomainIssue[] = [];
  if (!exact(task.identity, attempt.task) || !exact(task.capability_policy, attempt.policy) || !exact(task.execution_profile, attempt.execution_profile))
    issues.push({ code: "behavioral-task-definition-mismatch" });
  const base = attempt.snapshot.behavioral_assets;
  const candidates = [...base, ...task.behavioral_selections].filter((p) => p.role === "capability-profile");
  const restrictions = distinctCapabilityPins(candidates);
  if (!containsPins(attempt.behavior.pins, restrictions)) issues.push({ code: "attempt-capability-layer-omitted" });
  for (const pin of attempt.behavior.pins) {
    if (pin.role === "capability-profile") {
      if (!restrictions.some((p) => exact(p, pin))) issues.push({ code: "attempt-unselected-behavioral-asset", subject: pin.role });
    } else {
      const selected = task.behavioral_selections.find((p) => p.role === pin.role) ?? base.find((p) => p.role === pin.role);
      if (!exact(pin, selected)) issues.push({ code: "attempt-unselected-behavioral-asset", subject: pin.role });
    }
  }
  for (const reference of attempt.context) {
    const matches = contexts.filter((c) => c.snapshot.id === reference.id && c.verified_content_hash === reference.hash);
    if (matches.length !== 1) issues.push({ code: "behavioral-context-unavailable", subject: reference.id });
    else if (!contextSnapshotSchema.safeParse(matches[0]!.snapshot).success || !containsPins(attempt.behavior.pins, matches[0]!.snapshot.behavioral_assets) ||
      matches[0]!.snapshot.workspace_id !== attempt.workspace.workspace_id || (matches[0]!.snapshot.task !== undefined && matches[0]!.snapshot.task !== task.identity.id))
      issues.push({ code: "behavioral-context-profile-mismatch", subject: reference.id });
  }
  const actualEnvironment = { ...environment, backend: attempt.backend };
  issues.push(...validatePinnedAssets([...attempt.behavior.pins, ...candidates], catalog, actualEnvironment),
    ...validatePinnedAssets(attempt.behavior.pins, catalog, actualEnvironment));
  return stableIssues(issues);
}
