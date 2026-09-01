import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentRuntime } from "../../src/agent";
import {
  executeWorkflow,
  type AiraExecutionEvent,
  type ShellRunner,
} from "../../src/executor";
import { createRun, type RunState } from "../../src/run";
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
  directory = await mkdtemp(path.join(tmpdir(), "aira-observability-"));
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

async function createState(
  workflow: Workflow,
  input: Record<string, unknown> = {},
): Promise<RunState> {
  return await createRun({
    runsRoot,
    workflow: workflow.name,
    input,
    stepIds: flattenStepIds(workflow.steps),
  });
}

function flattenStepIds(steps: readonly WorkflowStep[]): string[] {
  return steps.flatMap((step) =>
    step.uses === "loop"
      ? [step.id, ...flattenStepIds(step.steps)]
      : [step.id],
  );
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

function tickingClock(): () => Date {
  let offset = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, offset++));
}

describe("workflow observability", () => {
  test("emits shell step lifecycle in execution order", async () => {
    const workflow: Workflow = {
      name: "shell-events",
      steps: [{ id: "verify", uses: "shell", run: "bun test" }],
    };
    const state = await createState(workflow);
    const events: AiraExecutionEvent[] = [];

    const finalState = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      shellRunner: async () => shellResult(),
      now: tickingClock(),
      onEvent: (event) => events.push(event),
    });

    expect(finalState.status).toBe("completed");
    expect(events.map((event) => event.type)).toEqual([
      "step.started",
      "shell.started",
      "shell.completed",
      "step.completed",
    ]);
    expect(events[0]).toMatchObject({
      type: "step.started",
      stepId: "verify",
      stepType: "shell",
      attempt: 1,
    });
    expect(events[1]).toMatchObject({
      type: "shell.started",
      command: "bun test",
    });
    expect(events[2]).toMatchObject({
      type: "shell.completed",
      success: true,
      exitCode: 0,
    });
    expect(events[3]).toMatchObject({
      type: "step.completed",
      success: true,
      durationMs: 1_000,
    });
  });

  test("redacts and bounds interpolated shell commands before emitting them", async () => {
    const secrets = {
      token: "token-value-123456",
      password: "password-value-123456",
      apiKey: "api-key-value-123456",
      clientSecret: "client-secret-value-123456",
      flag: "flag-value-123456",
      bearer: "bearer-value-123456",
      openai: "sk-observability123456",
      github: "ghp_observability123456",
    };
    const workflow: Workflow = {
      name: "safe-shell-events",
      steps: [
        {
          id: "deploy",
          uses: "shell",
          run:
            "TOKEN={{ input.token }} PASSWORD={{ input.password }} " +
            "API_KEY={{ input.apiKey }} " +
            "CLIENT_SECRET={{ input.clientSecret }} ./deploy.sh " +
            "--password {{ input.flag }} " +
            '-H "Authorization: Bearer {{ input.bearer }}" ' +
            "echo {{ input.openai }} {{ input.github }}\n" +
            "\u001b[31m" +
            "x".repeat(2_000),
        },
      ],
    };
    const state = await createState(workflow, secrets);
    const events: AiraExecutionEvent[] = [];
    let executedCommand = "";

    await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      shellRunner: async ({ command }) => {
        executedCommand = command;
        return shellResult();
      },
      onEvent: (event) => events.push(event),
    });

    const shellStarted = events.find(
      (
        event,
      ): event is Extract<AiraExecutionEvent, { type: "shell.started" }> =>
        event.type === "shell.started",
    );
    const serializedEvents = JSON.stringify(events);

    expect(shellStarted?.command).toStartWith(
      "TOKEN=[redacted] PASSWORD=[redacted] API_KEY=[redacted] " +
        "CLIENT_SECRET=[redacted] ./deploy.sh",
    );
    expect(shellStarted?.command).toContain("Bearer [redacted]");
    expect(shellStarted?.command.match(/\[redacted\]/g) ?? []).toHaveLength(
      Object.keys(secrets).length,
    );
    expect(shellStarted?.command.length).toBeLessThanOrEqual(220);
    expect(shellStarted?.command).toEndWith("…");
    expect(shellStarted?.command).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f]/,
    );

    for (const secret of Object.values(secrets)) {
      expect(executedCommand).toContain(secret);
      expect(serializedEvents).not.toContain(secret);
    }
  });

  test.each([
    [
      "--client-secret very-private-value",
      "very-private-value",
      "--client-secret [redacted]",
    ],
    [
      "--github-token arbitrary-private-value",
      "arbitrary-private-value",
      "--github-token [redacted]",
    ],
    [
      "--auth-token arbitrary-private-value",
      "arbitrary-private-value",
      "--auth-token [redacted]",
    ],
    [
      "--database-password database-private-value",
      "database-private-value",
      "--database-password [redacted]",
    ],
    [
      "--openai-api-key arbitrary-private-value",
      "arbitrary-private-value",
      "--openai-api-key [redacted]",
    ],
    [
      "--service-access-token arbitrary-private-value",
      "arbitrary-private-value",
      "--service-access-token [redacted]",
    ],
    ["--password private-value", "private-value", "--password [redacted]"],
    ["--password=private-value", "private-value", "--password=[redacted]"],
    ["--api-key private-value", "private-value", "--api-key [redacted]"],
    ["--api_key=private-value", "private-value", "--api_key=[redacted]"],
  ] as const)(
    "redacts sensitive shell argument %s before emitting it",
    async (argument, secret, safeArgument) => {
      const command = `./deploy ${argument}`;
      const workflow: Workflow = {
        name: "sensitive-shell-flag-events",
        steps: [{ id: "deploy", uses: "shell", run: command }],
      };
      const state = await createState(workflow);
      const events: AiraExecutionEvent[] = [];
      let executedCommand = "";

      await executeWorkflow({
        workflow,
        runsRoot,
        state,
        context: { config: {} },
        cwd,
        shellRunner: async ({ command: actualCommand }) => {
          executedCommand = actualCommand;
          return shellResult();
        },
        onEvent: (event) => events.push(event),
      });

      const shellStarted = events.find(
        (
          event,
        ): event is Extract<AiraExecutionEvent, { type: "shell.started" }> =>
          event.type === "shell.started",
      );

      expect(executedCommand).toBe(command);
      expect(shellStarted?.command).toBe(`./deploy ${safeArgument}`);
      expect(JSON.stringify(events)).not.toContain(secret);
    },
  );

  test("emits step.retry for an Aira technical shell retry", async () => {
    const workflow: Workflow = {
      name: "shell-retry-events",
      steps: [{ id: "verify", uses: "shell", run: "bun test" }],
    };
    const state = await createState(workflow);
    const events: AiraExecutionEvent[] = [];
    let calls = 0;
    const shellRunner: ShellRunner = async () => {
      calls += 1;

      if (calls === 1) {
        throw new ShellCommandError("temporary spawn failure", {
          kind: "spawn",
        });
      }

      return shellResult();
    };

    await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: { defaults: { technical_retries: 1 } } },
      cwd,
      shellRunner,
      onEvent: (event) => events.push(event),
    });

    expect(events.map((event) => event.type)).toEqual([
      "step.started",
      "shell.started",
      "shell.completed",
      "step.retry",
      "shell.started",
      "shell.completed",
      "step.completed",
    ]);
    expect(calls).toBe(2);
    expect(events.find((event) => event.type === "step.retry")).toMatchObject({
      attempt: 1,
      maxAttempts: 1,
    });
    expect(events.some((event) => event.type === "agent.retry")).toBe(false);
  });

  test("passes agent activity through the Aira event boundary", async () => {
    await writeFile(path.join(commandsDir, "work.md"), "Do the work.", "utf8");
    const workflow: Workflow = {
      name: "agent-events",
      steps: [
        {
          id: "implement",
          uses: "agent",
          command: "work",
          model: "coding",
        },
      ],
    };
    const state = await createState(workflow);
    const events: AiraExecutionEvent[] = [];
    const agentRuntime: AgentRuntime = {
      async runStep(request) {
        request.onEvent?.({
          type: "agent.started",
          stepId: request.stepId,
          model: request.model,
          sessionId: "session-1",
        });
        request.onEvent?.({
          type: "agent.tool.started",
          stepId: request.stepId,
          tool: "read",
          summary: "read src/service.ts",
        });
        request.onEvent?.({
          type: "agent.tool.completed",
          stepId: request.stepId,
          tool: "read",
          success: true,
        });
        return {
          success: true,
          sessionId: "session-1",
          finalText: "done",
          timedOut: false,
          completion: {
            status: "completed",
            summary: "Implemented the change.",
            artifacts: [],
          },
        };
      },
    };

    await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: {
        config: { models: { coding: "openai/example-model" } },
      },
      cwd,
      commandsDir,
      agentRuntime,
      onEvent: (event) => events.push(event),
    });

    expect(events.map((event) => event.type)).toEqual([
      "step.started",
      "agent.started",
      "agent.tool.started",
      "agent.tool.completed",
      "step.completed",
    ]);
    expect(events[0]).toMatchObject({
      type: "step.started",
      stepId: "implement",
      stepType: "agent",
    });
    expect(events[1]).toMatchObject({
      type: "agent.started",
      model: "openai/example-model",
    });
  });

  test("emits step.retry when Aira retries an agent step", async () => {
    await writeFile(path.join(commandsDir, "work.md"), "Do the work.", "utf8");
    const workflow: Workflow = {
      name: "agent-step-retry-events",
      steps: [
        {
          id: "implement",
          uses: "agent",
          command: "work",
          retry: 1,
        },
      ],
    };
    const state = await createState(workflow);
    const events: AiraExecutionEvent[] = [];
    let calls = 0;
    const agentRuntime: AgentRuntime = {
      async runStep() {
        calls += 1;

        if (calls === 1) {
          return {
            success: false,
            sessionId: "session-1",
            finalText: "",
            timedOut: false,
            error: "provider unavailable",
          };
        }

        return {
          success: true,
          sessionId: "session-2",
          finalText: "done",
          timedOut: false,
          completion: {
            status: "completed",
            summary: "Implemented the change.",
            artifacts: [],
          },
        };
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
      onEvent: (event) => events.push(event),
    });

    expect(finalState.status).toBe("completed");
    expect(finalState.steps.implement?.attempt).toBe(2);
    expect(calls).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "step.started",
      "step.retry",
      "step.completed",
    ]);
    expect(events[1]).toMatchObject({
      type: "step.retry",
      stepId: "implement",
      attempt: 1,
      maxAttempts: 1,
    });
    expect(events.some((event) => event.type === "agent.retry")).toBe(false);
  });

  test("shows loop iterations and child lifecycle", async () => {
    const workflow: Workflow = {
      name: "loop-events",
      steps: [
        {
          id: "verify-cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.verify.success == true",
          steps: [{ id: "verify", uses: "shell", run: "bun test" }],
        },
      ],
    };
    const state = await createState(workflow);
    const events: AiraExecutionEvent[] = [];

    await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      shellRunner: async () => shellResult(),
      onEvent: (event) => events.push(event),
    });

    expect(events.map((event) => event.type)).toEqual([
      "step.started",
      "loop.iteration.started",
      "step.started",
      "shell.started",
      "shell.completed",
      "step.completed",
      "step.completed",
    ]);
    expect(events[0]).toMatchObject({
      stepId: "verify-cycle",
      stepType: "loop",
    });
    expect(events[1]).toMatchObject({
      attempt: 1,
      maxAttempts: 2,
    });
    expect(events[2]).toMatchObject({
      stepId: "verify",
      parentStepId: "verify-cycle",
    });
    expect(events.at(-1)).toMatchObject({
      type: "step.completed",
      stepId: "verify-cycle",
    });
  });

  test("emits approval waiting after the step starts", async () => {
    const workflow: Workflow = {
      name: "approval-events",
      steps: [
        {
          id: "approve-plan",
          uses: "approval",
          message: "Approve the plan?",
        },
      ],
    };
    const state = await createState(workflow);
    const events: AiraExecutionEvent[] = [];

    const waiting = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      onEvent: (event) => events.push(event),
    });

    expect(waiting.status).toBe("waiting");
    expect(events).toEqual([
      {
        type: "step.started",
        stepId: "approve-plan",
        stepType: "approval",
      },
      {
        type: "approval.waiting",
        stepId: "approve-plan",
        message: "Approve the plan?",
      },
    ]);
  });

  test("runs unchanged without an observer and ignores observer failures", async () => {
    const workflow: Workflow = {
      name: "optional-observer",
      steps: [{ id: "verify", uses: "shell", run: "bun test" }],
    };
    const withoutObserver = await executeWorkflow({
      workflow,
      runsRoot,
      state: await createState(workflow),
      context: { config: {} },
      cwd,
      shellRunner: async () => shellResult(),
    });

    expect(withoutObserver.status).toBe("completed");

    const withBrokenObserver = await executeWorkflow({
      workflow,
      runsRoot,
      state: await createState(workflow),
      context: { config: {} },
      cwd,
      shellRunner: async () => shellResult(),
      onEvent() {
        throw new Error("output closed");
      },
    });

    expect(withBrokenObserver.status).toBe("completed");
  });
});
