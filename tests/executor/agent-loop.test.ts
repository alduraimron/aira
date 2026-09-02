import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentRuntime,
  AgentStepRequest,
  AgentStepResult,
} from "../../src/agent";
import {
  executeWorkflow,
  ExecutionError,
  type ShellRunner,
} from "../../src/executor";
import {
  createRun,
  getRunPaths,
  loadRun,
  type RunState,
} from "../../src/run";
import type { ShellCommandResult } from "../../src/shell";
import type { Workflow, WorkflowStep } from "../../src/workflow";

let directory: string;
let runsRoot: string;
let cwd: string;
let commandsDir: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-agent-loop-"));
  runsRoot = path.join(directory, ".aira", "runs");
  cwd = path.join(directory, "project");
  commandsDir = path.join(directory, "commands");
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(commandsDir, { recursive: true }),
  ]);
  await writeFile(
    path.join(commandsDir, "repair.md"),
    "Repair the failed verification.",
    "utf8",
  );
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

function flattenIds(steps: readonly WorkflowStep[]): string[] {
  return steps.flatMap((step) =>
    step.uses === "loop"
      ? [step.id, ...flattenIds(step.steps)]
      : [step.id],
  );
}

async function createState(workflow: Workflow): Promise<RunState> {
  return createRun({
    runsRoot,
    workflow: workflow.name,
    input: {},
    stepIds: flattenIds(workflow.steps),
    now: new Date("2026-08-26T10:55:01.000Z"),
  });
}

function shellResult(success: boolean): ShellCommandResult {
  return {
    exitCode: success ? 0 : 1,
    stdout: success ? "verified" : "",
    stderr: success ? "" : "verification failed",
    output: success ? "verified" : "verification failed",
    success,
  };
}

function completedAgentResult(): AgentStepResult {
  return {
    success: true,
    sessionId: "repair-session",
    finalText: "Repair applied.",
    timedOut: false,
    completion: {
      status: "completed",
      summary: "Repaired the verification failure.",
      artifacts: [],
    },
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

describe("agent children inside loops", () => {
  test("runs verify, repair, then verify successfully", async () => {
    const workflow: Workflow = {
      name: "verify-repair-cycle",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 3,
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
    let verifyCalls = 0;
    const shellRunner: ShellRunner = async () => {
      verifyCalls += 1;
      return shellResult(verifyCalls === 2);
    };
    const agentRequests: AgentStepRequest[] = [];
    let runningSnapshot: RunState | undefined;
    const agentRuntime: AgentRuntime = {
      async runStep(request) {
        agentRequests.push(request);
        runningSnapshot = await loadRun(runsRoot, state.id);
        return completedAgentResult();
      },
    };

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      commandsDir,
      agentRuntime,
      shellRunner,
    });

    expect(verifyCalls).toBe(2);
    expect(agentRequests).toHaveLength(1);
    expect(agentRequests[0]?.sessionLogPath).toBe(
      path.join(
        getRunPaths(runsRoot, state.id).sessionsDir,
        "repair-1.jsonl",
      ),
    );
    expect(agentRequests[0]?.tools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "complete_step",
    ]);
    expect(runningSnapshot).toMatchObject({
      status: "running",
      current_step: "cycle",
      steps: {
        cycle: { status: "running", attempt: 1 },
        verify: { status: "failed", attempt: 1, success: false },
        repair: { status: "running", attempt: 1 },
      },
    });
    expect(finalState.status).toBe("completed");
    expect(finalState.current_step).toBeUndefined();
    expect(finalState.steps.cycle).toMatchObject({
      status: "completed",
      attempt: 2,
      success: true,
    });
    expect(finalState.steps.verify).toMatchObject({
      status: "completed",
      attempt: 2,
      success: true,
    });
    expect(finalState.steps.repair).toEqual({
      status: "skipped",
      attempt: 1,
    });
    expect(await loadRun(runsRoot, state.id)).toEqual(finalState);
  });

  test.each([
    [
      "runtime failure",
      (): AgentStepResult => ({
        success: false,
        sessionId: "failed",
        finalText: "partial repair",
        timedOut: false,
        error: "provider failed",
      }),
      "runtime failed",
      10,
    ],
    [
      "missing completion",
      (): AgentStepResult => ({
        success: true,
        sessionId: "missing",
        finalText: "DONE",
        timedOut: false,
      }),
      "completed without calling complete_step",
      1,
    ],
    [
      "rejected completion attempts",
      (): AgentStepResult => ({
        success: true,
        sessionId: "protocol",
        finalText: "done",
        timedOut: false,
        completionError: "all complete_step attempts were rejected",
      }),
      "completion protocol failed",
      1,
    ],
  ] as const)("fails the child, loop, and run on %s", async (
    _name,
    result,
    expected,
    expectedCalls,
  ) => {
    const workflow: Workflow = {
      name: `loop-agent-${_name.replaceAll(" ", "-")}`,
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 3,
          until: "steps.repair.success == true",
          steps: [
            { id: "repair", uses: "agent", command: "repair", retry: 9 },
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
        context: { config: { defaults: { technical_retries: 7 } } },
        cwd,
        commandsDir,
        agentRuntime: {
          async runStep() {
            calls += 1;
            return result();
          },
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain(expected);
    expect(calls).toBe(expectedCalls);
    expect(persisted.status).toBe("failed");
    expect(persisted.current_step).toBe("cycle");
    expect(persisted.steps.cycle).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
    });
    expect(persisted.steps.repair).toMatchObject({
      status: "failed",
      attempt: expectedCalls,
      success: false,
    });
  });
});
