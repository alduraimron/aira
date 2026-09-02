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

import {
  AgentRuntimeError,
  type AgentCompletion,
  type AgentRuntime,
  type AgentStepRequest,
  type AgentStepResult,
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
import {
  ShellCommandError,
  type ShellCommandResult,
} from "../../src/shell";
import type { Workflow, WorkflowStep } from "../../src/workflow";

let directory: string;
let runsRoot: string;
let cwd: string;
let commandsDir: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-retry-"));
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

async function createState(
  workflow: Workflow,
  input: Record<string, unknown> = {},
): Promise<RunState> {
  return createRun({
    runsRoot,
    workflow: workflow.name,
    input,
    stepIds: flattenIds(workflow.steps),
    now: new Date("2026-08-26T10:55:01.000Z"),
  });
}

async function writeCommand(name: string, source = "Do the work.") {
  await writeFile(path.join(commandsDir, `${name}.md`), source, "utf8");
}

function completion(summary = "Work complete."): AgentCompletion {
  return { status: "completed", summary, artifacts: [] };
}

function completedAgentResult(
  sessionId: string,
  summary = "Work complete.",
): AgentStepResult {
  return {
    success: true,
    sessionId,
    finalText: `final ${sessionId}`,
    timedOut: false,
    completion: completion(summary),
  };
}

function shellResult(exitCode = 0): ShellCommandResult {
  return {
    exitCode,
    stdout: "",
    stderr: exitCode === 0 ? "" : "verification failed",
    output: exitCode === 0 ? "ok" : "verification failed",
    success: exitCode === 0,
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

describe("agent technical retries", () => {
  test("persists each attempt, uses a fresh runtime call, and succeeds on retry", async () => {
    await writeCommand(
      "work",
      "---\nretry: 0\n---\nDo the work.",
    );
    const workflow: Workflow = {
      name: "agent-retry-success",
      steps: [
        { id: "work", uses: "agent", command: "work", retry: 1 },
      ],
    };
    const state = await createState(workflow);
    const requests: AgentStepRequest[] = [];
    const runningSnapshots: RunState[] = [];
    let betweenAttempts: RunState | undefined;
    let clockCalls = 0;
    const start = Date.parse("2026-08-26T11:00:00.000Z");
    const agentRuntime: AgentRuntime = {
      async runStep(request) {
        requests.push(request);
        runningSnapshots.push(await loadRun(runsRoot, state.id));
        await writeFile(
          request.sessionLogPath ?? "",
          `session ${requests.length}\n`,
          "utf8",
        );

        if (requests.length === 1) {
          return {
            success: false,
            sessionId: "session-a",
            finalText: "partial first session",
            timedOut: false,
            error: "provider temporarily unavailable",
          };
        }

        return completedAgentResult("session-b");
      },
    };

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: { defaults: { technical_retries: 9 } } },
      cwd,
      commandsDir,
      agentRuntime,
      now: () => {
        clockCalls += 1;

        if (clockCalls === 3) {
          betweenAttempts = JSON.parse(
            readFileSync(
              getRunPaths(runsRoot, state.id).stateFile,
              "utf8",
            ),
          ) as RunState;
        }

        return new Date(start + (clockCalls - 1) * 1_000);
      },
    });
    const sessionsDir = getRunPaths(runsRoot, state.id).sessionsDir;

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.sessionLogPath)).toEqual([
      path.join(sessionsDir, "work-1.jsonl"),
      path.join(sessionsDir, "work-2.jsonl"),
    ]);
    expect(runningSnapshots.map((snapshot) => snapshot.steps.work?.attempt))
      .toEqual([1, 2]);
    expect(
      runningSnapshots.map((snapshot) => snapshot.steps.work?.started_at),
    ).toEqual([
      "2026-08-26T11:00:00.000Z",
      "2026-08-26T11:00:02.000Z",
    ]);
    expect(runningSnapshots[0]?.steps.work?.status).toBe("running");
    expect(betweenAttempts?.steps.work).toMatchObject({
      status: "running",
      attempt: 1,
      success: false,
    });
    expect(betweenAttempts?.steps.work?.completed_at).toBeUndefined();
    expect(betweenAttempts?.steps.work?.output).toContain(
      "provider temporarily unavailable",
    );
    expect(finalState.status).toBe("completed");
    expect(finalState.steps.work).toMatchObject({
      status: "completed",
      attempt: 2,
      success: true,
    });
    expect(await readFile(path.join(sessionsDir, "work-1.jsonl"), "utf8"))
      .toBe("session 1\n");
    expect(await readFile(path.join(sessionsDir, "work-2.jsonl"), "utf8"))
      .toBe("session 2\n");
    expect(await loadRun(runsRoot, state.id)).toEqual(finalState);
  });

  test("treats zero retries as one total attempt", async () => {
    await writeCommand("work");
    const workflow: Workflow = {
      name: "agent-zero-retries",
      steps: [{ id: "work", uses: "agent", command: "work" }],
    };
    const state = await createState(workflow);
    let calls = 0;

    await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: { config: { defaults: { technical_retries: 0 } } },
        cwd,
        commandsDir,
        agentRuntime: {
          async runStep() {
            calls += 1;
            throw new Error("provider unavailable");
          },
        },
      }),
    );

    expect(calls).toBe(1);
    expect((await loadRun(runsRoot, state.id)).steps.work?.attempt).toBe(1);
  });

  test("exhausts exactly the configured total attempts", async () => {
    await writeCommand("work");
    const workflow: Workflow = {
      name: "agent-retry-exhaustion",
      steps: [{ id: "work", uses: "agent", command: "work" }],
    };
    const state = await createState(workflow);
    let calls = 0;

    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: { config: { defaults: { technical_retries: 2 } } },
        cwd,
        commandsDir,
        agentRuntime: {
          async runStep() {
            calls += 1;
            return {
              success: false,
              sessionId: `failed-${calls}`,
              finalText: "partial",
              timedOut: calls === 3,
              error: "provider failed",
            };
          },
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain("timed out");
    expect(calls).toBe(3);
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.work).toMatchObject({
      status: "failed",
      attempt: 3,
      success: false,
    });
    expect(persisted.steps.work?.completed_at).toBeDefined();
  });

  test.each([
    ["invalid request", "invalid-request"],
    ["model resolution", "model-resolution"],
  ] as const)("does not retry a deterministic %s error", async (_label, kind) => {
    await writeCommand("work");
    const workflow: Workflow = {
      name: `no-retry-${kind}`,
      steps: [
        { id: "work", uses: "agent", command: "work", retry: 5 },
      ],
    };
    const state = await createState(workflow);
    let calls = 0;

    await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: { config: {} },
        cwd,
        commandsDir,
        agentRuntime: {
          async runStep() {
            calls += 1;
            throw new AgentRuntimeError(`deterministic ${kind}`, {
              kind,
              stepId: "work",
            });
          },
        },
      }),
    );

    expect(calls).toBe(1);
    expect((await loadRun(runsRoot, state.id)).steps.work?.attempt).toBe(1);
  });

  test("does not retry command interpolation failure", async () => {
    await writeCommand("work", "Use {{ input.missing }}.");
    const workflow: Workflow = {
      name: "no-retry-agent-interpolation",
      steps: [
        { id: "work", uses: "agent", command: "work", retry: 5 },
      ],
    };
    const state = await createState(workflow);
    let calls = 0;

    await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: { config: {} },
        cwd,
        commandsDir,
        agentRuntime: {
          async runStep() {
            calls += 1;
            return completedAgentResult("unused");
          },
        },
      }),
    );

    expect(calls).toBe(0);
    expect((await loadRun(runsRoot, state.id)).steps.work?.attempt).toBe(0);
  });

  test.each([
    [
      "missing completion",
      (): AgentStepResult => ({
        success: true,
        sessionId: "missing",
        finalText: "DONE",
        timedOut: false,
      }),
    ],
    [
      "rejected completion attempts",
      (): AgentStepResult => ({
        success: true,
        sessionId: "rejected",
        finalText: "done",
        timedOut: false,
        completionError: "all complete_step attempts were rejected",
      }),
    ],
    [
      "invalid completion",
      (): AgentStepResult => ({
        success: true,
        sessionId: "invalid",
        finalText: "done",
        timedOut: false,
        completion: {
          status: "completed",
          summary: "   ",
          artifacts: [],
        },
      }),
    ],
  ] as const)("does not retry %s", async (_label, makeResult) => {
    await writeCommand("work");
    const workflow: Workflow = {
      name: `no-retry-${_label.replaceAll(" ", "-")}`,
      steps: [
        { id: "work", uses: "agent", command: "work", retry: 5 },
      ],
    };
    const state = await createState(workflow);
    let calls = 0;

    await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: { config: {} },
        cwd,
        commandsDir,
        agentRuntime: {
          async runStep() {
            calls += 1;
            return makeResult();
          },
        },
      }),
    );

    expect(calls).toBe(1);
    expect((await loadRun(runsRoot, state.id)).steps.work?.attempt).toBe(1);
  });
});

describe("shell technical retries", () => {
  test("retries a timeout using config defaults and accumulates attempts", async () => {
    const workflow: Workflow = {
      name: "shell-timeout-retry",
      steps: [{ id: "verify", uses: "shell", run: "verify" }],
    };
    const state = await createState(workflow);
    const snapshots: RunState[] = [];
    let calls = 0;
    const shellRunner: ShellRunner = async () => {
      calls += 1;
      snapshots.push(await loadRun(runsRoot, state.id));

      if (calls === 1) {
        throw new ShellCommandError("temporary timeout", {
          kind: "timeout",
          exitCode: 124,
        });
      }

      return shellResult();
    };

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: { defaults: { technical_retries: 1 } } },
      cwd,
      shellRunner,
    });

    expect(calls).toBe(2);
    expect(snapshots.map((snapshot) => snapshot.steps.verify?.attempt))
      .toEqual([1, 2]);
    expect(finalState.status).toBe("completed");
    expect(finalState.steps.verify).toMatchObject({
      status: "completed",
      attempt: 2,
      exit_code: 0,
    });
  });

  test("does not retry a command that becomes empty after interpolation", async () => {
    const workflow: Workflow = {
      name: "shell-empty-command",
      steps: [
        { id: "verify", uses: "shell", run: "{{ input.command }}" },
      ],
    };
    const state = await createState(workflow, { command: "" });
    let calls = 0;

    await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: { config: { defaults: { technical_retries: 8 } } },
        cwd,
        shellRunner: async () => {
          calls += 1;
          return shellResult();
        },
      }),
    );

    expect(calls).toBe(0);
    expect((await loadRun(runsRoot, state.id)).steps.verify?.attempt).toBe(0);
  });

  test("does not retry a normal non-zero exit", async () => {
    const workflow: Workflow = {
      name: "shell-domain-failure",
      steps: [{ id: "verify", uses: "shell", run: "verify" }],
    };
    const state = await createState(workflow);
    let calls = 0;

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: { defaults: { technical_retries: 8 } } },
      cwd,
      shellRunner: async () => {
        calls += 1;
        return shellResult(1);
      },
    });

    expect(calls).toBe(1);
    expect(finalState.status).toBe("failed");
    expect(finalState.steps.verify?.attempt).toBe(1);
  });
});

describe("loop child technical retries", () => {
  test("keeps retries inside one iteration and lets later domain evidence drive the loop", async () => {
    const workflow: Workflow = {
      name: "loop-technical-retry",
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
    const snapshots: RunState[] = [];
    let calls = 0;

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: { defaults: { technical_retries: 1 } } },
      cwd,
      shellRunner: async () => {
        calls += 1;
        snapshots.push(await loadRun(runsRoot, state.id));

        if (calls === 1) {
          throw new Error("spawn failed once");
        }

        return shellResult(calls === 2 ? 1 : 0);
      },
    });

    expect(calls).toBe(3);
    expect(snapshots[1]).toMatchObject({
      steps: {
        cycle: { status: "running", attempt: 1 },
        verify: { status: "running", attempt: 2 },
      },
    });
    expect(snapshots[2]).toMatchObject({
      steps: {
        cycle: { status: "running", attempt: 2 },
        verify: { status: "running", attempt: 3 },
      },
    });
    expect(finalState.status).toBe("completed");
    expect(finalState.steps.cycle?.attempt).toBe(2);
    expect(finalState.steps.verify?.attempt).toBe(3);
  });
});
