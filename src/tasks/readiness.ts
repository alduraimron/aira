import { evaluateSpecGates, type SpecReviewContext } from "../spec/domain/review";
import { exact, stableIssues, type DomainIssue } from "../spec/domain/primitives";
import type { TaskId } from "../spec/domain/ids";
import type { TaskExecutionState, TaskExecutionStatus } from "../execution/types";
import { orderTasks, validateTaskGraph, type TaskReferenceCatalog } from "./graph";
import type { Tasks } from "./types";
import { specSchema } from "../spec/domain/schema";
import { taskExecutionStateSchema } from "../execution/schema";
import { sliceReadiness, validateTaskSliceConsistency, type SlicePlan } from "../spec/domain/slices";
import type { SliceExecutionState } from "../spec/domain/slice-state";
import type { SliceId } from "../spec/domain/ids";

export interface ReadinessInput {
  readonly definitions: Tasks;
  readonly slices: SlicePlan;
  readonly slice_states: readonly SliceExecutionState[];
  /** Explicit active selections, not an implied first array element. */
  readonly active_slices: readonly SliceId[];
  readonly catalog: TaskReferenceCatalog;
  readonly states: readonly TaskExecutionState[];
  readonly review: SpecReviewContext;
  readonly preconditions: readonly { task: TaskId; blockers: readonly DomainIssue[] }[];
}
export interface TaskReadiness {
  readonly ready: readonly TaskId[];
  readonly blocked: readonly { task: TaskId; reasons: readonly DomainIssue[] }[];
  readonly terminal: readonly { task: TaskId; state: TaskExecutionStatus }[];
  readonly active: readonly TaskId[];
  readonly issues: readonly DomainIssue[];
}
export function taskReadiness(input: ReadinessInput): TaskReadiness {
  const sliceStatus = sliceReadiness({ plan: input.slices, states: input.slice_states, review: input.review });
  const global = [...evaluateSpecGates(input.review), ...validateTaskGraph(input.definitions, input.catalog),
    ...validateTaskSliceConsistency(input.slices, input.definitions), ...sliceStatus.issues];
  if (new Set(input.active_slices).size !== input.active_slices.length || input.active_slices.some((id) => !input.slices.slices.some((s) => s.id === id)))
    global.push({ code: "invalid-active-slice-selection" });
  if (!specSchema.safeParse(input.review.spec).success) global.push({ code: "invalid-domain-contract", subject: "spec" });
  if (input.states.length && !input.review.spec.run_binding) global.push({ code: "run-binding-inapplicable" });
  const current = input.review.spec.artifacts.current.find((s) => s.artifact.kind === "tasks");
  if (input.definitions.spec_id !== input.review.spec.id || current?.artifact.revision !== input.definitions.revision)
    global.push({ code: "task-artifact-inapplicable" });
  if (!["ready", "implementing", "verifying"].includes(input.review.spec.lifecycle.state)) global.push({ code: "spec-not-executable" });
  for (const state of input.states) {
    if (!taskExecutionStateSchema.safeParse(state).success) global.push({ code: "invalid-domain-contract", task: state.task.id });
    if (input.states.filter((s) => s.task.id === state.task.id).length > 1) global.push({ code: "duplicate-task-state", task: state.task.id });
    const definition = input.definitions.tasks.find((t) => t.identity.id === state.task.id);
    if (!definition || !exact(definition.identity, state.task)) global.push({ code: "task-state-definition-mismatch", task: state.task.id });
    if (input.review.spec.run_binding && (input.review.spec.run_binding.run !== state.run ||
      input.review.spec.run_binding.status !== "applicable" || input.review.spec.run_binding.applicable_generation !== input.review.spec.generation))
      global.push({ code: "run-binding-inapplicable", task: state.task.id });
  }
  const ready: TaskId[] = [], blocked: { task: TaskId; reasons: DomainIssue[] }[] = [],
    terminal: { task: TaskId; state: TaskExecutionStatus }[] = [], active: TaskId[] = [];
  for (const task of orderTasks(input.definitions.tasks)) {
    const state = input.states.find((s) => s.task.id === task.identity.id);
    if (state && ["completed", "failed", "skipped", "cancelled"].includes(state.status)) { terminal.push({ task: task.identity.id, state: state.status }); continue; }
    if (state && ["claimed", "running", "verifying"].includes(state.status)) { active.push(task.identity.id); continue; }
    const reasons: DomainIssue[] = [...global, ...input.preconditions.filter((p) => p.task === task.identity.id).flatMap((p) => p.blockers)];
    if (!input.active_slices.includes(task.slice) || ![...sliceStatus.ready, ...sliceStatus.active].includes(task.slice) ||
      input.slice_states.some((s) => s.slice === task.slice && s.status === "verifying"))
      reasons.push({ code: "owning-slice-not-runnable", task: task.identity.id, subject: task.slice });
    if (state && !["pending", "ready"].includes(state.status)) reasons.push({ code: "task-recovery-required", task: task.identity.id, subject: state.status });
    for (const dep of task.dependencies) {
      const states = input.states.filter((s) => s.task.id === dep);
      const definition = input.definitions.tasks.find((t) => t.identity.id === dep);
      if (states.length !== 1 || states[0]!.status !== "completed" || !definition || !exact(states[0]!.task, definition.identity))
        reasons.push({ code: "dependency-not-completed", task: task.identity.id, subject: dep });
    }
    if (reasons.length) blocked.push({ task: task.identity.id, reasons: stableIssues(reasons) });
    else ready.push(task.identity.id);
  }
  return { ready, blocked, terminal, active, issues: stableIssues(global) };
}
