import { describe, expect, test } from "bun:test";
import { slicePlanSchema, verticalSliceSchema, validateSliceDAG, validateTaskSliceConsistency, sliceReadiness, evaluateSliceCompletion, type SliceCompletionInput } from "../../src/spec/domain/slices";
import { sliceExecutionStateSchema } from "../../src/spec/domain/slice-state";
import { taskDefinitionSchema } from "../../src/tasks/schema";
import { taskReadiness } from "../../src/tasks/readiness";
import { referenceOf } from "../../src/spec/domain/artifacts";
import { fixture, task, hash, policyRef } from "../domain-v2/fixtures";
import { sliceIdSchema, taskIdSchema } from "../../src/spec/domain/ids";

function slice(id = "S1", dependencies: string[] = [], tasks = ["T1"]) {
  return verticalSliceSchema.parse({ ...fixture().slices.slices[0], id, dependencies, tasks });
}
const graph = (slices: unknown[]) => validateSliceDAG({ ...fixture().slices, slices });
function readiness() {
  const f = fixture(); f.spec.lifecycle = { state: "implementing" };
  f.slices.slices = [slice("S2", ["S1"], ["T2"]), slice("S1")];
  return { f, plan: f.slices, states: [] as typeof f.run.slices, review: f.review };
}
function completion(): SliceCompletionInput {
  const f = fixture();
  return { slice: f.slices.slices[0]!, plan: f.slices, states: f.run.slices, review: f.review,
    tasks: f.tasks, task_states: f.run.tasks, verification: f.plan, evidence: f.evidence, evidence_contexts: [f.evidenceContext] };
}
describe("INV-SLICE-001/003: separate Slice DAG and verifiable increments", () => {
  test("valid DAG is independent of declaration order and decimal suffix", () => {
    expect(graph([slice("S2", ["S10"]), slice("S10")])).toEqual([]);
  });
  test.each([
    [[slice(), slice()], "duplicate-slice"], [[slice("S1", ["S9"])], "unknown-slice-dependency"],
    [[slice("S1", ["S1"])], "slice-self-dependency"], [[slice("S1", ["S2"]), slice("S2", ["S1"])], "slice-cycle"],
    [[slice("S1", ["S3"]), slice("S2", ["S1"]), slice("S3", ["S2"])], "slice-cycle"],
  ] as const)("invalid Slice DAG gives %s / %s", (slices, code) => {
    const report = graph([...slices]); expect(report.map((i) => i.code)).toContain(code);
    expect(graph([...slices].reverse())).toEqual(report);
    expect(slicePlanSchema.safeParse({ ...fixture().slices, slices }).success).toBe(false);
  });
  test.each(["outcome", "intent"] as const)("blank %s is not a vertical increment", (field) => {
    expect(verticalSliceSchema.safeParse({ ...slice(), [field]: "\n " }).success).toBe(false);
  });
  test.each(["required_verifiers", "completion", "demonstration", "tasks"] as const)("implementation Slice requires %s obligations", (field) => {
    expect(verticalSliceSchema.safeParse({ ...slice(), [field]: [] }).success).toBe(false);
  });
  test("taskless Slice is explicit non-implementation with justification and policy only", () => {
    const s = { ...slice(), tasks: [], kind: "non-implementation" };
    expect(verticalSliceSchema.safeParse(s).success).toBe(false);
    expect(verticalSliceSchema.safeParse({ ...s, non_implementation: { justification: "Human review of a deployment decision", policy: policyRef("review") } }).success).toBe(true);
  });
  test("completion/checkpoint verifiers cannot escape required verifier set", () => {
    expect(verticalSliceSchema.safeParse({ ...slice(), completion: [{ id: "check", predicate: "Observable", verifier: "V9" }] }).success).toBe(false);
    expect(verticalSliceSchema.safeParse({ ...slice(), checkpoint: { policy: policyRef("review"), verifier: "V9" } }).success).toBe(false);
  });
});
describe("INV-SLICE-002/003: exactly one owner and cross-Slice task consistency", () => {
  test("orphan and multiple ownership fail deterministically", () => {
    const f = fixture(), definitions = { ...f.tasks, tasks: [task("T1"), task("T2")] };
    expect(validateTaskSliceConsistency(f.slices, definitions).map((i) => i.code)).toContain("task-slice-missing");
    const plan = { ...f.slices, slices: [slice("S1"), slice("S2", [], ["T1"])] };
    expect(validateTaskSliceConsistency(plan, f.tasks).map((i) => i.code)).toContain("task-multiple-slices");
  });
  test("Task owner field must agree with Slice membership", () => {
    const f = fixture(); f.tasks.tasks[0]!.slice = sliceIdSchema.parse("S9");
    expect(validateTaskSliceConsistency(f.slices, f.tasks).map((i) => i.code)).toContain("task-slice-owner-mismatch");
  });
  test("same-Slice task dependency is valid", () => {
    const f = fixture(); f.slices.slices[0]!.tasks.push(taskIdSchema.parse("T2"));
    f.tasks.tasks.push(task("T2", ["T1"])); expect(validateTaskSliceConsistency(f.slices, f.tasks)).toEqual([]);
  });
  test.each([true, false])("cross-Slice dependency must follow direct/transitive Slice order, direct=%s", (direct) => {
    const f = fixture(); f.slices.slices = [slice("S1"), slice("S2", ["S1"], ["T2"]), slice("S3", [direct ? "S1" : "S2"], ["T3"])];
    f.tasks.tasks = [task(), taskDefinitionSchema.parse({ ...task("T2"), slice: "S2" }), taskDefinitionSchema.parse({ ...task("T3", ["T1"]), slice: "S3" })];
    expect(validateTaskSliceConsistency(f.slices, f.tasks)).toEqual([]);
    f.slices.slices[2]!.dependencies = [];
    expect(validateTaskSliceConsistency(f.slices, f.tasks).map((i) => i.code)).toContain("cross-slice-dependency-order");
  });
  test("backwards dependency is rejected even if Task DAG alone is acyclic", () => {
    const f = fixture(); f.slices.slices = [slice("S1"), slice("S2", ["S1"], ["T2"])];
    f.tasks.tasks = [task("T1", ["T2"]), taskDefinitionSchema.parse({ ...task("T2"), slice: "S2" })];
    expect(validateTaskSliceConsistency(f.slices, f.tasks)).toContainEqual({ code: "cross-slice-dependency-order", task: "T1", subject: "S1", related: ["T2", "S2"] });
  });
});
describe("INV-SLICE-004 / INV-TASK-001: readiness and completion are separate", () => {
  test("deterministic ready set excludes waiting successors", () => {
    const i = readiness(), before = JSON.stringify(i);
    expect(sliceReadiness(i).ready.map(String)).toEqual(["S1"]);
    expect(sliceReadiness({ ...i, plan: { ...i.plan, slices: [...i.plan.slices].reverse() } })).toEqual(sliceReadiness(i));
    expect(JSON.stringify(i)).toBe(before);
  });
  test("completed predecessor enables Slice, no lexical sequence inference", () => {
    const i = readiness(); i.states = [i.f.sliceState];
    expect(sliceReadiness(i).ready.map(String)).toEqual(["S2"]);
  });
  test.each(["pending", "ready", "running", "verifying", "failed", "blocked", "interrupted", "skipped", "cancelled", "unknown"] as const)("%s Slice predecessor does not satisfy dependency", (status) => {
    const i = readiness(); i.states = [sliceExecutionStateSchema.parse({ ...i.f.sliceState, status })];
    expect(sliceReadiness(i).ready).not.toContain("S2");
    expect(sliceReadiness(i).blocked.find((s) => s.slice === "S2")!.reasons.map((r) => r.code)).toContain("slice-predecessor-not-completed");
  });
  test("stale plan binding, revoked approval and duplicate state block readiness", () => {
    const i = readiness(); i.states = [{ ...i.f.sliceState, plan: { ...referenceOf(i.f.sl), hash: hash(999) } }];
    expect(sliceReadiness(i).ready).toEqual([]);
    const j = readiness(); j.review.spec.approval_applicability = []; expect(sliceReadiness(j).ready).toEqual([]);
    const k = readiness(); k.states = [k.f.sliceState, k.f.sliceState]; expect(sliceReadiness(k).ready).toEqual([]);
  });
  test("Task requires an explicit active runnable Slice", () => {
    const f = fixture(); f.spec.lifecycle = { state: "implementing" };
    const i = { definitions: f.tasks, catalog: f.catalog, states: [], review: f.review, preconditions: [], slices: f.slices, slice_states: [], active_slices: [] as typeof f.slices.slices[number]["id"][] };
    expect(taskReadiness(i).ready).toEqual([]);
    i.active_slices = [sliceIdSchema.parse("S1")]; expect(taskReadiness(i).ready.map(String)).toEqual(["T1"]);
    expect(taskReadiness({ ...i, slice_states: [{ ...f.sliceState, status: "verifying" }] }).ready).toEqual([]);
  });
  test("Task cannot run across an incomplete predecessor Slice even with task prerequisite completed", () => {
    const i = readiness(); i.f.tasks.tasks = [task(), taskDefinitionSchema.parse({ ...task("T2", ["T1"]), slice: "S2" })];
    const t = { definitions: i.f.tasks, catalog: i.f.catalog, states: [i.f.state], review: i.review, preconditions: [], slices: i.plan, slice_states: [], active_slices: [sliceIdSchema.parse("S2")] };
    expect(taskReadiness(t).ready).toEqual([]);
    expect(taskReadiness({ ...t, slice_states: [i.f.sliceState] }).ready.map(String)).toEqual(["T2"]);
  });
  test("full exact Slice completion succeeds", () => { expect(evaluateSliceCompletion(completion())).toEqual([]); });
  test.each(["worker-only", "missing-tasks", "missing-verification", "stale-verification", "failed-verification", "checkpoint", "predicate", "wrong-run"] as const)("Slice completion rejects %s", (kind) => {
    const i = completion(); let candidate: SliceCompletionInput = i;
    if (kind === "worker-only") candidate = { ...i, states: [{ ...i.states[0]!, status: "running" }] };
    if (kind === "missing-tasks") candidate = { ...i, task_states: [] };
    if (kind === "missing-verification") candidate = { ...i, evidence: [] };
    if (kind === "stale-verification") candidate = { ...i, evidence_contexts: i.evidence_contexts.map((c) => ({ ...c, workspace: { ...c.workspace, digest: hash(999) } })) };
    if (kind === "failed-verification") candidate = { ...i, evidence: i.evidence.map((e) => ({ ...e, outcome: "failed" })) };
    if (kind === "checkpoint") candidate = { ...i, slice: { ...i.slice, checkpoint: { policy: policyRef("review"), verifier: i.slice.required_verifiers[0]! } } };
    if (kind === "predicate") candidate = { ...i, slice: { ...i.slice, completion: [{ id: "extra", predicate: "Additional requirement", verifier: "V99" as never }] } };
    if (kind === "wrong-run") candidate = { ...i, task_states: i.task_states.map((s) => ({ ...s, run: "run_other" as never })) };
    expect(evaluateSliceCompletion(candidate).length).toBeGreaterThan(0);
  });
});
