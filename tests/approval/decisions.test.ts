import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  applyApprovalDecision,
  ApprovalError,
} from "../../src/approval";
import type { ApprovalDecision } from "../../src/approval";
import {
  createRun,
  getRunPaths,
  loadRun,
  patchStepState,
  saveRun,
} from "../../src/run";
import type { RunState } from "../../src/run";
import type { Workflow } from "../../src/workflow";

let directory: string;
let runsRoot: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-approval-"));
  runsRoot = path.join(directory, ".aira", "runs");
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function createState(
  workflow: Workflow,
  stepIds: readonly string[] = workflow.steps.map((step) => step.id),
  workflowName = workflow.name,
): Promise<RunState> {
  return createRun({
    runsRoot,
    workflow: workflowName,
    input: {},
    stepIds,
    now: new Date("2026-08-26T10:55:01.000Z"),
  });
}

async function createWaitingState(
  workflow: Workflow,
  stepId: string,
  stepIds?: readonly string[],
  workflowName?: string,
): Promise<RunState> {
  let state = await createState(workflow, stepIds, workflowName);
  state = patchStepState(state, stepId, { status: "waiting" });
  state = {
    ...state,
    status: "waiting",
    current_step: stepId,
  };
  await saveRun(
    runsRoot,
    state,
    new Date("2026-08-26T11:00:00.000Z"),
  );
  return state;
}

async function expectApprovalError(
  operation: () => Promise<unknown>,
): Promise<ApprovalError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ApprovalError);
    return error as ApprovalError;
  }

  throw new Error("expected approval decision to fail");
}

async function readPersistedSource(state: RunState): Promise<string> {
  return readFile(getRunPaths(runsRoot, state.id).stateFile, "utf8");
}

async function expectRejectedWithoutChanges(params: {
  workflow: Workflow;
  state: RunState;
  stepId: string;
  decision?: ApprovalDecision;
  expectedMessage: string;
}): Promise<void> {
  await saveRun(
    runsRoot,
    params.state,
    new Date("2026-08-26T11:05:00.000Z"),
  );
  const stateBefore = structuredClone(params.state);
  const sourceBefore = await readPersistedSource(params.state);
  const error = await expectApprovalError(() =>
    applyApprovalDecision({
      workflow: params.workflow,
      runsRoot,
      state: params.state,
      stepId: params.stepId,
      decision: params.decision ?? "approve",
      now: () => new Date("2026-08-26T12:00:00.000Z"),
    }),
  );

  expect(error.message).toContain(params.expectedMessage);
  expect(params.state).toEqual(stateBefore);
  expect(await readPersistedSource(params.state)).toBe(sourceBefore);
  expect(await loadRun(runsRoot, params.state.id)).toEqual(stateBefore);
}

describe("approval decisions", () => {
  test("approve completes the approval and returns the run to running", async () => {
    const workflow: Workflow = {
      name: "approve-decision",
      steps: [
        { id: "approve-plan", uses: "approval" },
        { id: "later", uses: "shell", run: "later" },
      ],
    };
    const state = await createWaitingState(workflow, "approve-plan");
    const stateBefore = structuredClone(state);
    const approved = await applyApprovalDecision({
      workflow,
      runsRoot,
      state,
      stepId: "approve-plan",
      decision: "approve",
      now: () => new Date("2026-08-26T11:30:00.000Z"),
    });

    expect(approved.status).toBe("running");
    expect(approved.current_step).toBeUndefined();
    expect("current_step" in approved).toBe(false);
    expect(approved.steps["approve-plan"]).toEqual({
      status: "completed",
      attempt: 0,
      success: true,
      completed_at: "2026-08-26T11:30:00.000Z",
      result: "approved",
    });
    expect(approved.steps.later).toEqual({
      status: "pending",
      attempt: 0,
    });
    expect(approved.updated_at).toBe("2026-08-26T11:30:00.000Z");
    expect(state).toEqual(stateBefore);
    expect(await loadRun(runsRoot, state.id)).toEqual(approved);
  });

  test("cancel completes the approval without marking it failed", async () => {
    const workflow: Workflow = {
      name: "cancel-decision",
      steps: [
        { id: "approve-plan", uses: "approval" },
        { id: "later", uses: "shell", run: "later" },
      ],
    };
    const state = await createWaitingState(workflow, "approve-plan");
    const cancelled = await applyApprovalDecision({
      workflow,
      runsRoot,
      state,
      stepId: "approve-plan",
      decision: "cancel",
      now: () => new Date("2026-08-26T11:45:00.000Z"),
    });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.current_step).toBeUndefined();
    expect("current_step" in cancelled).toBe(false);
    expect(cancelled.steps["approve-plan"]).toEqual({
      status: "completed",
      attempt: 0,
      success: false,
      completed_at: "2026-08-26T11:45:00.000Z",
      result: "cancelled",
    });
    expect(cancelled.steps.later).toEqual({
      status: "pending",
      attempt: 0,
    });
    expect(await loadRun(runsRoot, state.id)).toEqual(cancelled);
  });

  test("revise resets the top-level replay range and preserves attempts", async () => {
    const workflow: Workflow = {
      name: "revise-decision",
      steps: [
        { id: "discover", uses: "agent", command: "discover" },
        {
          id: "plan",
          uses: "agent",
          command: "plan",
          artifact: {
            name: "plan",
            filename: "plan.md",
            versioned: true,
          },
        },
        { id: "validate", uses: "shell", run: "validate" },
        {
          id: "approve-plan",
          uses: "approval",
          artifact: "plan",
          revise: "plan",
        },
        { id: "later", uses: "shell", run: "later" },
      ],
    };
    let state = await createState(workflow);
    state = patchStepState(state, "discover", {
      status: "completed",
      attempt: 1,
      started_at: "2026-08-26T10:56:00.000Z",
      completed_at: "2026-08-26T10:57:00.000Z",
      success: true,
      summary: "discovered",
      artifact: "discovery",
      output: "discovery output",
    });
    state = patchStepState(state, "plan", {
      status: "completed",
      attempt: 2,
      started_at: "2026-08-26T10:58:00.000Z",
      completed_at: "2026-08-26T10:59:00.000Z",
      success: true,
      exit_code: 0,
      summary: "old plan",
      result: "generated",
      artifact: "plan",
      output: "old plan output",
    });
    state = patchStepState(state, "validate", {
      status: "completed",
      attempt: 3,
      started_at: "2026-08-26T11:00:00.000Z",
      completed_at: "2026-08-26T11:01:00.000Z",
      success: true,
      exit_code: 0,
      summary: "valid",
      result: "passed",
      artifact: "validation",
      output: "validation output",
    });
    state = patchStepState(state, "approve-plan", {
      status: "waiting",
      attempt: 4,
      completed_at: "2026-08-26T11:02:00.000Z",
      success: true,
      summary: "old decision summary",
      result: "approved",
      output: "old decision output",
    });
    state = {
      ...state,
      status: "waiting",
      current_step: "approve-plan",
      artifacts: {
        plan: {
          current: "artifacts/plan-v1.md",
          versions: ["artifacts/plan-v1.md"],
        },
      },
    };
    await saveRun(
      runsRoot,
      state,
      new Date("2026-08-26T11:03:00.000Z"),
    );
    const stateBefore = structuredClone(state);

    const revised = await applyApprovalDecision({
      workflow,
      runsRoot,
      state,
      stepId: "approve-plan",
      decision: "revise",
      now: () => new Date("2026-08-26T11:30:00.000Z"),
    });

    expect(revised.status).toBe("running");
    expect(revised.current_step).toBe("plan");
    expect(revised.steps.discover).toEqual(stateBefore.steps.discover);
    expect(revised.steps.plan).toEqual({
      status: "pending",
      attempt: 2,
    });
    expect(revised.steps.validate).toEqual({
      status: "pending",
      attempt: 3,
    });
    expect(revised.steps["approve-plan"]).toEqual({
      status: "pending",
      attempt: 4,
    });
    expect(revised.steps.later).toEqual({
      status: "pending",
      attempt: 0,
    });
    expect(revised.artifacts).toEqual(stateBefore.artifacts);
    expect(revised.updated_at).toBe("2026-08-26T11:30:00.000Z");
    expect(state).toEqual(stateBefore);
    expect(await loadRun(runsRoot, state.id)).toEqual(revised);
  });

  test("rejects revise when the approval has no revision target", async () => {
    const workflow: Workflow = {
      name: "revise-disabled",
      steps: [
        { id: "plan", uses: "agent", command: "plan" },
        { id: "approve-plan", uses: "approval" },
      ],
    };
    const state = await createWaitingState(workflow, "approve-plan");

    await expectRejectedWithoutChanges({
      workflow,
      state,
      stepId: "approve-plan",
      decision: "revise",
      expectedMessage:
        'approval step "approve-plan" does not support revision',
    });
  });
});

describe("approval decision preconditions", () => {
  test("rejects a run that is not waiting", async () => {
    const workflow: Workflow = {
      name: "not-waiting",
      steps: [{ id: "approve", uses: "approval" }],
    };
    const state = await createState(workflow);

    await expectRejectedWithoutChanges({
      workflow,
      state,
      stepId: "approve",
      expectedMessage: `run "${state.id}" is not waiting for approval`,
    });
  });

  test("rejects a step that is not current", async () => {
    const workflow: Workflow = {
      name: "wrong-current",
      steps: [
        { id: "approve", uses: "approval" },
        { id: "other", uses: "shell", run: "other" },
      ],
    };
    let state = await createState(workflow);
    state = patchStepState(state, "approve", { status: "waiting" });
    state = {
      ...state,
      status: "waiting",
      current_step: "other",
    };

    await expectRejectedWithoutChanges({
      workflow,
      state,
      stepId: "approve",
      expectedMessage: 'step "approve" is not the current waiting approval',
    });
  });

  test("rejects an unknown workflow step", async () => {
    const workflow: Workflow = {
      name: "unknown-step",
      steps: [{ id: "approve", uses: "approval" }],
    };
    let state = await createState(workflow, ["approve", "missing"]);
    state = patchStepState(state, "missing", { status: "waiting" });
    state = {
      ...state,
      status: "waiting",
      current_step: "missing",
    };

    await expectRejectedWithoutChanges({
      workflow,
      state,
      stepId: "missing",
      expectedMessage: 'does not contain step "missing"',
    });
  });

  test("rejects a non-approval workflow step", async () => {
    const workflow: Workflow = {
      name: "not-approval",
      steps: [{ id: "shell", uses: "shell", run: "shell" }],
    };
    let state = await createState(workflow);
    state = patchStepState(state, "shell", { status: "waiting" });
    state = {
      ...state,
      status: "waiting",
      current_step: "shell",
    };

    await expectRejectedWithoutChanges({
      workflow,
      state,
      stepId: "shell",
      expectedMessage: 'step "shell" is not an approval step',
    });
  });

  test("rejects an approval whose persisted state is not waiting", async () => {
    const workflow: Workflow = {
      name: "step-not-waiting",
      steps: [{ id: "approve", uses: "approval" }],
    };
    let state = await createState(workflow);
    state = {
      ...state,
      status: "waiting",
      current_step: "approve",
    };

    await expectRejectedWithoutChanges({
      workflow,
      state,
      stepId: "approve",
      expectedMessage: 'does not have persisted status "waiting"',
    });
  });

  test("rejects a workflow identity mismatch", async () => {
    const workflow: Workflow = {
      name: "received-workflow",
      steps: [{ id: "approve", uses: "approval" }],
    };
    const state = await createWaitingState(
      workflow,
      "approve",
      undefined,
      "created-workflow",
    );

    await expectRejectedWithoutChanges({
      workflow,
      state,
      stepId: "approve",
      expectedMessage:
        'was created for workflow "created-workflow" but approval decision ' +
        'received "received-workflow"',
    });
  });

  test("rejects an approval nested inside a loop", async () => {
    const workflow: Workflow = {
      name: "nested-approval",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.approve-nested.success == true",
          steps: [{ id: "approve-nested", uses: "approval" }],
        },
      ],
    };
    const state = await createWaitingState(
      workflow,
      "approve-nested",
      ["cycle", "approve-nested"],
    );

    await expectRejectedWithoutChanges({
      workflow,
      state,
      stepId: "approve-nested",
      expectedMessage: "nested/loop approval runtime is not supported yet",
    });
  });

  test("rejects decisions outside the strict decision union at runtime", async () => {
    const workflow: Workflow = {
      name: "invalid-decision",
      steps: [{ id: "approve", uses: "approval" }],
    };
    const state = await createWaitingState(workflow, "approve");

    await expectRejectedWithoutChanges({
      workflow,
      state,
      stepId: "approve",
      decision: "defer" as ApprovalDecision,
      expectedMessage: 'unsupported approval decision "defer"',
    });
  });
});
