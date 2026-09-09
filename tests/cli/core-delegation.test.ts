import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  AiraCore,
  InvalidLifecycleActionError,
  type CoreExecutionOptions,
  type ContinueRunInput,
  type PreviewRunInput,
  type RunBoundary,
  type RunPreview,
  type RunView,
  type StartRunInput,
} from "../../src/core";
import { runCli } from "../../src/cli";
import { TestCliIO, TestSigintSource } from "./helpers";

const root = "/tmp/aira-cli-core";
const runId = "20260906-120000-deadbeef";

function completedBoundary(): RunBoundary {
  return {
    kind: "completed",
    runId,
    workflow: "feature",
    checkpointToken: "checkpoint-completed",
    status: "completed",
    summary: "done",
    allowedActions: [],
    artifacts: [],
  };
}

function interruptedView(): RunView {
  const boundary: RunBoundary = {
    kind: "interrupted",
    runId,
    workflow: "feature",
    checkpointToken: "checkpoint-interrupted",
    status: "interrupted",
    summary: "interrupted",
    currentStep: {
      id: "work",
      type: "shell",
      status: "interrupted",
      attempt: 1,
    },
    allowedActions: ["resume"],
    artifacts: [],
    resumable: true,
  };
  return {
    runId,
    workflow: "feature",
    checkpointToken: "checkpoint-interrupted",
    status: "interrupted",
    task: "task",
    startedAt: "2026-09-06T12:00:00.000Z",
    updatedAt: "2026-09-06T12:01:00.000Z",
    summary: boundary.summary,
    currentStep: {
      id: "work",
      type: "shell",
      status: "interrupted",
      attempt: 1,
    },
    steps: [
      { id: "work", type: "shell", status: "interrupted", attempt: 1 },
    ],
    artifacts: [],
    allowedActions: ["resume"],
    resumable: true,
    workflowAvailable: true,
    boundary,
  };
}

function completedView(): RunView {
  const boundary = completedBoundary();
  return {
    runId,
    workflow: "feature",
    checkpointToken: boundary.checkpointToken,
    status: "completed",
    task: "task",
    startedAt: "2026-09-06T12:00:00.000Z",
    updatedAt: "2026-09-06T12:01:00.000Z",
    summary: boundary.summary,
    steps: [{ id: "work", type: "shell", status: "completed", attempt: 1 }],
    artifacts: [],
    allowedActions: [],
    resumable: false,
    workflowAvailable: true,
    boundary,
  };
}

class RecordingCore extends AiraCore {
  readonly calls: Array<{
    method: string;
    input?: unknown;
    execution?: CoreExecutionOptions;
  }> = [];
  view: RunView | undefined = interruptedView();
  continueError?: Error;
  emitContinueEvent = false;

  constructor() {
    super({ cwd: root });
  }

  override async initializeProject() {
    this.calls.push({ method: "initializeProject" });
    return {
      initialized: true as const,
      root,
      airaDirectory: path.join(root, ".aira"),
      created: true,
    };
  }

  override async listWorkflows() {
    this.calls.push({ method: "listWorkflows" });
    return [
      {
        name: "feature",
        description: "Feature workflow",
        stepCount: 1,
        topLevelStepCount: 1,
        hasAgentSteps: false,
      },
    ];
  }

  override async previewRun(input: PreviewRunInput): Promise<RunPreview> {
    this.calls.push({ method: "previewRun", input });
    return {
      projectRoot: root,
      preparationToken: "cli-preview-token",
      workflow: {
        name: input.workflow,
        stepCount: 1,
        topLevelStepCount: 1,
        hasAgentSteps: false,
      },
      task: input.task,
      hasAgentSteps: false,
      steps: [{ id: "work", type: "shell" }],
    };
  }

  override async startRun(
    input: StartRunInput,
    _execution?: CoreExecutionOptions,
  ): Promise<RunBoundary> {
    this.calls.push({ method: "startRun", input });
    return completedBoundary();
  }

  override async inspectRun(requestedRunId?: string): Promise<RunView | undefined> {
    this.calls.push({ method: "inspectRun", input: requestedRunId });
    return requestedRunId === runId ? this.view : undefined;
  }

  override async continueRun(
    input: ContinueRunInput,
    execution?: CoreExecutionOptions,
  ): Promise<RunBoundary> {
    this.calls.push({ method: "continueRun", input, execution });

    if (this.emitContinueEvent) {
      execution?.onEvent?.({
        type: "step.started",
        stepId: "work",
        stepType: "shell",
      });
    }

    if (this.continueError !== undefined) {
      throw this.continueError;
    }

    return completedBoundary();
  }
}

describe("CLI Core delegation", () => {
  test("every application command delegates to AiraCore", async () => {
    const core = new RecordingCore();

    expect(await runCli(["init"], { core, io: new TestCliIO() })).toBe(0);
    expect(await runCli(["list"], { core, io: new TestCliIO() })).toBe(0);
    expect(
      await runCli(["run", "feature", "brief", "--dry-run"], {
        core,
        io: new TestCliIO(),
      }),
    ).toBe(0);
    expect(
      await runCli(["run", "feature", "brief", "--allow-dirty"], {
        core,
        io: new TestCliIO(),
        sigintSource: new TestSigintSource(),
      }),
    ).toBe(0);
    expect(
      await runCli(["status", runId], { core, io: new TestCliIO() }),
    ).toBe(0);
    expect(
      await runCli(["resume", runId], {
        core,
        io: new TestCliIO(),
        sigintSource: new TestSigintSource(),
      }),
    ).toBe(0);

    expect(core.calls.map((call) => call.method)).toEqual([
      "initializeProject",
      "listWorkflows",
      "previewRun",
      "startRun",
      "inspectRun",
      "inspectRun",
      "continueRun",
    ]);
    expect(core.calls.find((call) => call.method === "startRun")?.input)
      .toEqual({ workflow: "feature", task: "brief", allowDirty: true });
    expect(core.calls.at(-1)?.input).toEqual({
      runId,
      action: "resume",
      expectedBoundaryToken: "checkpoint-interrupted",
    });
  });

  test("valid resume invokes Core once with checkpoint, signal, and reporter", async () => {
    const core = new RecordingCore();
    core.emitContinueEvent = true;
    const io = new TestCliIO();
    const signals = new TestSigintSource();

    expect(
      await runCli(["resume", runId], {
        core,
        io,
        sigintSource: signals,
      }),
    ).toBe(0);

    const continuationCalls = core.calls.filter(
      (call) => call.method === "continueRun",
    );
    expect(continuationCalls).toHaveLength(1);
    expect(continuationCalls[0]?.input).toEqual({
      runId,
      action: "resume",
      expectedBoundaryToken: "checkpoint-interrupted",
    });
    expect(continuationCalls[0]?.execution?.signal).toBeInstanceOf(AbortSignal);
    expect(continuationCalls[0]?.execution?.onEvent).toBeFunction();
    expect(io.out).toContain("● work");
    expect(signals.addCalls).toBe(1);
    expect(signals.removeCalls).toBe(1);
    expect(signals.handlers.size).toBe(0);
  });

  test("non-resumable state gets one guarded Core rejection, never a probe call", async () => {
    const core = new RecordingCore();
    core.view = completedView();
    core.continueError = new InvalidLifecycleActionError({
      runId,
      action: "resume",
      message: `run "${runId}" is "completed" and cannot be resumed`,
    });
    const io = new TestCliIO();
    const signals = new TestSigintSource();

    expect(
      await runCli(["resume", runId], {
        core,
        io,
        sigintSource: signals,
      }),
    ).toBe(1);

    const continuationCalls = core.calls.filter(
      (call) => call.method === "continueRun",
    );
    expect(continuationCalls).toHaveLength(1);
    expect(continuationCalls[0]?.input).toEqual({
      runId,
      action: "resume",
      expectedBoundaryToken: "checkpoint-completed",
    });
    expect(continuationCalls[0]?.execution?.signal).toBeInstanceOf(AbortSignal);
    expect(continuationCalls[0]?.execution?.onEvent).toBeFunction();
    expect(io.error).toContain('is "completed" and cannot be resumed');
  });

  test("explicit missing run never invokes mutating Core fallback", async () => {
    const core = new RecordingCore();
    core.view = undefined;
    const io = new TestCliIO();

    expect(await runCli(["resume", runId], { core, io })).toBe(1);
    expect(core.calls).toEqual([{ method: "inspectRun", input: runId }]);
    expect(io.error).toContain(`run "${runId}" was not found`);
  });

  test("CLI command orchestration no longer imports domain preparation or persistence", async () => {
    const source = await readFile(
      path.resolve(import.meta.dir, "../../src/cli/commands.ts"),
      "utf8",
    );

    expect(source).toContain('from "../core"');
    for (const forbidden of [
      "loadConfig(",
      "loadNamedWorkflow(",
      "preflightWorkflow(",
      "createRun(",
      "loadRun(",
      "executeWorkflow(",
      "applyApprovalDecision(",
      "inspectGitWorkingTree(",
      "discoverAiraProject(",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
