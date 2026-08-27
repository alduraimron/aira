import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentRuntime,
  AgentStepResult,
} from "../../src/agent";
import {
  executeWorkflow,
  type ShellRunner,
} from "../../src/executor";
import {
  createRun,
  loadRun,
  patchStepState,
  saveRun,
  type RunState,
} from "../../src/run";
import { ShellCommandError } from "../../src/shell";
import type { Workflow, WorkflowStep } from "../../src/workflow";

let directory: string;
let runsRoot: string;
let cwd: string;
let commandsDir: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-interrupt-"));
  runsRoot = path.join(directory, ".aira", "runs");
  cwd = path.join(directory, "project");
  commandsDir = path.join(directory, "commands");
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(commandsDir, { recursive: true }),
  ]);
  await writeFile(path.join(commandsDir, "work.md"), "Do the work.", "utf8");
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function abortedAgentResult(): AgentStepResult {
  return {
    success: false,
    sessionId: "aborted-session",
    finalText: "partial work",
    timedOut: false,
    aborted: true,
    error: "aborted",
  };
}

describe("external agent interruption", () => {
  test("propagates the signal, persists interrupted state, and does not retry", async () => {
    const workflow: Workflow = {
      name: "interrupt-agent",
      steps: [
        { id: "work", uses: "agent", command: "work", retry: 5 },
      ],
    };
    const state = await createState(workflow);
    const controller = new AbortController();
    const started = deferred<void>();
    let calls = 0;
    let receivedSignal: AbortSignal | undefined;
    const agentRuntime: AgentRuntime = {
      async runStep(request) {
        calls += 1;
        receivedSignal = request.signal;
        started.resolve();

        return await new Promise<AgentStepResult>((resolve) => {
          request.signal?.addEventListener(
            "abort",
            () => resolve(abortedAgentResult()),
            { once: true },
          );
        });
      },
    };

    const execution = executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: { defaults: { technical_retries: 9 } } },
      cwd,
      commandsDir,
      agentRuntime,
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    const interrupted = await execution;
    const persisted = await loadRun(runsRoot, state.id);

    expect(receivedSignal).toBe(controller.signal);
    expect(calls).toBe(1);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.current_step).toBe("work");
    expect(interrupted.steps.work).toMatchObject({
      status: "interrupted",
      attempt: 1,
      success: false,
    });
    expect(interrupted.steps.work?.completed_at).toBeUndefined();
    expect(persisted).toEqual(interrupted);
  });

  test("does not start a retry when abort accompanies a technical result", async () => {
    const workflow: Workflow = {
      name: "abort-before-agent-retry",
      steps: [
        { id: "work", uses: "agent", command: "work", retry: 4 },
      ],
    };
    const state = await createState(workflow);
    const controller = new AbortController();
    let calls = 0;

    const interrupted = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      commandsDir,
      signal: controller.signal,
      agentRuntime: {
        async runStep() {
          calls += 1;
          controller.abort();
          return {
            success: false,
            sessionId: "failed-and-aborted",
            finalText: "partial",
            timedOut: false,
            error: "provider unavailable",
          };
        },
      },
    });

    expect(calls).toBe(1);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.steps.work).toMatchObject({
      status: "interrupted",
      attempt: 1,
      success: false,
    });
  });

  test("interrupts both an active loop child and its logical loop", async () => {
    const workflow: Workflow = {
      name: "interrupt-loop-agent",
      steps: [
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 3,
          until: "steps.work.success == true",
          steps: [
            { id: "work", uses: "agent", command: "work", retry: 3 },
          ],
        },
      ],
    };
    const state = await createState(workflow);
    const controller = new AbortController();
    const started = deferred<void>();
    let calls = 0;

    const execution = executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      commandsDir,
      signal: controller.signal,
      agentRuntime: {
        async runStep(request) {
          calls += 1;
          started.resolve();
          return await new Promise<AgentStepResult>((resolve) => {
            request.signal?.addEventListener(
              "abort",
              () => resolve(abortedAgentResult()),
              { once: true },
            );
          });
        },
      },
    });
    await started.promise;
    controller.abort();
    const interrupted = await execution;

    expect(calls).toBe(1);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.current_step).toBe("cycle");
    expect(interrupted.steps.cycle).toMatchObject({
      status: "interrupted",
      attempt: 1,
      success: false,
    });
    expect(interrupted.steps.work).toMatchObject({
      status: "interrupted",
      attempt: 1,
      success: false,
    });
    expect(interrupted.steps.cycle?.completed_at).toBeUndefined();
    expect(interrupted.steps.work?.completed_at).toBeUndefined();
  });
});

describe("external shell interruption", () => {
  test("forwards abort to active shell work and does not retry", async () => {
    const workflow: Workflow = {
      name: "interrupt-shell",
      steps: [{ id: "slow", uses: "shell", run: "slow" }],
    };
    const state = await createState(workflow);
    const controller = new AbortController();
    const started = deferred<void>();
    let calls = 0;
    let terminationRequested = false;
    const shellRunner: ShellRunner = async (params) => {
      calls += 1;
      started.resolve();

      return await new Promise((_, reject) => {
        params.signal?.addEventListener(
          "abort",
          () => {
            terminationRequested = true;
            reject(
              new ShellCommandError("shell command aborted", {
                kind: "aborted",
              }),
            );
          },
          { once: true },
        );
      });
    };

    const execution = executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: { defaults: { technical_retries: 4 } } },
      cwd,
      shellRunner,
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    const interrupted = await execution;

    expect(terminationRequested).toBe(true);
    expect(calls).toBe(1);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.current_step).toBe("slow");
    expect(interrupted.steps.slow).toMatchObject({
      status: "interrupted",
      attempt: 1,
      success: false,
    });
    expect(interrupted.steps.slow?.completed_at).toBeUndefined();
    expect(await loadRun(runsRoot, state.id)).toEqual(interrupted);
  });
});

describe("abort boundaries without active execution", () => {
  test("an already-aborted signal leaves the next pending step untouched", async () => {
    const workflow: Workflow = {
      name: "abort-before-start",
      steps: [
        { id: "a", uses: "shell", run: "a" },
        { id: "b", uses: "shell", run: "b" },
      ],
    };
    let state = await createState(workflow);
    state = patchStepState(state, "a", {
      status: "completed",
      attempt: 1,
      success: true,
      completed_at: "2026-08-26T10:56:00.000Z",
    });
    await saveRun(runsRoot, state);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    const interrupted = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      mode: "continue",
      signal: controller.signal,
      shellRunner: async () => {
        calls += 1;
        throw new Error("must not execute");
      },
    });

    expect(calls).toBe(0);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.current_step).toBe("b");
    expect(interrupted.steps.b).toEqual({ status: "pending", attempt: 0 });
    expect(await loadRun(runsRoot, state.id)).toEqual(interrupted);
  });

  test("does not turn approval waiting into interruption", async () => {
    const workflow: Workflow = {
      name: "approval-ignores-abort",
      steps: [{ id: "approve", uses: "approval" }],
    };
    const state = await createState(workflow);
    const controller = new AbortController();
    controller.abort();

    const waiting = await executeWorkflow({
      workflow,
      runsRoot,
      state,
      context: { config: {} },
      cwd,
      signal: controller.signal,
    });

    expect(waiting.status).toBe("waiting");
    expect(waiting.current_step).toBe("approve");
    expect(waiting.steps.approve).toEqual({ status: "waiting", attempt: 0 });
  });
});
