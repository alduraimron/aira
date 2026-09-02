import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentRuntime,
  AgentStepRequest,
  AgentStepResult,
} from "../../src/agent";
import { applyApprovalDecision } from "../../src/approval";
import { writeArtifact } from "../../src/artifacts";
import {
  executeWorkflow,
  ExecutionError,
  prepareInterruptedRunForResume,
} from "../../src/executor";
import {
  createRun,
  getRunPaths,
  loadRun,
  patchStepState,
  saveRun,
  type RunState,
  type RunStatus,
  type StepState,
} from "../../src/run";
import type { ShellCommandResult } from "../../src/shell";
import type { Workflow, WorkflowStep } from "../../src/workflow";

let directory: string;
let runsRoot: string;
let cwd: string;
let commandsDir: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-resume-"));
  runsRoot = path.join(directory, ".aira", "runs");
  cwd = path.join(directory, "project");
  commandsDir = path.join(directory, "commands");
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(commandsDir, { recursive: true }),
  ]);
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

function shellResult(exitCode = 0): ShellCommandResult {
  return {
    exitCode,
    stdout: "",
    stderr: exitCode === 0 ? "" : "failed",
    output: exitCode === 0 ? "ok" : "failed",
    success: exitCode === 0,
  };
}

function interruptedStep(attempt: number): StepState {
  return {
    status: "interrupted",
    attempt,
    started_at: "2026-08-26T10:58:00.000Z",
    success: false,
    exit_code: 130,
    summary: "stale summary",
    result: "stale result",
    artifact: "stale artifact field",
    output: "partial output",
  };
}

function completedAgentResult(content?: string): AgentStepResult {
  return {
    success: true,
    sessionId: "fresh-session",
    finalText: "fresh response",
    timedOut: false,
    completion: {
      status: "completed",
      summary: "Fresh completion",
      artifacts:
        content === undefined ? [] : [{ name: "plan", content }],
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

describe("top-level resume", () => {
  test("persists normalization, reruns the interrupted step, and continues", async () => {
    const workflow: Workflow = {
      name: "resume-top-level",
      steps: [
        { id: "a", uses: "shell", run: "a" },
        { id: "b", uses: "shell", run: "b" },
        { id: "c", uses: "shell", run: "c" },
      ],
    };
    let state = await createState(workflow);
    state = patchStepState(state, "a", {
      status: "completed",
      attempt: 1,
      success: true,
      completed_at: "2026-08-26T10:57:00.000Z",
    });
    state = {
      ...state,
      status: "interrupted",
      current_step: "b",
      steps: {
        ...state.steps,
        b: interruptedStep(1),
      },
    };
    await saveRun(runsRoot, state);
    const calls: string[] = [];
    let normalized: RunState | undefined;
    let clockCalls = 0;
    const start = Date.parse("2026-08-26T11:00:00.000Z");

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      mode: "resume",
      now: () => {
        clockCalls += 1;

        if (clockCalls === 2) {
          normalized = JSON.parse(
            readFileSync(
              getRunPaths(runsRoot, state.id).stateFile,
              "utf8",
            ),
          ) as RunState;
        }

        return new Date(start + (clockCalls - 1) * 1_000);
      },
      shellRunner: async ({ command }) => {
        calls.push(command);
        return shellResult();
      },
    });

    expect(normalized?.status).toBe("running");
    expect(normalized?.current_step).toBe("b");
    expect(normalized?.steps.b).toEqual({ status: "pending", attempt: 1 });
    expect(calls).toEqual(["b", "c"]);
    expect(finalState.status).toBe("completed");
    expect(finalState.current_step).toBeUndefined();
    expect(finalState.steps.a?.attempt).toBe(1);
    expect(finalState.steps.b).toMatchObject({
      status: "completed",
      attempt: 2,
      success: true,
    });
    expect(finalState.steps.c).toMatchObject({
      status: "completed",
      attempt: 1,
    });
    expect(await loadRun(runsRoot, state.id)).toEqual(finalState);
  });

  test("starts a pending step that was never attempted before interruption", async () => {
    const workflow: Workflow = {
      name: "resume-before-start",
      steps: [{ id: "work", uses: "shell", run: "work" }],
    };
    let state = await createState(workflow);
    state = {
      ...state,
      status: "interrupted",
      current_step: "work",
    };
    await saveRun(runsRoot, state);
    let calls = 0;

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      mode: "resume",
      shellRunner: async () => {
        calls += 1;
        return shellResult();
      },
    });

    expect(calls).toBe(1);
    expect(finalState.status).toBe("completed");
    expect(finalState.steps.work).toMatchObject({
      status: "completed",
      attempt: 1,
    });
  });

  test("preparation is pure and clears transient fields while preserving attempts", async () => {
    const workflow: Workflow = {
      name: "pure-resume",
      steps: [{ id: "work", uses: "shell", run: "work" }],
    };
    const created = await createState(workflow);
    const state: RunState = {
      ...created,
      status: "interrupted",
      current_step: "work",
      steps: { work: interruptedStep(4) },
    };
    const original = structuredClone(state);

    const prepared = prepareInterruptedRunForResume(workflow, state);

    expect(state).toEqual(original);
    expect(prepared.replayLoopId).toBeUndefined();
    expect(prepared.state.status).toBe("running");
    expect(prepared.state.current_step).toBe("work");
    expect(prepared.state.steps.work).toEqual({
      status: "pending",
      attempt: 4,
    });
  });
});

describe("agent resume and durable outputs", () => {
  test("uses the next session log and creates a new artifact version", async () => {
    await writeFile(path.join(commandsDir, "plan.md"), "Create a plan.", "utf8");
    const workflow: Workflow = {
      name: "resume-agent",
      steps: [
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
      ],
    };
    let state = await createState(workflow);
    state = (
      await writeArtifact({
        runsRoot,
        state,
        name: "plan",
        filename: "plan.md",
        versioned: true,
        content: "plan v1 before interruption",
      })
    ).state;
    state = {
      ...state,
      status: "interrupted",
      current_step: "plan",
      steps: { ...state.steps, plan: interruptedStep(1) },
    };
    await saveRun(runsRoot, state);
    const paths = getRunPaths(runsRoot, state.id);
    const firstLog = path.join(paths.sessionsDir, "plan-1.jsonl");
    await writeFile(firstLog, "old session\n", "utf8");
    const requests: AgentStepRequest[] = [];
    const agentRuntime: AgentRuntime = {
      async runStep(request) {
        requests.push(request);
        await writeFile(request.sessionLogPath ?? "", "new session\n", "utf8");
        return completedAgentResult("plan v2 after resume");
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
      mode: "resume",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.sessionLogPath).toBe(
      path.join(paths.sessionsDir, "plan-2.jsonl"),
    );
    expect(finalState.steps.plan).toMatchObject({
      status: "completed",
      attempt: 2,
      artifact: "artifacts/plan-v2.md",
    });
    expect(finalState.artifacts.plan).toEqual({
      current: "artifacts/plan-v2.md",
      versions: ["artifacts/plan-v1.md", "artifacts/plan-v2.md"],
    });
    expect(await readFile(firstLog, "utf8")).toBe("old session\n");
    expect(
      await readFile(path.join(paths.sessionsDir, "plan-2.jsonl"), "utf8"),
    ).toBe("new session\n");
    expect(
      await readFile(path.join(paths.artifactsDir, "plan-v1.md"), "utf8"),
    ).toBe("plan v1 before interruption");
    expect(
      await readFile(path.join(paths.artifactsDir, "plan-v2.md"), "utf8"),
    ).toBe("plan v2 after resume");
  });

  test("restores revision feedback and the previous artifact after a crash", async () => {
    await writeFile(path.join(commandsDir, "plan.md"), "Create a plan.", "utf8");
    const workflow: Workflow = {
      name: "resume-revision",
      steps: [
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
        {
          id: "approve",
          uses: "approval",
          artifact: "plan",
          revise: "plan",
        },
      ],
    };
    const state = await createState(workflow);
    const requests: AgentStepRequest[] = [];
    let calls = 0;
    const agentRuntime: AgentRuntime = {
      async runStep(request) {
        calls += 1;
        requests.push(request);
        return completedAgentResult(`plan v${calls}`);
      },
    };
    const firstWaiting = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      commandsDir,
      agentRuntime,
    });
    const feedback = "Add validator tests and a rollback section.";
    const revised = await applyApprovalDecision({
      workflow,
      runsRoot,
      state: firstWaiting,
      stepId: "approve",
      decision: "revise",
      feedback,
    });
    let crashed = patchStepState(revised, "plan", {
      status: "running",
      attempt: 2,
      started_at: "2026-08-26T11:30:00.000Z",
    });
    crashed = {
      ...crashed,
      status: "running",
      current_step: "plan",
    };
    await saveRun(runsRoot, crashed);

    const resumed = await executeWorkflow({
      workflow,
      runsRoot,
      state: await loadRun(runsRoot, state.id),
      context: { config: {} },
      cwd,
      commandsDir,
      agentRuntime,
      mode: "resume",
    });

    expect(calls).toBe(2);
    expect(requests[1]?.prompt).toContain(feedback);
    expect(requests[1]?.prompt).toContain("plan v1");
    expect(requests[1]?.sessionLogPath).toBe(
      path.join(
        getRunPaths(runsRoot, state.id).sessionsDir,
        "plan-3.jsonl",
      ),
    );
    expect(resumed.status).toBe("waiting");
    expect(resumed.current_step).toBe("approve");
    expect(resumed.steps.plan).toMatchObject({
      status: "completed",
      attempt: 3,
      artifact: "artifacts/plan-v2.md",
    });
    expect(resumed.revisions?.[0]).toMatchObject({
      status: "resolved",
      feedback,
      previous_artifact: {
        name: "plan",
        path: "artifacts/plan-v1.md",
      },
    });
  });
});

describe("loop resume", () => {
  test("replays the interrupted iteration from child one without double-counting it", async () => {
    const workflow: Workflow = {
      name: "resume-loop",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 3,
          until: "steps.first.success == true",
          steps: [
            { id: "first", uses: "shell", run: "first" },
            { id: "second", uses: "shell", run: "second" },
          ],
        },
      ],
    };
    let state = await createState(workflow);
    state = {
      ...state,
      status: "interrupted",
      current_step: "cycle",
      steps: {
        cycle: {
          status: "interrupted",
          attempt: 2,
          started_at: "2026-08-26T10:56:00.000Z",
          success: false,
          output: "interrupted in child two",
        },
        first: {
          status: "completed",
          attempt: 2,
          success: true,
          completed_at: "2026-08-26T10:58:00.000Z",
          output: "stale iteration output",
        },
        second: interruptedStep(2),
      },
    };
    await saveRun(runsRoot, state);
    let normalized: RunState | undefined;
    const snapshots: RunState[] = [];
    const calls: string[] = [];
    let clockCalls = 0;
    const start = Date.parse("2026-08-26T11:00:00.000Z");

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      mode: "resume",
      now: () => {
        clockCalls += 1;

        if (clockCalls === 2) {
          normalized = JSON.parse(
            readFileSync(
              getRunPaths(runsRoot, state.id).stateFile,
              "utf8",
            ),
          ) as RunState;
        }

        return new Date(start + (clockCalls - 1) * 1_000);
      },
      shellRunner: async ({ command }) => {
        calls.push(command);
        snapshots.push(await loadRun(runsRoot, state.id));

        if (command === "first" && calls.length === 1) {
          return shellResult(1);
        }

        return shellResult();
      },
    });

    expect(normalized?.status).toBe("running");
    expect(normalized?.current_step).toBe("cycle");
    expect(normalized?.steps.cycle).toMatchObject({
      status: "running",
      attempt: 2,
    });
    expect(normalized?.steps.first).toEqual({ status: "pending", attempt: 2 });
    expect(normalized?.steps.second).toEqual({ status: "pending", attempt: 2 });
    expect(calls).toEqual(["first", "second", "first", "second"]);
    expect(snapshots[0]).toMatchObject({
      steps: {
        cycle: { status: "running", attempt: 2 },
        first: { status: "running", attempt: 3 },
        second: { status: "pending", attempt: 2 },
      },
    });
    expect(snapshots[2]).toMatchObject({
      steps: {
        cycle: { status: "running", attempt: 3 },
        first: { status: "running", attempt: 4 },
        second: { status: "pending", attempt: 3 },
      },
    });
    expect(finalState.status).toBe("completed");
    expect(finalState.steps.cycle?.attempt).toBe(3);
    expect(finalState.steps.first?.attempt).toBe(4);
    expect(finalState.steps.second?.attempt).toBe(4);
  });

  test("replays an interrupted final allowed iteration instead of waiting", async () => {
    const workflow: Workflow = {
      name: "resume-final-loop-iteration",
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
    state = {
      ...state,
      status: "interrupted",
      current_step: "cycle",
      steps: {
        cycle: {
          status: "interrupted",
          attempt: 2,
          started_at: "2026-08-26T10:56:00.000Z",
          success: false,
        },
        verify: interruptedStep(2),
      },
    };
    await saveRun(runsRoot, state);
    let calls = 0;

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      mode: "resume",
      shellRunner: async () => {
        calls += 1;
        return shellResult();
      },
    });

    expect(calls).toBe(1);
    expect(finalState.status).toBe("completed");
    expect(finalState.steps.cycle).toMatchObject({
      status: "completed",
      attempt: 2,
    });
    expect(finalState.steps.verify?.attempt).toBe(3);
  });
});

describe("invalid resume", () => {
  test("continue mode does not normalize an interrupted run", async () => {
    const workflow: Workflow = {
      name: "continue-is-not-resume",
      steps: [{ id: "work", uses: "shell", run: "work" }],
    };
    let state = await createState(workflow);
    state = {
      ...state,
      status: "interrupted",
      current_step: "work",
      steps: { work: interruptedStep(1) },
    };
    await saveRun(runsRoot, state);
    const original = await loadRun(runsRoot, state.id);

    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: { config: {} },
        cwd,
        mode: "continue",
      }),
    );

    expect(error.message).toContain('must have status "running"');
    expect(await loadRun(runsRoot, state.id)).toEqual(original);
  });

  const statuses: Exclude<RunStatus, "interrupted">[] = [
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
  ];

  test.each(statuses)("rejects %s without mutation", async (status) => {
    const workflow: Workflow = {
      name: `invalid-resume-${status}`,
      steps: [{ id: "work", uses: "shell", run: "work" }],
    };
    const state = await createState(workflow);
    state.status = status;
    await saveRun(runsRoot, state);
    const originalMemory = structuredClone(state);
    const originalDisk = await loadRun(runsRoot, state.id);
    let calls = 0;

    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: { config: {} },
        cwd,
        mode: "resume",
        shellRunner: async () => {
          calls += 1;
          return shellResult();
        },
      }),
    );

    expect(error.message).toContain('must have status "interrupted"');
    expect(calls).toBe(0);
    expect(state).toEqual(originalMemory);
    expect(await loadRun(runsRoot, state.id)).toEqual(originalDisk);
  });

  test("does not resume a waiting approval", async () => {
    const workflow: Workflow = {
      name: "invalid-resume-approval",
      steps: [{ id: "approve", uses: "approval" }],
    };
    let state = await createState(workflow);
    state = {
      ...state,
      status: "waiting",
      current_step: "approve",
      steps: {
        approve: { status: "waiting", attempt: 0 },
      },
    };
    await saveRun(runsRoot, state);

    await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: { config: {} },
        cwd,
        mode: "resume",
      }),
    );

    expect((await loadRun(runsRoot, state.id)).status).toBe("waiting");
  });

  test("does not resume an exhausted waiting loop", async () => {
    const workflow: Workflow = {
      name: "invalid-resume-exhausted-loop",
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
    let state = await createState(workflow);
    state = {
      ...state,
      status: "waiting",
      current_step: "cycle",
      steps: {
        cycle: { status: "waiting", attempt: 1, success: false },
        verify: { status: "failed", attempt: 1, success: false },
      },
    };
    await saveRun(runsRoot, state);

    await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: { config: {} },
        cwd,
        mode: "resume",
      }),
    );

    const persisted = await loadRun(runsRoot, state.id);
    expect(persisted.status).toBe("waiting");
    expect(persisted.steps.cycle?.status).toBe("waiting");
  });
});
