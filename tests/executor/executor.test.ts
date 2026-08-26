import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyApprovalDecision } from "../../src/approval";
import {
  createExecutionTemplateContext,
  executeWorkflow,
  ExecutionError,
} from "../../src/executor";
import type {
  ExecutionContextInput,
  ShellRunner,
} from "../../src/executor";
import {
  createRun,
  loadRun,
  patchStepState,
  saveRun,
} from "../../src/run";
import type { RunState, RunStatus } from "../../src/run";
import { combineShellOutput } from "../../src/shell";
import type {
  RunShellCommandParams,
  ShellCommandResult,
} from "../../src/shell";
import type { Workflow } from "../../src/workflow";

let directory: string;
let runsRoot: string;
let cwd: string;

const emptyContext: ExecutionContextInput = {
  config: {},
  artifacts: {},
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-executor-"));
  runsRoot = path.join(directory, ".aira", "runs");
  cwd = path.join(directory, "project");
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function createState(
  workflow: Workflow,
  input: Record<string, unknown> = {},
  stepIds: readonly string[] = workflow.steps.map((step) => step.id),
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

async function writeProjectScript(
  name: string,
  source: string,
): Promise<string> {
  const filePath = path.join(cwd, name);
  await writeFile(filePath, source, "utf8");
  return filePath;
}

function bunCommand(filePath: string): string {
  return `${quoteForShell(process.execPath)} ${quoteForShell(filePath)}`;
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

describe("execution context", () => {
  test("uses persisted input and caller-resolved config and artifacts", async () => {
    const workflow: Workflow = {
      name: "context-check",
      steps: [{ id: "test", uses: "shell", run: "echo test" }],
    };
    const state = await createState(workflow, {
      task: "implement auth",
    });
    state.artifacts.plan = { current: "artifacts/plan.md" };
    const context = createExecutionTemplateContext(state, {
      config: { commands: { test: "bun test" } },
      artifacts: { plan: "resolved plan content" },
    });

    expect(context.input).toBe(state.input);
    expect(context).toEqual({
      input: state.input,
      config: { commands: { test: "bun test" } },
      artifacts: { plan: "resolved plan content" },
      steps: state.steps,
      run: {
        id: state.id,
        workflow: "context-check",
        status: "running",
      },
    });
  });

  test("defaults caller artifact values to an empty record", async () => {
    const workflow: Workflow = {
      name: "context-check",
      steps: [{ id: "test", uses: "shell", run: "echo test" }],
    };
    const state = await createState(workflow);

    expect(createExecutionTemplateContext(state, { config: {} }).artifacts)
      .toEqual({});
  });
});

describe("basic sequential execution", () => {
  test("executes one shell step and persists its completed state", async () => {
    const script = await writeProjectScript(
      "success.ts",
      'process.stdout.write("workflow output");\n',
    );
    const workflow: Workflow = {
      name: "single-shell",
      steps: [{ id: "test", uses: "shell", run: bunCommand(script) }],
    };
    const state = await createState(workflow);
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      now: tickingClock(),
    });

    expect(finalState.status).toBe("completed");
    expect(finalState.current_step).toBeUndefined();
    expect(finalState.steps.test).toMatchObject({
      status: "completed",
      attempt: 1,
      started_at: "2026-08-26T11:00:00.000Z",
      completed_at: "2026-08-26T11:00:01.000Z",
      success: true,
      exit_code: 0,
    });
    expect(finalState.steps.test?.output).toContain("workflow output");
    expect(finalState.updated_at).toBe("2026-08-26T11:00:02.000Z");
    expect(await loadRun(runsRoot, state.id)).toEqual(finalState);
  });

  test("executes top-level shell steps one at a time in declared order", async () => {
    const workflow: Workflow = {
      name: "sequential",
      steps: [
        { id: "first", uses: "shell", run: "first command" },
        { id: "second", uses: "shell", run: "second command" },
        { id: "third", uses: "shell", run: "third command" },
      ],
    };
    const state = await createState(workflow);
    const calls: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const shellRunner: ShellRunner = async ({ command }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(command);
      await Bun.sleep(5);
      active -= 1;
      return makeResult(0, `${command}\n`);
    };
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      shellRunner,
    });

    expect(calls).toEqual([
      "first command",
      "second command",
      "third command",
    ]);
    expect(maximumActive).toBe(1);
    expect(finalState.status).toBe("completed");
    expect(finalState.current_step).toBeUndefined();
    expect(finalState.steps.first?.attempt).toBe(1);
    expect(finalState.steps.second?.attempt).toBe(1);
    expect(finalState.steps.third?.attempt).toBe(1);
  });

  test("persists running state before invoking the shell runner", async () => {
    const workflow: Workflow = {
      name: "running-boundary",
      steps: [{ id: "inspect", uses: "shell", run: "inspect state" }],
    };
    const state = await createState(workflow);
    let observed: RunState | undefined;
    const shellRunner: ShellRunner = async () => {
      observed = await loadRun(runsRoot, state.id);
      return makeResult(0, "done");
    };

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      shellRunner,
    });

    expect(observed?.status).toBe("running");
    expect(observed?.current_step).toBe("inspect");
    expect(observed?.steps.inspect).toMatchObject({
      status: "running",
      attempt: 1,
    });
    expect(observed?.steps.inspect?.started_at).toBeDefined();
    expect(finalState.steps.inspect?.status).toBe("completed");
    expect((await loadRun(runsRoot, state.id)).status).toBe("completed");
  });
});

describe("when conditions", () => {
  test("executes a step when its condition is true", async () => {
    const workflow: Workflow = {
      name: "condition-true",
      steps: [
        {
          id: "test",
          uses: "shell",
          run: "run tests",
          when: "input.enabled == true",
        },
      ],
    };
    const state = await createState(workflow, { enabled: true });
    const calls: string[] = [];
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      shellRunner: async ({ command }) => {
        calls.push(command);
        return makeResult();
      },
    });

    expect(calls).toEqual(["run tests"]);
    expect(finalState.steps.test).toMatchObject({
      status: "completed",
      attempt: 1,
    });
  });

  test("skips a false condition without incrementing attempt and continues", async () => {
    const workflow: Workflow = {
      name: "condition-false",
      steps: [
        {
          id: "optional",
          uses: "shell",
          run: "do optional work",
          when: "input.enabled == true",
        },
        { id: "required", uses: "shell", run: "do required work" },
      ],
    };
    const state = await createState(workflow, { enabled: false });
    const calls: string[] = [];
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      shellRunner: async ({ command }) => {
        calls.push(command);
        return makeResult();
      },
    });
    const persisted = await loadRun(runsRoot, state.id);

    expect(calls).toEqual(["do required work"]);
    expect(finalState.steps.optional).toEqual({
      status: "skipped",
      attempt: 0,
    });
    expect(finalState.steps.required?.attempt).toBe(1);
    expect(persisted.steps.optional).toEqual({
      status: "skipped",
      attempt: 0,
    });
    expect(finalState.status).toBe("completed");
  });

  test("lets a later condition reference an earlier step result", async () => {
    const workflow: Workflow = {
      name: "condition-step-result",
      steps: [
        { id: "test", uses: "shell", run: "run tests" },
        {
          id: "report",
          uses: "shell",
          run: "write report",
          when:
            "steps.test.success == true and steps.test.exit_code == 0",
        },
      ],
    };
    const state = await createState(workflow);
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

    expect(calls).toEqual(["run tests", "write report"]);
    expect(finalState.steps.report?.status).toBe("completed");
  });

  test("fails and persists an invalid condition", async () => {
    const workflow: Workflow = {
      name: "invalid-condition",
      steps: [
        {
          id: "broken",
          uses: "shell",
          run: "must not run",
          when: "input.enabled",
        },
        { id: "later", uses: "shell", run: "later" },
      ],
    };
    const state = await createState(workflow, { enabled: true });
    const calls: string[] = [];
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: { config: {} },
        cwd,
        shellRunner: async ({ command }) => {
          calls.push(command);
          return makeResult();
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain("when condition failed");
    expect(error.message).toContain("explicit comparison");
    expect(calls).toEqual([]);
    expect(persisted.status).toBe("failed");
    expect(persisted.current_step).toBe("broken");
    expect(persisted.steps.broken).toMatchObject({
      status: "failed",
      attempt: 0,
      success: false,
    });
    expect(persisted.steps.broken?.output).toContain("explicit comparison");
    expect(persisted.steps.later?.status).toBe("pending");
  });

  test("fails when a condition reference is missing", async () => {
    const workflow: Workflow = {
      name: "missing-condition-reference",
      steps: [
        {
          id: "broken",
          uses: "shell",
          run: "must not run",
          when: "steps.missing.success == true",
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
        shellRunner: async () => makeResult(),
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain(
      'condition reference "steps.missing.success" was not found',
    );
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.broken?.status).toBe("failed");
  });
});

describe("approval step boundary", () => {
  test("persists waiting state and returns before later steps execute", async () => {
    const workflow: Workflow = {
      name: "approval-boundary",
      steps: [
        { id: "shell-a", uses: "shell", run: "shell a" },
        {
          id: "approve-plan",
          uses: "approval",
          message: "Approve this implementation plan?",
        },
        { id: "shell-b", uses: "shell", run: "shell b" },
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
        return makeResult();
      },
    });
    const persisted = await loadRun(runsRoot, state.id);

    expect(calls).toEqual(["shell a"]);
    expect(waiting.status).toBe("waiting");
    expect(waiting.current_step).toBe("approve-plan");
    expect(waiting.steps["approve-plan"]).toEqual({
      status: "waiting",
      attempt: 0,
    });
    expect(waiting.steps["shell-b"]).toEqual({
      status: "pending",
      attempt: 0,
    });
    expect(waiting.updated_at).toBe("2026-08-26T11:00:02.000Z");
    expect(persisted).toEqual(waiting);
  });

  test("waits when an approval condition is true", async () => {
    const workflow: Workflow = {
      name: "approval-condition-true",
      steps: [
        {
          id: "approve",
          uses: "approval",
          when: "input.enabled == true",
        },
      ],
    };
    const state = await createState(workflow, { enabled: true });
    const waiting = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
    });

    expect(waiting.status).toBe("waiting");
    expect(waiting.current_step).toBe("approve");
    expect(waiting.steps.approve).toEqual({
      status: "waiting",
      attempt: 0,
    });
    expect(await loadRun(runsRoot, state.id)).toEqual(waiting);
  });

  test("skips a false approval condition without incrementing attempt", async () => {
    const workflow: Workflow = {
      name: "approval-condition-false",
      steps: [
        {
          id: "approve",
          uses: "approval",
          when: "input.enabled == true",
        },
        { id: "later", uses: "shell", run: "later" },
      ],
    };
    const state = await createState(workflow, { enabled: false });
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

    expect(calls).toEqual(["later"]);
    expect(finalState.steps.approve).toEqual({
      status: "skipped",
      attempt: 0,
    });
    expect(finalState.steps.later?.status).toBe("completed");
    expect(finalState.status).toBe("completed");
    expect(await loadRun(runsRoot, state.id)).toEqual(finalState);
  });

  test.each([
    ["an invalid expression", "input.enabled", "explicit comparison"],
    [
      "a missing reference",
      "steps.missing.success == true",
      'condition reference "steps.missing.success" was not found',
    ],
  ] as const)(
    "fails and persists %s in an approval condition",
    async (_label, when, expectedMessage) => {
      const workflow: Workflow = {
        name: "approval-condition-error",
        steps: [
          { id: "approve", uses: "approval", when },
          { id: "later", uses: "shell", run: "later" },
        ],
      };
      const state = await createState(workflow, { enabled: true });
      let shellCalled = false;
      const error = await expectExecutionError(() =>
        executeWorkflow({
          workflow,
          runsRoot,
          state,
          context: emptyContext,
          cwd,
          shellRunner: async () => {
            shellCalled = true;
            return makeResult();
          },
        }),
      );
      const persisted = await loadRun(runsRoot, state.id);

      expect(error.message).toContain("when condition failed");
      expect(error.message).toContain(expectedMessage);
      expect(shellCalled).toBe(false);
      expect(persisted.status).toBe("failed");
      expect(persisted.current_step).toBe("approve");
      expect(persisted.steps.approve).toMatchObject({
        status: "failed",
        attempt: 0,
        success: false,
      });
      expect(persisted.steps.later).toEqual({
        status: "pending",
        attempt: 0,
      });
    },
  );
});

describe("shell command interpolation", () => {
  test("interpolates config values without changing surrounding content", async () => {
    const workflow: Workflow = {
      name: "config-template",
      steps: [
        {
          id: "test",
          uses: "shell",
          run: "before {{ config.commands.test }} after && literal",
        },
      ],
    };
    const state = await createState(workflow);
    const calls: string[] = [];

    await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: {
        config: { commands: { test: "bun test --coverage" } },
      },
      cwd,
      shellRunner: async ({ command }) => {
        calls.push(command);
        return makeResult();
      },
    });

    expect(calls).toEqual([
      "before bun test --coverage after && literal",
    ]);
  });

  test("uses RunState.input for interpolation", async () => {
    const workflow: Workflow = {
      name: "input-template",
      steps: [
        {
          id: "report",
          uses: "shell",
          run: "task={{ input.task }}|plan={{ artifacts.plan }}",
        },
      ],
    };
    const state = await createState(workflow, { task: "add auth" });
    const calls: string[] = [];

    await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: {
        config: {},
        artifacts: { plan: "approved" },
      },
      cwd,
      shellRunner: async ({ command }) => {
        calls.push(command);
        return makeResult();
      },
    });

    expect(calls).toEqual(["task=add auth|plan=approved"]);
  });

  test("interpolates a previous step output", async () => {
    const workflow: Workflow = {
      name: "step-template",
      steps: [
        { id: "first", uses: "shell", run: "first" },
        {
          id: "second",
          uses: "shell",
          run: "consume [{{ steps.first.output }}]",
        },
      ],
    };
    const state = await createState(workflow);
    const calls: string[] = [];
    const shellRunner: ShellRunner = async ({ command }) => {
      calls.push(command);

      if (calls.length === 1) {
        return makeResult(0, "first", "", "first persisted output");
      }

      return makeResult();
    };

    await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      shellRunner,
    });

    expect(calls).toEqual([
      "first",
      "consume [first persisted output]",
    ]);
  });

  test("fails before execution when a template reference is missing", async () => {
    const workflow: Workflow = {
      name: "missing-template",
      steps: [
        {
          id: "broken",
          uses: "shell",
          run: "{{ config.commands.missing }}",
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
    expect(persisted.steps.broken).toMatchObject({
      status: "failed",
      attempt: 0,
      success: false,
    });
  });

  test("interpolates every multi-command string before running any command", async () => {
    const workflow: Workflow = {
      name: "multi-template-preflight",
      steps: [
        {
          id: "verify",
          uses: "shell",
          commands: [
            { name: "test", run: "{{ config.commands.test }}" },
            { name: "lint", run: "{{ config.commands.missing }}" },
          ],
        },
      ],
    };
    const state = await createState(workflow);
    const calls: string[] = [];

    await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: {
          config: { commands: { test: "bun test" } },
        },
        cwd,
        shellRunner: async ({ command }) => {
          calls.push(command);
          return makeResult();
        },
      }),
    );

    expect(calls).toEqual([]);
    expect((await loadRun(runsRoot, state.id)).steps.verify).toMatchObject({
      status: "failed",
      attempt: 0,
    });
  });
});

describe("shell failure semantics", () => {
  test("persists a non-zero exit and does not run subsequent steps", async () => {
    const failureScript = await writeProjectScript(
      "failure.ts",
      'process.stdout.write("partial output");\n' +
        'process.stderr.write("test failure");\n' +
        "process.exit(9);\n",
    );
    const marker = path.join(cwd, "later-ran.txt");
    const laterScript = await writeProjectScript(
      "later.ts",
      `await Bun.write(${JSON.stringify(marker)}, "ran");\n`,
    );
    const workflow: Workflow = {
      name: "command-failure",
      steps: [
        { id: "test", uses: "shell", run: bunCommand(failureScript) },
        { id: "later", uses: "shell", run: bunCommand(laterScript) },
      ],
    };
    const state = await createState(workflow);
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
    });
    const persisted = await loadRun(runsRoot, state.id);

    expect(finalState.status).toBe("failed");
    expect(finalState.current_step).toBe("test");
    expect(finalState.steps.test).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
      exit_code: 9,
    });
    expect(finalState.steps.test?.output).toContain("partial output");
    expect(finalState.steps.test?.output).toContain("test failure");
    expect(finalState.steps.later).toEqual({
      status: "pending",
      attempt: 0,
    });
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(persisted).toEqual(finalState);
  });

  test("turns a shell timeout into a persisted execution failure", async () => {
    const timeoutScript = await writeProjectScript(
      "timeout.ts",
      "await Bun.sleep(5_000);\n",
    );
    const workflow: Workflow = {
      name: "timeout-failure",
      steps: [
        { id: "slow", uses: "shell", run: bunCommand(timeoutScript) },
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
        shellTimeout: 0.05,
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain("timed out after 0.05 seconds");
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.slow).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
      exit_code: 124,
    });
    expect(persisted.steps.slow?.output).toContain("timed out");
  });

  test("persists an invalid cwd as a shell runtime failure", async () => {
    const workflow: Workflow = {
      name: "invalid-cwd",
      steps: [
        { id: "test", uses: "shell", run: `${process.execPath} --version` },
      ],
    };
    const state = await createState(workflow);
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd: path.join(directory, "missing-cwd"),
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain("shell execution failed");
    expect(error.message).toContain("could not start shell command");
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.test).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
    });
    expect(persisted.steps.test?.output).toContain(
      "could not start shell command",
    );
  });
});

describe("multi-command shell steps", () => {
  test.each([
    ["all commands succeed", [0, 0, 0], "completed", 0],
    ["the first command fails", [2, 0, 0], "failed", 2],
    ["a later command fails", [0, 4, 0], "failed", 4],
    ["multiple commands fail", [3, 5, 0], "failed", 3],
  ] as const)(
    "%s",
    async (_label, exitCodes, expectedStatus, expectedExitCode) => {
      const workflow: Workflow = {
        name: "multi-command",
        steps: [
          {
            id: "verify",
            uses: "shell",
            commands: [
              { name: "test", run: "test command" },
              { name: "lint", run: "lint command" },
              { name: "typecheck", run: "typecheck command" },
            ],
          },
        ],
      };
      const state = await createState(workflow);
      const calls: string[] = [];
      const shellRunner: ShellRunner = async ({ command }) => {
        const index = calls.length;
        calls.push(command);
        const exitCode = exitCodes[index] ?? 0;
        return makeResult(
          exitCode,
          `stdout ${index}`,
          exitCode === 0 ? "" : `stderr ${index}`,
        );
      };
      const finalState = await executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        shellRunner,
      });
      const verify = finalState.steps.verify;

      expect(calls).toEqual([
        "test command",
        "lint command",
        "typecheck command",
      ]);
      expect(verify?.status).toBe(expectedStatus);
      expect(verify?.success).toBe(expectedStatus === "completed");
      expect(verify?.exit_code).toBe(expectedExitCode);
      expect(finalState.status).toBe(expectedStatus);
      expect(verify?.output).toContain("== test ==\nexit_code:");
      expect(verify?.output).toContain("== lint ==\nexit_code:");
      expect(verify?.output).toContain("== typecheck ==\nexit_code:");
      expect(await loadRun(runsRoot, state.id)).toEqual(finalState);
    },
  );

  test("stops the workflow only after every command in a failed step runs", async () => {
    const workflow: Workflow = {
      name: "multi-stop",
      steps: [
        {
          id: "verify",
          uses: "shell",
          commands: [
            { name: "test", run: "test command" },
            { name: "lint", run: "lint command" },
          ],
        },
        { id: "after", uses: "shell", run: "after command" },
      ],
    };
    const state = await createState(workflow);
    const calls: string[] = [];
    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      shellRunner: async ({ command }) => {
        calls.push(command);
        return command === "test command"
          ? makeResult(6, "", "tests failed")
          : makeResult();
      },
    });

    expect(calls).toEqual(["test command", "lint command"]);
    expect(finalState.status).toBe("failed");
    expect(finalState.steps.verify?.exit_code).toBe(6);
    expect(finalState.steps.after).toEqual({
      status: "pending",
      attempt: 0,
    });
  });

  test("interpolates each command independently before sequential execution", async () => {
    const workflow: Workflow = {
      name: "multi-interpolation",
      steps: [
        {
          id: "verify",
          uses: "shell",
          commands: [
            { name: "test", run: "{{ config.commands.test }}" },
            { name: "lint", run: "lint {{ input.target }}" },
          ],
        },
      ],
    };
    const state = await createState(workflow, { target: "src" });
    const calls: string[] = [];

    await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: {
        config: { commands: { test: "bun test" } },
      },
      cwd,
      shellRunner: async ({ command }) => {
        calls.push(command);
        return makeResult();
      },
    });

    expect(calls).toEqual(["bun test", "lint src"]);
  });

  test("continues remaining commands after a command runtime error", async () => {
    const workflow: Workflow = {
      name: "multi-runtime-error",
      steps: [
        {
          id: "verify",
          uses: "shell",
          commands: [
            { name: "test", run: "test command" },
            { name: "lint", run: "lint command" },
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

          if (command === "test command") {
            throw new Error("test process could not start");
          }

          return makeResult();
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(calls).toEqual(["test command", "lint command"]);
    expect(error.message).toContain('command "test" shell execution failed');
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.verify?.exit_code).toBe(1);
    expect(persisted.steps.verify?.output).toContain("== test ==");
    expect(persisted.steps.verify?.output).toContain("== lint ==");
    expect(persisted.steps.verify?.output).toContain(
      "test process could not start",
    );
  });
});

describe("timeout precedence", () => {
  test.each([
    ["internal default", undefined, undefined, 300],
    ["caller default", undefined, 25, 25],
    ["step timeout", 5, 25, 5],
  ] as const)(
    "uses the %s",
    async (_label, stepTimeout, shellTimeout, expectedTimeout) => {
      const workflow: Workflow = {
        name: "timeout-precedence",
        steps: [
          {
            id: "test",
            uses: "shell",
            run: "test command",
            ...(stepTimeout === undefined ? {} : { timeout: stepTimeout }),
          },
        ],
      };
      const state = await createState(workflow);
      const calls: RunShellCommandParams[] = [];

      await executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        shellTimeout,
        shellRunner: async (params) => {
          calls.push(params);
          return makeResult();
        },
      });

      expect(calls[0]?.timeout).toBe(expectedTimeout);
    },
  );
});

describe("approval continuation", () => {
  test("continues after approval without rerunning completed steps", async () => {
    const workflow: Workflow = {
      name: "approval-continue",
      steps: [
        { id: "shell-a", uses: "shell", run: "shell a" },
        { id: "approve", uses: "approval" },
        { id: "shell-b", uses: "shell", run: "shell b" },
      ],
    };
    const state = await createState(workflow);
    const calls: string[] = [];
    const shellRunner: ShellRunner = async ({ command }) => {
      calls.push(command);
      return makeResult();
    };
    const waiting = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      shellRunner,
    });
    const approved = await applyApprovalDecision({
      workflow,
      runsRoot,
      state: waiting,
      stepId: "approve",
      decision: "approve",
      now: () => new Date("2026-08-26T11:30:00.000Z"),
    });

    expect(calls).toEqual(["shell a"]);
    expect(approved.status).toBe("running");
    expect(approved.steps["shell-b"]?.status).toBe("pending");

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state: approved,
      context: emptyContext,
      cwd,
      mode: "continue",
      shellRunner,
      now: tickingClock("2026-08-26T12:00:00.000Z"),
    });

    expect(calls).toEqual(["shell a", "shell b"]);
    expect(finalState.status).toBe("completed");
    expect(finalState.current_step).toBeUndefined();
    expect(finalState.steps["shell-a"]?.attempt).toBe(1);
    expect(finalState.steps.approve).toMatchObject({
      status: "completed",
      attempt: 0,
      result: "approved",
    });
    expect(finalState.steps["shell-b"]).toMatchObject({
      status: "completed",
      attempt: 1,
    });
    expect(await loadRun(runsRoot, state.id)).toEqual(finalState);
  });

  test("fresh mode rejects a partially completed approved run", async () => {
    const workflow: Workflow = {
      name: "approval-fresh-strict",
      steps: [
        { id: "shell-a", uses: "shell", run: "shell a" },
        { id: "approve", uses: "approval" },
        { id: "shell-b", uses: "shell", run: "shell b" },
      ],
    };
    const state = await createState(workflow);
    const calls: string[] = [];
    const shellRunner: ShellRunner = async ({ command }) => {
      calls.push(command);
      return makeResult();
    };
    const waiting = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: emptyContext,
      cwd,
      shellRunner,
    });
    const approved = await applyApprovalDecision({
      workflow,
      runsRoot,
      state: waiting,
      stepId: "approve",
      decision: "approve",
    });
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state: approved,
        context: emptyContext,
        cwd,
        shellRunner,
      }),
    );

    expect(error.message).toContain('step "shell-a" must have status "pending"');
    expect(error.message).toContain('found "completed"');
    expect(calls).toEqual(["shell a"]);
    expect((await loadRun(runsRoot, state.id)).status).toBe("failed");
  });

  test("a revised run reaches the pending agent without incrementing setup attempts", async () => {
    const workflow: Workflow = {
      name: "approval-revise-continue",
      steps: [
        { id: "plan", uses: "agent", command: "plan" },
        { id: "approve", uses: "approval", revise: "plan" },
      ],
    };
    let state = await createState(workflow);
    state = patchStepState(state, "plan", {
      status: "completed",
      attempt: 2,
      started_at: "2026-08-26T10:56:00.000Z",
      completed_at: "2026-08-26T10:57:00.000Z",
      success: true,
      output: "old plan",
    });
    state = patchStepState(state, "approve", { status: "waiting" });
    state = {
      ...state,
      status: "waiting",
      current_step: "approve",
    };
    await saveRun(runsRoot, state);

    const revised = await applyApprovalDecision({
      workflow,
      runsRoot,
      state,
      stepId: "approve",
      decision: "revise",
    });
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state: revised,
        context: emptyContext,
        cwd,
        mode: "continue",
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain('agent step "plan" requires an AgentRuntime');
    expect(persisted.status).toBe("failed");
    expect(persisted.current_step).toBe("plan");
    expect(persisted.steps.plan).toMatchObject({
      status: "failed",
      attempt: 2,
    });
    expect(persisted.steps.approve).toEqual({
      status: "pending",
      attempt: 0,
    });
  });
});

describe("invalid execution state and agent dependencies", () => {
  const nonRunningStatuses: Exclude<RunStatus, "running">[] = [
    "waiting",
    "interrupted",
    "failed",
    "completed",
    "cancelled",
  ];

  test.each(nonRunningStatuses)(
    "rejects a run with status %p",
    async (status) => {
      const workflow: Workflow = {
        name: "wrong-run-status",
        steps: [{ id: "test", uses: "shell", run: "test" }],
      };
      const created = await createState(workflow);
      const state: RunState = { ...created, status };
      const error = await expectExecutionError(() =>
        executeWorkflow({
          workflow,
          runsRoot,
          state,
          context: emptyContext,
          cwd,
          shellRunner: async () => makeResult(),
        }),
      );

      expect(error.message).toContain('must have status "running"');
      expect(error.message).toContain(`found "${status}"`);
    },
  );

  test("rejects a workflow identity mismatch without changing run state", async () => {
    const createdWorkflow: Workflow = {
      name: "feature",
      steps: [{ id: "test", uses: "shell", run: "test" }],
    };
    const receivedWorkflow: Workflow = {
      ...createdWorkflow,
      name: "bugfix",
    };
    const state = await createState(createdWorkflow);
    const originalPersistedState = await loadRun(runsRoot, state.id);
    let shellCalled = false;
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow: receivedWorkflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        shellRunner: async () => {
          shellCalled = true;
          return makeResult();
        },
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toBe(
      `run "${state.id}" was created for workflow "feature" but ` +
        'executor received "bugfix"',
    );
    expect(shellCalled).toBe(false);
    expect(state.workflow).toBe("feature");
    expect(state.status).toBe("running");
    expect(persisted).toEqual(originalPersistedState);
  });

  test("fails when a workflow step is missing from run state", async () => {
    const workflow: Workflow = {
      name: "missing-step-state",
      steps: [{ id: "test", uses: "shell", run: "test" }],
    };
    const state = await createState(workflow, {}, []);
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        shellRunner: async () => makeResult(),
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain('step "test" is missing from run state');
    expect(persisted.status).toBe("failed");
    expect(persisted.current_step).toBe("test");
  });

  test("rejects and persists a step whose state is not pending", async () => {
    const workflow: Workflow = {
      name: "wrong-step-status",
      steps: [{ id: "test", uses: "shell", run: "test" }],
    };
    let state = await createState(workflow);
    state = patchStepState(state, "test", {
      status: "running",
      attempt: 1,
      started_at: "2026-08-26T10:56:00.000Z",
    });
    await saveRun(runsRoot, state, new Date("2026-08-26T10:56:00.000Z"));
    const error = await expectExecutionError(() =>
      executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: emptyContext,
        cwd,
        shellRunner: async () => makeResult(),
      }),
    );
    const persisted = await loadRun(runsRoot, state.id);

    expect(error.message).toContain('must have status "pending"');
    expect(error.message).toContain('found "running"');
    expect(persisted.status).toBe("failed");
    expect(persisted.steps.test).toMatchObject({
      status: "failed",
      attempt: 1,
      success: false,
    });
  });

  const agentWorkflows: Array<[string, Workflow]> = [
    [
      "agent",
      {
        name: "agent-dependencies",
        steps: [{ id: "plan", uses: "agent", command: "plan" }],
      },
    ],
  ];

  test.each(agentWorkflows)(
    "fails clearly when an %s step has no runtime dependency",
    async (_type, workflow) => {
      const state = await createState(workflow);
      const error = await expectExecutionError(() =>
        executeWorkflow({
          workflow,
          runsRoot,
          state,
          context: emptyContext,
          cwd,
          shellRunner: async () => makeResult(),
        }),
      );
      const stepId = workflow.steps[0]?.id;

      if (stepId === undefined) {
        throw new Error("expected an agent step");
      }

      const persisted = await loadRun(runsRoot, state.id);
      expect(error.message).toContain(
        `agent step "${stepId}" requires an AgentRuntime`,
      );
      expect(persisted.status).toBe("failed");
      expect(persisted.current_step).toBe(stepId);
      expect(persisted.steps[stepId]).toMatchObject({
        status: "failed",
        attempt: 0,
        success: false,
      });
    },
  );
});
