import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  executeWorkflow,
  ExecutionError,
  type ExecutionContextInput,
  type ShellRunner,
} from "../../src/executor";
import {
  createRun,
  getRunPaths,
  loadRun,
  patchStepState,
  saveRun,
  type RunState,
  type StepStatus,
} from "../../src/run";
import {
  combineShellOutput,
  ShellCommandError,
  type ShellCommandResult,
} from "../../src/shell";
import type { Workflow, WorkflowStep } from "../../src/workflow";

let directory: string;
let runsRoot: string;
let cwd: string;

const emptyContext: ExecutionContextInput = {
  config: {},
  artifacts: {},
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-loop-executor-"));
  runsRoot = path.join(directory, ".aira", "runs");
  cwd = path.join(directory, "project");
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

function flattenStepIds(workflow: Workflow): string[] {
  const ids: string[] = [];

  const visit = (steps: readonly WorkflowStep[]) => {
    for (const step of steps) {
      ids.push(step.id);

      if (step.uses === "loop") {
        visit(step.steps);
      }
    }
  };

  visit(workflow.steps);
  return ids;
}

async function createState(
  workflow: Workflow,
  input: Record<string, unknown> = {},
  stepIds: readonly string[] = flattenStepIds(workflow),
): Promise<RunState> {
  return createRun({
    runsRoot,
    workflow: workflow.name,
    input,
    stepIds,
    now: new Date("2026-08-26T10:55:01.000Z"),
  });
}

function makeResult(
  exitCode = 0,
  stdout = "",
  stderr = "",
  output = combineShellOutput(stdout, stderr),
): ShellCommandResult {
  return {
    exitCode,
    stdout,
    stderr,
    output,
    success: exitCode === 0,
  };
}

function tickingClock(
  start = "2026-08-26T11:00:00.000Z",
): () => Date {
  let offset = 0;
  const startTime = Date.parse(start);

  return () => {
    const value = new Date(startTime + offset * 1_000);
    offset += 1;
    return value;
  };
}

async function expectExecutionError(
  operation: () => Promise<unknown>,
): Promise<ExecutionError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionError);
    return error as ExecutionError;
  }

  throw new Error("expected workflow execution to fail");
}

describe("basic loop execution", () => {
  test("completes a one-iteration shell loop and continues the workflow", async () => {
    const workflow: Workflow = {
      name: "single-loop",
      steps: [
        {
          id: "verify-cycle",
          uses: "loop",
          when: "input.enabled == true",
          max_attempts: 3,
          until: "steps.verify.success == true",
          steps: [{ id: "verify", uses: "shell", run: "verify" }],
        },
        { id: "after", uses: "shell", run: "after" },
      ],
    };
    const state = await createState(workflow, { enabled: true });
    const calls: string[] = [];
    let runningSnapshot: RunState | undefined;
    let completionSnapshot: RunState | undefined;
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      now: tickingClock(),
      shellRunner: async ({ command }) => {
        calls.push(command);

        if (command === "verify") {
          runningSnapshot = await loadRun(runsRoot, state.id);
        } else {
          completionSnapshot = await loadRun(runsRoot, state.id);
        }

        return makeResult(0, `${command} passed`);
      },
    });

    expect(calls).toEqual(["verify", "after"]);
    expect(runningSnapshot).toMatchObject({
      status: "running",
      current_step: "verify-cycle",
      steps: {
        "verify-cycle": {
          status: "running",
          attempt: 1,
          started_at: "2026-08-26T11:00:00.000Z",
        },
        verify: {
          status: "running",
          attempt: 1,
          started_at: "2026-08-26T11:00:01.000Z",
        },
      },
    });
    expect(completionSnapshot).toMatchObject({
      status: "running",
      current_step: "after",
      steps: {
        "verify-cycle": {
          status: "completed",
          attempt: 1,
          success: true,
        },
        verify: {
          status: "completed",
          attempt: 1,
          success: true,
        },
        after: { status: "running", attempt: 1 },
      },
    });
    expect(finalState.status).toBe("completed");
    expect(finalState.current_step).toBeUndefined();
    expect(finalState.steps["verify-cycle"]).toMatchObject({
      status: "completed",
      attempt: 1,
      started_at: "2026-08-26T11:00:00.000Z",
      completed_at: "2026-08-26T11:00:03.000Z",
      success: true,
    });
    expect(finalState.steps.verify).toMatchObject({
      status: "completed",
      attempt: 1,
      success: true,
      exit_code: 0,
    });
    expect(finalState.steps.after).toMatchObject({
      status: "completed",
      attempt: 1,
    });
    expect(await loadRun(runsRoot, state.id)).toEqual(finalState);
  });

  test("retries after a normal child failure and uses the latest result", async () => {
    const workflow: Workflow = {
      name: "retry-loop",
      steps: [
        {
          id: "verify-cycle",
          uses: "loop",
          max_attempts: 3,
          until: "steps.verify.success == true",
          steps: [
            { id: "verify", uses: "shell", run: "verify" },
            { id: "evidence", uses: "shell", run: "evidence" },
          ],
        },
        { id: "after", uses: "shell", run: "after" },
      ],
    };
    const state = await createState(workflow);
    const calls: string[] = [];
    let firstFailureSnapshot: RunState | undefined;
    let secondIterationSnapshot: RunState | undefined;
    let verifyCalls = 0;
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      now: tickingClock(),
      shellRunner: async ({ command }) => {
        calls.push(command);

        if (command === "verify") {
          verifyCalls += 1;

          if (verifyCalls === 2) {
            secondIterationSnapshot = await loadRun(runsRoot, state.id);
          }

          return verifyCalls === 1
            ? makeResult(1, "", "verification failed", "iteration one")
            : makeResult(0, "verification passed", "", "iteration two");
        }

        if (command === "evidence" && verifyCalls === 1) {
          firstFailureSnapshot = await loadRun(runsRoot, state.id);
        }

        return makeResult();
      },
    });

    expect(calls).toEqual([
      "verify",
      "evidence",
      "verify",
      "evidence",
      "after",
    ]);
    expect(firstFailureSnapshot).toMatchObject({
      status: "running",
      current_step: "verify-cycle",
      steps: {
        "verify-cycle": { status: "running", attempt: 1 },
        verify: {
          status: "failed",
          attempt: 1,
          success: false,
          exit_code: 1,
        },
        evidence: { status: "running", attempt: 1 },
      },
    });
    expect(secondIterationSnapshot).toMatchObject({
      status: "running",
      current_step: "verify-cycle",
      steps: {
        "verify-cycle": { status: "running", attempt: 2 },
        verify: { status: "running", attempt: 2 },
        evidence: { status: "pending", attempt: 1 },
      },
    });
    expect(secondIterationSnapshot?.steps.evidence).toEqual({
      status: "pending",
      attempt: 1,
    });
    expect(finalState.status).toBe("completed");
    expect(finalState.steps["verify-cycle"]).toMatchObject({
      status: "completed",
      attempt: 2,
      started_at: "2026-08-26T11:00:00.000Z",
      success: true,
    });
    expect(finalState.steps.verify).toMatchObject({
      status: "completed",
      attempt: 2,
      success: true,
      output: "iteration two",
    });
    expect(finalState.steps.evidence?.attempt).toBe(2);
    expect(finalState.steps.after?.status).toBe("completed");
    expect(await loadRun(runsRoot, state.id)).toEqual(finalState);
  });
});

describe("loop exhaustion", () => {
  test("waits after max attempts and preserves final iteration evidence", async () => {
    const workflow: Workflow = {
      name: "exhaust-loop",
      steps: [
        {
          id: "verify-cycle",
          uses: "loop",
          max_attempts: 3,
          until: "steps.verify.success == true",
          steps: [
            { id: "verify", uses: "shell", run: "verify" },
            { id: "evidence", uses: "shell", run: "evidence" },
          ],
        },
        { id: "after", uses: "shell", run: "after" },
      ],
    };
    const state = await createState(workflow);
    const calls: string[] = [];
    const waiting = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      now: tickingClock(),
      shellRunner: async ({ command }) => {
        calls.push(command);
        const persisted = await loadRun(runsRoot, state.id);
        expect(persisted.current_step).toBe("verify-cycle");

        return command === "verify"
          ? makeResult(9, "", "still failing", `failure ${calls.length}`)
          : makeResult(0, "evidence saved");
      },
    });

    expect(calls).toEqual([
      "verify",
      "evidence",
      "verify",
      "evidence",
      "verify",
      "evidence",
    ]);
    expect(waiting.status).toBe("waiting");
    expect(waiting.current_step).toBe("verify-cycle");
    expect(waiting.steps["verify-cycle"]).toMatchObject({
      status: "waiting",
      attempt: 3,
      success: false,
      started_at: "2026-08-26T11:00:00.000Z",
    });
    expect(waiting.steps["verify-cycle"]?.completed_at).toBeUndefined();
    expect(waiting.steps.verify).toMatchObject({
      status: "failed",
      attempt: 3,
      success: false,
      exit_code: 9,
      output: "failure 5",
    });
    expect(waiting.steps.evidence).toMatchObject({
      status: "completed",
      attempt: 3,
      success: true,
    });
    expect(waiting.steps.after).toEqual({
      status: "pending",
      attempt: 0,
    });
    expect(await loadRun(runsRoot, state.id)).toEqual(waiting);
  });

  test("uses exactly one iteration when max_attempts is one", async () => {
    const workflow: Workflow = {
      name: "one-attempt-loop",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 1,
          until: "steps.verify.success == true",
          steps: [{ id: "verify", uses: "shell", run: "verify" }],
        },
      ],
    };
    const state = await createState(workflow);
    let calls = 0;
    const waiting = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      shellRunner: async () => {
        calls += 1;
        return makeResult(1);
      },
    });

    expect(calls).toBe(1);
    expect(waiting.status).toBe("waiting");
    expect(waiting.steps.cycle?.attempt).toBe(1);
    expect(waiting.steps.verify?.attempt).toBe(1);
  });
});

describe("loop child failure policy", () => {
  test("keeps top-level non-zero failure terminal but processes later loop children", async () => {
    const topLevelWorkflow: Workflow = {
      name: "top-level-failure",
      steps: [
        { id: "verify-top", uses: "shell", run: "verify-top" },
        { id: "after-top", uses: "shell", run: "after-top" },
      ],
    };
    const topLevelState = await createState(topLevelWorkflow);
    const topLevelCalls: string[] = [];
    const topLevelResult = await executeWorkflow({
      workflow: topLevelWorkflow,
      runsRoot,
      state: topLevelState,
      context: emptyContext,
      cwd,
      shellRunner: async ({ command }) => {
        topLevelCalls.push(command);
        return makeResult(4);
      },
    });

    expect(topLevelCalls).toEqual(["verify-top"]);
    expect(topLevelResult.status).toBe("failed");
    expect(topLevelResult.steps["after-top"]?.status).toBe("pending");

    const loopWorkflow: Workflow = {
      name: "loop-domain-failure",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 1,
          until: "steps.verify.success == true",
          steps: [
            { id: "verify", uses: "shell", run: "verify" },
            { id: "record", uses: "shell", run: "record" },
          ],
        },
      ],
    };
    const loopState = await createState(loopWorkflow);
    const loopCalls: string[] = [];
    let observedRunStatus: string | undefined;
    const loopResult = await executeWorkflow({
      workflow: loopWorkflow,
      runsRoot,
      state: loopState,
      context: emptyContext,
      cwd,
      shellRunner: async ({ command }) => {
        loopCalls.push(command);

        if (command === "record") {
          observedRunStatus = (await loadRun(runsRoot, loopState.id)).status;
        }

        return command === "verify" ? makeResult(4) : makeResult();
      },
    });

    expect(loopCalls).toEqual(["verify", "record"]);
    expect(observedRunStatus).toBe("running");
    expect(loopResult.status).toBe("waiting");
    expect(loopResult.steps.verify?.status).toBe("failed");
    expect(loopResult.steps.record?.status).toBe("completed");
  });

  test("treats a multi-command non-zero result as loop evidence", async () => {
    const workflow: Workflow = {
      name: "multi-command-loop",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 1,
          until: "steps.verify.success == true",
          steps: [
            {
              id: "verify",
              uses: "shell",
              commands: [
                { name: "test", run: "test" },
                { name: "lint", run: "lint" },
              ],
            },
            { id: "record", uses: "shell", run: "record" },
          ],
        },
      ],
    };
    const state = await createState(workflow);
    const calls: string[] = [];
    const waiting = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      shellRunner: async ({ command }) => {
        calls.push(command);
        return command === "test" ? makeResult(2) : makeResult();
      },
    });

    expect(calls).toEqual(["test", "lint", "record"]);
    expect(waiting.status).toBe("waiting");
    expect(waiting.steps.verify).toMatchObject({
      status: "failed",
      attempt: 1,
      exit_code: 2,
    });
    expect(waiting.steps.record?.status).toBe("completed");
  });
});

describe("loop child replay reset", () => {
  test("resets completed, failed, and skipped children before replay", async () => {
    const workflow: Workflow = {
      name: "reset-loop-children",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.observer.attempt == 2",
          steps: [
            { id: "observer", uses: "shell", run: "observer" },
            { id: "completed", uses: "shell", run: "completed" },
            { id: "failed", uses: "shell", run: "failed" },
            {
              id: "skipped",
              uses: "shell",
              run: "skipped",
              when: "input.run_skipped == true",
            },
          ],
        },
      ],
    };
    let state = await createState(workflow, { run_skipped: false });
    const staleFields = {
      started_at: "2026-08-26T10:40:00.000Z",
      completed_at: "2026-08-26T10:41:00.000Z",
      success: true,
      exit_code: 23,
      summary: "stale summary",
      result: "stale result",
      artifact: "stale artifact",
      output: "stale output",
    };
    state = patchStepState(state, "completed", {
      attempt: 4,
      ...staleFields,
    });
    state = patchStepState(state, "failed", {
      attempt: 2,
      ...staleFields,
    });
    state = patchStepState(state, "skipped", {
      attempt: 7,
      ...staleFields,
    });
    await saveRun(runsRoot, state);

    let observerCalls = 0;
    let clockCalls = 0;
    let resetBoundarySnapshot: RunState | undefined;
    let replaySnapshot: RunState | undefined;
    const startTime = Date.parse("2026-08-26T11:00:00.000Z");
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      now: () => {
        clockCalls += 1;

        if (clockCalls === 10) {
          const stateFile = getRunPaths(runsRoot, state.id).stateFile;
          resetBoundarySnapshot = JSON.parse(
            readFileSync(stateFile, "utf8"),
          ) as RunState;
        }

        return new Date(startTime + (clockCalls - 1) * 1_000);
      },
      shellRunner: async ({ command }) => {
        if (command === "observer") {
          observerCalls += 1;

          if (observerCalls === 2) {
            replaySnapshot = await loadRun(runsRoot, state.id);
          }
        }

        return command === "failed" ? makeResult(8) : makeResult();
      },
    });

    expect(resetBoundarySnapshot).toMatchObject({
      status: "running",
      current_step: "cycle",
      steps: {
        cycle: { status: "running", attempt: 1 },
      },
    });
    expect(resetBoundarySnapshot?.steps.observer).toEqual({
      status: "pending",
      attempt: 1,
    });
    expect(resetBoundarySnapshot?.steps.completed).toEqual({
      status: "pending",
      attempt: 5,
    });
    expect(resetBoundarySnapshot?.steps.failed).toEqual({
      status: "pending",
      attempt: 3,
    });
    expect(resetBoundarySnapshot?.steps.skipped).toEqual({
      status: "pending",
      attempt: 7,
    });
    expect(replaySnapshot?.steps.completed).toEqual({
      status: "pending",
      attempt: 5,
    });
    expect(replaySnapshot?.steps.failed).toEqual({
      status: "pending",
      attempt: 3,
    });
    expect(replaySnapshot?.steps.skipped).toEqual({
      status: "pending",
      attempt: 7,
    });
    expect(replaySnapshot).toMatchObject({
      status: "running",
      current_step: "cycle",
      steps: {
        cycle: { status: "running", attempt: 2 },
        observer: { status: "running", attempt: 2 },
      },
    });
    expect(finalState.status).toBe("completed");
    expect(finalState.steps.cycle).toMatchObject({
      status: "completed",
      attempt: 2,
    });
    expect(finalState.steps.completed?.attempt).toBe(6);
    expect(finalState.steps.failed).toMatchObject({
      status: "failed",
      attempt: 4,
    });
    expect(finalState.steps.skipped).toEqual({
      status: "skipped",
      attempt: 7,
    });
  });
});

describe("loop child when conditions", () => {
  test("executes true children and skips false children", async () => {
    const workflow: Workflow = {
      name: "loop-child-conditions",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 1,
          until: "steps.required.success == true",
          steps: [
            {
              id: "required",
              uses: "shell",
              run: "required",
              when: "input.enabled == true",
            },
            {
              id: "optional",
              uses: "shell",
              run: "optional",
              when: "input.optional == true",
            },
          ],
        },
      ],
    };
    const state = await createState(workflow, {
      enabled: true,
      optional: false,
    });
    const calls: string[] = [];
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      shellRunner: async ({ command }) => {
        calls.push(command);
        return makeResult();
      },
    });

    expect(calls).toEqual(["required"]);
    expect(finalState.steps.required).toMatchObject({
      status: "completed",
      attempt: 1,
    });
    expect(finalState.steps.optional).toEqual({
      status: "skipped",
      attempt: 0,
    });
    expect(finalState.status).toBe("completed");
  });

  test("reevaluates a skipped child in the next iteration", async () => {
    const workflow: Workflow = {
      name: "reevaluate-skipped-child",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.verify.success == true",
          steps: [
            { id: "verify", uses: "shell", run: "verify" },
            {
              id: "report",
              uses: "shell",
              run: "report",
              when: "steps.verify.success == true",
            },
          ],
        },
      ],
    };
    const state = await createState(workflow);
    const calls: string[] = [];
    let verifyCalls = 0;
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      shellRunner: async ({ command }) => {
        calls.push(command);

        if (command === "verify") {
          verifyCalls += 1;
          return makeResult(verifyCalls === 1 ? 1 : 0);
        }

        return makeResult();
      },
    });

    expect(calls).toEqual(["verify", "verify", "report"]);
    expect(finalState.status).toBe("completed");
    expect(finalState.steps.cycle?.attempt).toBe(2);
    expect(finalState.steps.verify?.attempt).toBe(2);
    expect(finalState.steps.report).toMatchObject({
      status: "completed",
      attempt: 1,
      success: true,
    });
  });

  test("fails technically when a child condition reference is missing", async () => {
    const workflow: Workflow = {
      name: "missing-child-condition",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.broken.success == true",
          steps: [
            {
              id: "broken",
              uses: "shell",
              run: "must not run",
              when: "steps.missing.success == true",
            },
          ],
        },
        { id: "after", uses: "shell", run: "after" },
      ],
    };
    const state = await createState(workflow);
    let called = false;
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        shellRunner: async () => {
          called = true;
          return makeResult();
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain("when condition failed");
    expect(error.message).toContain(
      'condition reference "steps.missing.success" was not found',
    );
    expect(error.stepId).toBe("broken");
    expect(called).toBe(false);
    expect(persisted.status).toBe("failed");
    expect(persisted.current_step).toBe("cycle");
    expect(persisted.steps.cycle).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
    });
    expect(persisted.steps.broken).toMatchObject({
      status: "failed",
      attempt: 0,
      success: false,
    });
    expect(persisted.steps.after?.status).toBe("pending");
  });
});

describe("loop when conditions", () => {
  test("skips a false loop without touching its children", async () => {
    const workflow: Workflow = {
      name: "skip-whole-loop",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          when: "input.enabled == true",
          max_attempts: 2,
          until: "steps.missing.success == true",
          steps: [{ id: "verify", uses: "shell", run: "verify" }],
        },
        { id: "after", uses: "shell", run: "after" },
      ],
    };
    let state = await createState(workflow, { enabled: false });
    state = patchStepState(state, "verify", {
      status: "completed",
      attempt: 3,
      success: true,
      output: "existing evidence",
    });
    await saveRun(runsRoot, state);
    const originalChildState = state.steps.verify;
    const calls: string[] = [];
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      shellRunner: async ({ command }) => {
        calls.push(command);
        return makeResult();
      },
    });

    expect(calls).toEqual(["after"]);
    expect(finalState.steps.cycle).toEqual({
      status: "skipped",
      attempt: 0,
    });
    expect(finalState.steps.verify).toEqual(originalChildState);
    expect(finalState.steps.after?.status).toBe("completed");
    expect(finalState.status).toBe("completed");
  });

  test("fails before starting an iteration when loop when is invalid", async () => {
    const workflow: Workflow = {
      name: "invalid-loop-condition",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          when: "input.enabled",
          max_attempts: 2,
          until: "steps.verify.success == true",
          steps: [{ id: "verify", uses: "shell", run: "verify" }],
        },
      ],
    };
    const state = await createState(workflow, { enabled: true });
    let called = false;
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        shellRunner: async () => {
          called = true;
          return makeResult();
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain("when condition failed");
    expect(error.message).toContain("explicit comparison");
    expect(called).toBe(false);
    expect(persisted.status).toBe("failed");
    expect(persisted.current_step).toBe("cycle");
    expect(persisted.steps.cycle).toMatchObject({
      status: "failed",
      attempt: 0,
      success: false,
    });
    expect(persisted.steps.verify).toEqual({
      status: "pending",
      attempt: 0,
    });
  });
});

describe("loop technical failures", () => {
  test("fails after child execution when until evaluation fails", async () => {
    const workflow: Workflow = {
      name: "invalid-until",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.missing.success == true",
          steps: [{ id: "verify", uses: "shell", run: "verify" }],
        },
      ],
    };
    const state = await createState(workflow);
    let calls = 0;
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        shellRunner: async () => {
          calls += 1;
          return makeResult();
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(calls).toBe(1);
    expect(error.message).toContain("until condition failed");
    expect(error.message).toContain(
      'condition reference "steps.missing.success" was not found',
    );
    expect(error.stepId).toBe("cycle");
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.cycle).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
    });
    expect(persisted.steps.cycle?.completed_at).toBeDefined();
    expect(persisted.steps.verify).toMatchObject({
      status: "completed",
      attempt: 1,
      success: true,
    });
  });

  test("fails the child, loop, and run on interpolation failure", async () => {
    const workflow: Workflow = {
      name: "loop-interpolation-failure",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.broken.success == true",
          steps: [
            {
              id: "broken",
              uses: "shell",
              run: "{{ config.commands.missing }}",
            },
          ],
        },
      ],
    };
    const state = await createState(workflow);
    let called = false;
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        shellRunner: async () => {
          called = true;
          return makeResult();
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain(
      'template reference "config.commands.missing" was not found',
    );
    expect(called).toBe(false);
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.cycle).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
    });
    expect(persisted.steps.broken).toMatchObject({
      status: "failed",
      attempt: 0,
      success: false,
    });
  });

  test("does not retry a shell runtime error", async () => {
    const workflow: Workflow = {
      name: "loop-runtime-failure",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 3,
          until: "steps.verify.success == true",
          steps: [
            { id: "verify", uses: "shell", run: "verify" },
            { id: "after-child", uses: "shell", run: "after-child" },
          ],
        },
      ],
    };
    const state = await createState(workflow);
    let calls = 0;
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        shellRunner: async () => {
          calls += 1;
          throw new Error("process could not start");
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(calls).toBe(1);
    expect(error.message).toContain("shell execution failed");
    expect(error.message).toContain("process could not start");
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.cycle).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
    });
    expect(persisted.steps.verify).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
      exit_code: 1,
    });
    expect(persisted.steps.verify?.output).toContain("process could not start");
    expect(persisted.steps["after-child"]).toEqual({
      status: "pending",
      attempt: 0,
    });
  });

  test("persists a loop child timeout as a technical failure", async () => {
    const workflow: Workflow = {
      name: "loop-timeout-failure",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.verify.success == true",
          steps: [{ id: "verify", uses: "shell", run: "verify" }],
        },
      ],
    };
    const state = await createState(workflow);
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        shellRunner: async () => {
          throw new ShellCommandError(
            "shell command timed out after 1 seconds",
            { kind: "timeout", exitCode: 124 },
          );
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain("timed out after 1 seconds");
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.cycle?.status).toBe("failed");
    expect(persisted.steps.verify).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
      exit_code: 124,
    });
  });

  test("runs remaining commands but stops the loop after a multi-command runtime error", async () => {
    const workflow: Workflow = {
      name: "loop-multi-runtime-failure",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.verify.success == true",
          steps: [
            {
              id: "verify",
              uses: "shell",
              commands: [
                { name: "test", run: "test" },
                { name: "lint", run: "lint" },
              ],
            },
          ],
        },
      ],
    };
    const state = await createState(workflow);
    const calls: string[] = [];
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        shellRunner: async ({ command }) => {
          calls.push(command);

          if (command === "test") {
            throw new Error("test process failed to spawn");
          }

          return makeResult();
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(calls).toEqual(["test", "lint"]);
    expect(error.message).toContain('command "test" shell execution failed');
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.cycle?.attempt).toBe(1);
    expect(persisted.steps.verify).toMatchObject({
      status: "failed",
      attempt: 1,
      exit_code: 1,
    });
    expect(persisted.steps.verify?.output).toContain("== test ==");
    expect(persisted.steps.verify?.output).toContain("== lint ==");
  });
});

describe("loop child state consistency", () => {
  test("fails before an iteration when a child state is missing", async () => {
    const workflow: Workflow = {
      name: "missing-loop-child-state",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.verify.success == true",
          steps: [{ id: "verify", uses: "shell", run: "verify" }],
        },
      ],
    };
    const state = await createState(workflow, {}, ["cycle"]);
    let called = false;
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        shellRunner: async () => {
          called = true;
          return makeResult();
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain(
      'child step "verify" of loop "cycle" is missing from run state',
    );
    expect(error.stepId).toBe("verify");
    expect(called).toBe(false);
    expect(persisted.status).toBe("failed");
    expect(persisted.current_step).toBe("cycle");
    expect(persisted.steps.cycle).toMatchObject({
      status: "failed",
      attempt: 0,
      success: false,
    });
    expect(persisted.steps.verify).toBeUndefined();
  });

  test("fails before an iteration when a child is not pending", async () => {
    const workflow: Workflow = {
      name: "unexpected-loop-child-state",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.verify.success == true",
          steps: [{ id: "verify", uses: "shell", run: "verify" }],
        },
      ],
    };
    let state = await createState(workflow);
    state = patchStepState(state, "verify", {
      status: "completed",
      attempt: 2,
      success: true,
      output: "stale result",
    });
    await saveRun(runsRoot, state);
    let called = false;
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        shellRunner: async () => {
          called = true;
          return makeResult();
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain(
      'must have status "pending" before initial execution',
    );
    expect(error.message).toContain('found "completed"');
    expect(called).toBe(false);
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.cycle).toMatchObject({
      status: "failed",
      attempt: 0,
      success: false,
    });
    expect(persisted.steps.verify).toMatchObject({
      status: "failed",
      attempt: 2,
      success: false,
    });
  });
});

describe("loop child dependencies and restrictions", () => {
  test("skips a false agent child without requiring agent dependencies", async () => {
    const workflow: Workflow = {
      name: "unreached-agent-child",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.verify.success == true",
          steps: [
            { id: "verify", uses: "shell", run: "verify" },
            {
              id: "repair",
              uses: "agent",
              command: "repair",
              when: "steps.verify.success == false",
            },
          ],
        },
      ],
    };
    const state = await createState(workflow);
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      shellRunner: async () => makeResult(),
    });

    expect(finalState.status).toBe("completed");
    expect(finalState.steps.cycle).toMatchObject({
      status: "completed",
      attempt: 1,
    });
    expect(finalState.steps.repair).toEqual({
      status: "skipped",
      attempt: 0,
    });
  });

  test("fails clearly when an agent child has no runtime dependency", async () => {
    const workflow: Workflow = {
      name: "unsupported-agent-child",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.repair.success == true",
          steps: [{ id: "repair", uses: "agent", command: "repair" }],
        },
      ],
    };
    const state = await createState(workflow);
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toBe(
      'agent step "repair" requires an AgentRuntime',
    );
    expect(error.stepId).toBe("repair");
    expect(persisted.status).toBe("failed");
    expect(persisted.current_step).toBe("cycle");
    expect(persisted.steps.cycle).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
    });
    expect(persisted.steps.repair).toMatchObject({
      status: "failed",
      attempt: 0,
      success: false,
    });
  });

  test("fails clearly instead of waiting on an approval child", async () => {
    const workflow: Workflow = {
      name: "unsupported-approval-child",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.approve.success == true",
          steps: [{ id: "approve", uses: "approval" }],
        },
      ],
    };
    const state = await createState(workflow);
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain(
      "approval steps inside loops are not supported by the current runtime",
    );
    expect(error.stepId).toBe("approve");
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.cycle).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
    });
    expect(persisted.steps.approve).toMatchObject({
      status: "failed",
      attempt: 0,
      success: false,
    });
    expect(persisted.steps.approve?.status).not.toBe("waiting");
  });
});

describe("loop continue mode", () => {
  test("executes a pending loop after bypassing completed top-level work", async () => {
    const workflow: Workflow = {
      name: "continue-to-pending-loop",
      steps: [
        { id: "before", uses: "shell", run: "before" },
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.verify.success == true",
          steps: [{ id: "verify", uses: "shell", run: "verify" }],
        },
        { id: "after", uses: "shell", run: "after" },
      ],
    };
    let state = await createState(workflow);
    state = patchStepState(state, "before", {
      status: "completed",
      attempt: 1,
      success: true,
    });
    await saveRun(runsRoot, state);
    const calls: string[] = [];
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      mode: "continue",
      shellRunner: async ({ command }) => {
        calls.push(command);
        return makeResult();
      },
    });

    expect(calls).toEqual(["verify", "after"]);
    expect(finalState.status).toBe("completed");
    expect(finalState.steps.before?.attempt).toBe(1);
    expect(finalState.steps.cycle).toMatchObject({
      status: "completed",
      attempt: 1,
    });
  });

  test.each(["completed", "skipped"] as const)(
    "bypasses a %s loop and executes the next pending top-level step",
    async (status) => {
      const workflow: Workflow = {
        name: `continue-${status}-loop`,
        steps: [
          {
            id: "cycle",
            uses: "loop",
            max_attempts: 2,
            until: "steps.verify.success == true",
            steps: [{ id: "verify", uses: "shell", run: "verify" }],
          },
          { id: "after", uses: "shell", run: "after" },
        ],
      };
      let state = await createState(workflow);
      state = patchStepState(state, "cycle", {
        status,
        attempt: status === "completed" ? 1 : 0,
        ...(status === "completed" ? { success: true } : {}),
      });
      state = patchStepState(state, "verify", {
        status: "completed",
        attempt: 1,
        success: true,
      });
      await saveRun(runsRoot, state);
      const originalLoopState = state.steps.cycle;
      const originalChildState = state.steps.verify;
      const calls: string[] = [];
      const finalState = await executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        mode: "continue",
        shellRunner: async ({ command }) => {
          calls.push(command);
          return makeResult();
        },
      });

      expect(calls).toEqual(["after"]);
      expect(finalState.steps.cycle).toEqual(originalLoopState);
      expect(finalState.steps.verify).toEqual(originalChildState);
      expect(finalState.steps.after?.status).toBe("completed");
      expect(finalState.status).toBe("completed");
    },
  );

  test.each([
    "waiting",
    "running",
    "failed",
    "interrupted",
  ] as const)("rejects a %s loop instead of resuming it", async (status) => {
    const workflow: Workflow = {
      name: `reject-${status}-loop`,
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.verify.success == true",
          steps: [{ id: "verify", uses: "shell", run: "verify" }],
        },
      ],
    };
    let state = await createState(workflow);
    state = patchStepState(state, "cycle", {
      status: status as StepStatus,
      attempt: 1,
    });
    await saveRun(runsRoot, state);
    let called = false;
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        mode: "continue",
        shellRunner: async () => {
          called = true;
          return makeResult();
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain(
      'step "cycle" must have status "pending" before execution',
    );
    expect(error.message).toContain(`found "${status}"`);
    expect(called).toBe(false);
    expect(persisted.status).toBe("failed");
    expect(persisted.current_step).toBe("cycle");
    expect(persisted.steps.cycle).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
    });
    expect(persisted.steps.verify).toEqual({
      status: "pending",
      attempt: 0,
    });
  });
});
