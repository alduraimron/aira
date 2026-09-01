import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  AgentCompletion,
  AgentRuntime,
  AgentStepRequest,
  AgentStepResult,
} from "../../src/agent";
import { applyApprovalDecision } from "../../src/approval";
import { writeArtifact } from "../../src/artifacts";
import {
  executeWorkflow,
  ExecutionError,
  type ShellRunner,
} from "../../src/executor";
import {
  createRun,
  getRunPaths,
  loadRun,
  saveRun,
  type RunState,
} from "../../src/run";
import type { ShellCommandResult } from "../../src/shell";
import type { Workflow } from "../../src/workflow";

let directory: string;
let runsRoot: string;
let cwd: string;
let commandsDir: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-agent-executor-"));
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

async function createState(workflow: Workflow): Promise<RunState> {
  return createRun({
    runsRoot,
    workflow: workflow.name,
    input: { task: "implement auth" },
    stepIds: workflow.steps.flatMap((step) =>
      step.uses === "loop"
        ? [step.id, ...step.steps.map((child) => child.id)]
        : [step.id],
    ),
    now: new Date("2026-08-26T10:55:01.000Z"),
  });
}

async function writeCommand(name: string, source: string): Promise<void> {
  await writeFile(path.join(commandsDir, `${name}.md`), source, "utf8");
}

function completedResult(
  completion: AgentCompletion,
  overrides: Partial<AgentStepResult> = {},
): AgentStepResult {
  return {
    success: true,
    sessionId: "session-1",
    finalText: "Provider final response.",
    timedOut: false,
    completion,
    ...overrides,
  };
}

function noArtifactCompletion(summary = "Work completed."): AgentCompletion {
  return { status: "completed", summary, artifacts: [] };
}

function shellResult(exitCode = 0): ShellCommandResult {
  return {
    exitCode,
    stdout: "",
    stderr: "",
    output: "",
    success: exitCode === 0,
  };
}

function tickingClock(
  start = "2026-08-26T11:00:00.000Z",
): () => Date {
  let offset = 0;
  const startTime = Date.parse(start);

  return () => new Date(startTime + offset++ * 1_000);
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

describe("top-level agent execution", () => {
  test("loads and interpolates a command, persists completion, and continues", async () => {
    await writeCommand(
      "plan",
      `---
model: coding
thinking: high
timeout: 45
tools:
  - read
  - grep
  - find
  - ls
  - edit
  - write
  - bash
---
Implement {{ input.task }} with {{ config.commands.test }}.`,
    );
    const workflow: Workflow = {
      name: "agent-then-shell",
      steps: [
        {
          id: "plan",
          uses: "agent",
          command: "plan",
          artifact: {
            name: "plan",
            filename: "plan.md",
          },
        },
        {
          id: "consume",
          uses: "shell",
          run: "consume={{ artifacts.plan }}",
        },
      ],
    };
    const state = await createState(workflow);
    const artifactContent = "# Plan\n\nExact content with trailing newline.\n";
    const requests: AgentStepRequest[] = [];
    let runningState: RunState | undefined;
    const agentRuntime: AgentRuntime = {
      async runStep(request) {
        requests.push(request);
        runningState = await loadRun(runsRoot, state.id);
        return completedResult({
          status: "completed",
          summary: "  Planned the implementation.  ",
          artifacts: [{ name: "plan", content: artifactContent }],
        });
      },
    };
    const shellCalls: string[] = [];
    const shellRunner: ShellRunner = async ({ command }) => {
      shellCalls.push(command);
      return shellResult();
    };

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: {
        config: {
          models: { coding: "test-provider/coding-model" },
          commands: { test: "bun test" },
        },
        artifacts: { plan: "stale caller plan" },
      },
      cwd,
      commandsDir,
      agentRuntime,
      shellRunner,
      now: tickingClock(),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      stepId: "plan",
      cwd,
      model: "test-provider/coding-model",
      thinking: "high",
      timeoutSeconds: 45,
      tools: [
        "read",
        "grep",
        "find",
        "ls",
        "edit",
        "write",
        "bash",
        "complete_step",
      ],
      completion: { expectedArtifacts: ["plan"] },
    });
    expect(requests[0]?.prompt).toBe(
      "Implement implement auth with bun test.\n\n" +
        "[Aira completion protocol]\n\n" +
        "When the requested work is complete, call `complete_step` exactly once.\n" +
        "Do not claim completion only in your final text.\n" +
        'Return artifact "plan" through complete_step.artifacts.',
    );
    expect(requests[0]?.sessionLogPath).toBe(
      path.join(getRunPaths(runsRoot, state.id).sessionsDir, "plan-1.jsonl"),
    );
    expect(requests[0]?.onEvent).toBeUndefined();
    expect(path.isAbsolute(requests[0]?.sessionLogPath ?? "")).toBe(true);
    expect(runningState).toMatchObject({
      status: "running",
      current_step: "plan",
      steps: {
        plan: {
          status: "running",
          attempt: 1,
          started_at: "2026-08-26T11:00:00.000Z",
        },
      },
    });
    expect(shellCalls).toEqual([`consume=${artifactContent}`]);
    expect(finalState.status).toBe("completed");
    expect(finalState.current_step).toBeUndefined();
    expect(finalState.steps.plan).toMatchObject({
      status: "completed",
      attempt: 1,
      success: true,
      summary: "  Planned the implementation.  ",
      artifact: "artifacts/plan.md",
      output: "Provider final response.",
    });
    expect(finalState.steps.consume?.status).toBe("completed");
    expect(finalState.artifacts.plan).toEqual({
      current: "artifacts/plan.md",
    });
    expect(
      await readFile(
        path.join(getRunPaths(runsRoot, state.id).artifactsDir, "plan.md"),
        "utf8",
      ),
    ).toBe(artifactContent);
    expect(await loadRun(runsRoot, state.id)).toEqual(finalState);
  });

  test("loads the current persisted artifact and lets it override caller context", async () => {
    await writeCommand("inspect", "Current plan:\n{{ artifacts.plan }}");
    const workflow: Workflow = {
      name: "persisted-context",
      steps: [{ id: "inspect", uses: "agent", command: "inspect" }],
    };
    let state = await createState(workflow);
    state = (
      await writeArtifact({
        runsRoot,
        state,
        name: "plan",
        filename: "plan.md",
        versioned: true,
        content: "plan v1",
      })
    ).state;
    state = (
      await writeArtifact({
        runsRoot,
        state,
        name: "plan",
        filename: "plan.md",
        versioned: true,
        content: "plan v2 latest",
      })
    ).state;
    let prompt = "";
    const agentRuntime: AgentRuntime = {
      async runStep(request) {
        prompt = request.prompt;
        return completedResult(noArtifactCompletion());
      },
    };

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: {
        config: {},
        artifacts: { plan: "stale caller value" },
      },
      cwd,
      commandsDir,
      agentRuntime,
    });

    expect(prompt).toStartWith("Current plan:\nplan v2 latest");
    expect(prompt).not.toContain("stale caller value");
    expect(finalState.artifacts.plan?.current).toBe("artifacts/plan-v2.md");
  });
});

describe("agent setup failures", () => {
  test.each([
    ["missing", undefined, "could not read command file"],
    [
      "malformed",
      "---\ntools: [read\n---\nBroken prompt",
      "YAML syntax error",
    ],
  ] as const)(
    "fails a %s command before starting an attempt",
    async (commandName, source, expectedMessage) => {
      if (source !== undefined) {
        await writeCommand(commandName, source);
      }

      const workflow: Workflow = {
        name: `${commandName}-command`,
        steps: [
          {
            id: "agent",
            uses: "agent",
            command: commandName,
            retry: 5,
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
          context: { config: {} },
          cwd,
          commandsDir,
          agentRuntime: {
            async runStep() {
              calls += 1;
              return completedResult(noArtifactCompletion());
            },
          },
        }),
      );
      const persisted = await loadRun(runsRoot, state.id);

      expect(error.message).toContain(expectedMessage);
      expect(calls).toBe(0);
      expect(persisted.status).toBe("failed");
      expect(persisted.steps.agent).toMatchObject({
        status: "failed",
        attempt: 0,
        success: false,
      });
    },
  );

  test("fails an unknown model alias before AgentRuntime is called", async () => {
    await writeCommand("plan", "Plan.");
    const workflow: Workflow = {
      name: "unknown-model",
      steps: [
        {
          id: "plan",
          uses: "agent",
          command: "plan",
          model: "missing",
          retry: 5,
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
        context: { config: { models: { known: "provider/model" } } },
        cwd,
        commandsDir,
        agentRuntime: {
          async runStep() {
            calls += 1;
            return completedResult(noArtifactCompletion());
          },
        },
      }),
    );

    expect(error.message).toContain('unknown model alias "missing"');
    expect(calls).toBe(0);
    expect((await loadRun(runsRoot, state.id)).steps.plan?.attempt).toBe(0);
  });

  test("fails when a persisted artifact cannot be read", async () => {
    await writeCommand("inspect", "{{ artifacts.plan }}");
    const workflow: Workflow = {
      name: "missing-persisted-artifact",
      steps: [{ id: "inspect", uses: "agent", command: "inspect" }],
    };
    let state = await createState(workflow);
    state = {
      ...state,
      artifacts: { plan: { current: "artifacts/missing.md" } },
    };
    await saveRun(runsRoot, state);
    let calls = 0;

    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: {
          config: {},
          artifacts: { plan: "stale fallback must not be used" },
        },
        cwd,
        commandsDir,
        agentRuntime: {
          async runStep() {
            calls += 1;
            return completedResult(noArtifactCompletion());
          },
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain("could not load persisted artifact context");
    expect(error.message).toContain("Could not read artifact");
    expect(calls).toBe(0);
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.inspect?.attempt).toBe(0);
  });

  test("shell-only workflows need no agent dependencies", async () => {
    const workflow: Workflow = {
      name: "shell-only",
      steps: [{ id: "test", uses: "shell", run: "test" }],
    };
    const state = await createState(workflow);

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      shellRunner: async () => shellResult(),
    });

    expect(finalState.status).toBe("completed");
  });
});

describe("agent failure semantics", () => {
  test.each([
    [
      "runtime failure",
      async (): Promise<AgentStepResult> => ({
        success: false,
        sessionId: "runtime-failure",
        finalText: "partial work",
        timedOut: false,
        error: "provider unavailable",
      }),
      "runtime failed",
      6,
    ],
    [
      "timeout",
      async (): Promise<AgentStepResult> => ({
        success: false,
        sessionId: "timeout",
        finalText: "partial work",
        timedOut: true,
        error: "Pi session timed out after 4 seconds",
      }),
      "timed out",
      6,
    ],
    [
      "throw",
      async (): Promise<AgentStepResult> => {
        throw new Error("session creation broke");
      },
      "runtime threw",
      6,
    ],
    [
      "missing completion despite DONE final text",
      async (): Promise<AgentStepResult> => ({
        success: true,
        sessionId: "missing-completion",
        finalText: "DONE. Everything is complete.",
        timedOut: false,
      }),
      "completed without calling complete_step",
      1,
    ],
    [
      "completion error",
      async (): Promise<AgentStepResult> => ({
        success: true,
        sessionId: "completion-error",
        finalText: "Done",
        timedOut: false,
        completion: noArtifactCompletion(),
        completionError: "complete_step called twice",
      }),
      "completion protocol failed",
      1,
    ],
    [
      "executor-invalid completion",
      async (): Promise<AgentStepResult> => ({
        success: true,
        sessionId: "invalid-completion",
        finalText: "Done",
        timedOut: false,
        completion: {
          status: "completed",
          summary: "   ",
          artifacts: [],
        },
      }),
      "summary must contain non-whitespace text",
      1,
    ],
  ] as const)("persists %s with the correct retry policy", async (
    _name,
    handler,
    expected,
    expectedCalls,
  ) => {
    await writeCommand("work", "Do the work.");
    const workflow: Workflow = {
      name: `failure-${_name.replaceAll(" ", "-")}`,
      steps: [
        { id: "work", uses: "agent", command: "work", retry: 5 },
        { id: "after", uses: "shell", run: "after" },
      ],
    };
    const state = await createState(workflow);
    let calls = 0;
    let shellCalls = 0;
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: { config: { defaults: { technical_retries: 9 } } },
        cwd,
        commandsDir,
        agentRuntime: {
          async runStep() {
            calls += 1;
            return handler();
          },
        },
        shellRunner: async () => {
          shellCalls += 1;
          return shellResult();
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain(expected);
    expect(calls).toBe(expectedCalls);
    expect(shellCalls).toBe(0);
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.work).toMatchObject({
      status: "failed",
      attempt: expectedCalls,
      success: false,
    });
    expect(persisted.steps.work?.summary).toBeUndefined();
    expect(persisted.steps.after).toEqual({ status: "pending", attempt: 0 });

    if (_name === "missing completion despite DONE final text") {
      expect(persisted.steps.work?.output).toContain(
        "DONE. Everything is complete.",
      );
      expect(persisted.steps.work?.summary).toBeUndefined();
    }
  });

  test("fails when artifact persistence rejects the workflow filename", async () => {
    await writeCommand("plan", "Plan.");
    const workflow: Workflow = {
      name: "artifact-write-failure",
      steps: [
        {
          id: "plan",
          uses: "agent",
          command: "plan",
          retry: 5,
          artifact: {
            name: "plan",
            filename: "../outside.md",
          },
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
        context: { config: {} },
        cwd,
        commandsDir,
        agentRuntime: {
          async runStep() {
            calls += 1;
            return completedResult({
              status: "completed",
              summary: "Plan ready",
              artifacts: [{ name: "plan", content: "content" }],
            });
          },
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain("could not persist artifact");
    expect(calls).toBe(1);
    expect(error.message).toContain("Invalid artifact filename");
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.plan).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
    });
    expect(persisted.artifacts.plan).toBeUndefined();
  });

  test("defends against an invalid artifact set from another AgentRuntime", async () => {
    await writeCommand("plan", "Plan.");
    const workflow: Workflow = {
      name: "invalid-runtime-artifact",
      steps: [
        {
          id: "plan",
          uses: "agent",
          command: "plan",
          retry: 5,
          artifact: { name: "plan", filename: "plan.md" },
        },
      ],
    };
    const state = await createState(workflow);
    const invalidCompletion = {
      status: "completed",
      summary: "Done",
      artifacts: [{ name: "other", content: "wrong" }],
    } as AgentCompletion;

    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: { config: {} },
        cwd,
        commandsDir,
        agentRuntime: {
          async runStep() {
            return completedResult(invalidCompletion);
          },
        },
      }),
    );

    expect(error.message).toContain('missing expected completion artifact "plan"');
    expect((await loadRun(runsRoot, state.id)).status).toBe("failed");
  });
});

describe("versioned agent artifacts and continuation", () => {
  test("revision continuation writes v1 then v2 with the existing artifact manager", async () => {
    await writeCommand("plan", "Create the plan.");
    const workflow: Workflow = {
      name: "versioned-revision",
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
    let calls = 0;
    const sessionLogPaths: string[] = [];
    const agentRuntime: AgentRuntime = {
      async runStep(request) {
        calls += 1;
        sessionLogPaths.push(request.sessionLogPath ?? "");
        return completedResult({
          status: "completed",
          summary: `Plan version ${calls}`,
          artifacts: [{ name: "plan", content: `plan content v${calls}` }],
        });
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
    const revised = await applyApprovalDecision({
      workflow,
      runsRoot,
      state: firstWaiting,
      stepId: "approve",
      decision: "revise",
    });
    const secondWaiting = await executeWorkflow({
      workflow,
      runsRoot,
      state: revised,
      context: { config: {}, artifacts: { plan: "stale" } },
      cwd,
      commandsDir,
      agentRuntime,
      mode: "continue",
    });
    const approved = await applyApprovalDecision({
      workflow,
      runsRoot,
      state: secondWaiting,
      stepId: "approve",
      decision: "approve",
    });
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state: approved,
      context: { config: {} },
      cwd,
      commandsDir,
      agentRuntime,
      mode: "continue",
    });
    const artifactsDir = getRunPaths(runsRoot, state.id).artifactsDir;

    expect(calls).toBe(2);
    expect(sessionLogPaths).toEqual([
      path.join(getRunPaths(runsRoot, state.id).sessionsDir, "plan-1.jsonl"),
      path.join(getRunPaths(runsRoot, state.id).sessionsDir, "plan-2.jsonl"),
    ]);
    expect(finalState.status).toBe("completed");
    expect(finalState.steps.plan).toMatchObject({
      status: "completed",
      attempt: 2,
      summary: "Plan version 2",
      artifact: "artifacts/plan-v2.md",
    });
    expect(finalState.artifacts.plan).toEqual({
      current: "artifacts/plan-v2.md",
      versions: ["artifacts/plan-v1.md", "artifacts/plan-v2.md"],
    });
    expect(await readFile(path.join(artifactsDir, "plan-v1.md"), "utf8"))
      .toBe("plan content v1");
    expect(await readFile(path.join(artifactsDir, "plan-v2.md"), "utf8"))
      .toBe("plan content v2");
  });
});
