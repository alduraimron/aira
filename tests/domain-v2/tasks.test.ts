import { describe, expect, test } from "bun:test";
import { validateTaskGraph, orderTasks } from "../../src/tasks/graph";
import { taskReadiness } from "../../src/tasks/readiness";
import { taskDefinitionSchema } from "../../src/tasks/schema";
import { taskExecutionStateSchema } from "../../src/execution/schema";
import { artifactRevisionIdSchema, taskIdSchema } from "../../src/spec/domain/ids";
import { fixture, task, hash } from "./fixtures";

const graphCodes = (tasks: unknown) => { const f = fixture(); return validateTaskGraph({ ...f.tasks, tasks }, f.catalog).map((i) => i.code); };
describe("INV-TASK-003/004: structured identity-based DAG", () => {
  test("valid graph, independent of declaration order and numeric suffix", () => {
    const f = fixture();
    expect(validateTaskGraph({ ...f.tasks, tasks: [task("T2", ["T10"]), task("T10")] }, f.catalog)).toEqual([]);
  });
  test("duplicate task ID", () => { expect(graphCodes([task(), task()])).toContain("duplicate-task"); });
  test("unknown dependency", () => { expect(graphCodes([task("T1", ["T9"])])).toContain("unknown-dependency"); });
  test("self dependency", () => { expect(graphCodes([task("T1", ["T1"])])).toContain("self-dependency"); });
  test("direct cycle", () => { expect(graphCodes([task("T1", ["T2"]), task("T2", ["T1"])])).toContain("task-cycle"); });
  test("indirect cycle", () => { expect(graphCodes([task("T1", ["T2"]), task("T2", ["T3"]), task("T3", ["T1"])])).toContain("task-cycle"); });
  test("stable cycle membership/error results under input reordering", () => {
    const f = fixture(); const definitions = [task("T3", ["T1"]), task("T2", ["T3"]), task("T1", ["T2", "T9"])];
    const expected = validateTaskGraph({ ...f.tasks, tasks: definitions }, f.catalog);
    expect(expected).toContainEqual({ code: "task-cycle", related: ["T1", "T2", "T3"] });
    for (const ordered of [definitions, [...definitions].reverse(), [definitions[1], definitions[2], definitions[0]]])
      expect(validateTaskGraph({ ...f.tasks, tasks: ordered }, f.catalog)).toEqual(expected);
  });
  test.each([
    ["requirements", ["R9"], "unknown-task-requirement"],
    ["acceptance_criteria", ["R1.AC9"], "unknown-task-acceptance-criterion"],
    ["design_decisions", ["D9"], "unknown-task-design-decision"],
  ] as const)("unknown %s reference", (field, value, code) => {
    expect(graphCodes([{ ...task(), [field]: [...value] }])).toContain(code);
  });
  test("unknown verifier, policy, execution profile, and context references", () => {
    const t = taskDefinitionSchema.parse({ ...task(), verifiers: ["V9"], completion: [{ kind: "verification", verifier: "V9" }],
      capability_policy: { ...task().capability_policy, revision: "rev_missing" }, execution_profile: { ...task().execution_profile, revision: "rev_missing" },
      context: { declarations: [], references: [{ id: "context_missing", revision: "rev_missing", hash: hash(1) }] } });
    const codes = graphCodes([t]);
    for (const code of ["unknown-task-verifier", "unknown-task-policy", "unknown-task-execution-profile", "unknown-task-context"]) expect(codes).toContain(code);
  });
  test("malformed reference and invalid graph shape fail closed", () => {
    expect(graphCodes([{ ...task(), execution_profile: { id: "execute" } }])).toEqual(["invalid-task-graph-shape"]);
    expect(graphCodes([])).toEqual(["invalid-task-graph-shape"]);
    expect(graphCodes("- [ ] T1: prose is not a DAG")).toEqual(["invalid-task-graph-shape"]);
  });
  test("explicit ordering is priority descending then ID codepoint, never an edge", () => {
    const priority = { ...task("T2"), scheduling: { ...task().scheduling, priority: 5 } };
    expect(orderTasks([task("T10"), task("T1"), priority]).map((t) => String(t.identity.id))).toEqual(["T2", "T1", "T10"]);
    expect(task("T10").dependencies).toEqual([]);
  });
});

describe("INV-TASK-001/003: set-based readiness", () => {
  function input() {
    const f = fixture(); f.spec.lifecycle = { state: "ready" };
    return { definitions: { ...f.tasks, tasks: [task("T3", ["T1"]), task("T2"), task("T1")] }, catalog: f.catalog, states: [] as typeof f.run.tasks,
      review: f.review, preconditions: [], f };
  }
  test("all roots ready and dependent waits; no current_task cursor", () => {
    const i = input(), result = taskReadiness(i);
    expect(result.ready.map(String)).toEqual(["T1", "T2"]); expect(result.blocked.map((b) => String(b.task))).toEqual(["T3"]);
    expect(result).not.toHaveProperty("current_task"); expect(result.issues).toEqual([]);
  });
  test("completed predecessor enables dependent", () => {
    const i = input(); i.states = [i.f.state];
    expect(taskReadiness(i).ready.map(String)).toEqual(["T2", "T3"]);
    expect(taskReadiness(i).terminal).toEqual([{ task: taskIdSchema.parse("T1"), state: "completed" }]);
  });
  test.each(["pending", "ready", "claimed", "running", "verifying", "failed", "interrupted", "skipped", "cancelled", "unknown"] as const)("%s predecessor is not completed", (status) => {
    const i = input();
    i.states = [taskExecutionStateSchema.parse({ ...i.f.state, status, claim: "claim_one" })];
    expect(taskReadiness(i).ready).not.toContain(taskIdSchema.parse("T3"));
    expect(taskReadiness(i).blocked.find((b) => b.task === "T3")!.reasons.map((r) => r.code)).toContain("dependency-not-completed");
  });
  test("readiness result stable under task/state reordering", () => {
    const i = input(); i.states = [i.f.state];
    const before = JSON.stringify(i);
    const expected = taskReadiness(i);
    expect(taskReadiness({ ...i, definitions: { ...i.definitions, tasks: [...i.definitions.tasks].reverse() }, states: [...i.states].reverse() })).toEqual(expected);
    expect(JSON.stringify(i)).toBe(before);
  });
  test("failed/interrupted tasks are not automatically replayed by readiness", () => {
    const i = input(); i.states = [{ ...i.f.state, status: "interrupted" }];
    expect(taskReadiness(i).blocked.find((b) => b.task === "T1")!.reasons).toContainEqual({ code: "task-recovery-required", task: "T1", subject: "interrupted" });
  });
  test("approval, stale definition, and explicit policy precondition each block roots", () => {
    const i = input(); i.review.spec.approval_applicability = [];
    expect(taskReadiness(i).ready).toEqual([]);
    const j = input(); j.states = [{ ...j.f.state, task: { ...j.f.state.task, revision: artifactRevisionIdSchema.parse("rev_old") } }];
    expect(taskReadiness(j).ready).toEqual([]);
    const k = input();
    const result = taskReadiness({ ...k, preconditions: [{ task: taskIdSchema.parse("T1"), blockers: [{ code: "policy-escalation-required" }] }] });
    expect(result.ready.map(String)).toEqual(["T2"]);
  });
});
