import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
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
import {
  AiraCore,
  ConfigValidationError,
  CoreExecutionError,
  CoreRunNotFoundError,
  CoreWorkflowNotFoundError,
  DirtyWorktreeError,
  InvalidLifecycleActionError,
  InvalidRevisionFeedbackError,
  ProjectNotInitializedError,
  StaleRunBoundaryError,
  StaleRunPreparationError,
  type CoreWorkflowExecutor,
} from "../../src/core";
import type { GitCommandRunner } from "../../src/git";
import {
  getAiraProjectPaths,
  initializeAiraProject,
  type AiraProjectPaths,
} from "../../src/project";
import { listRunIds, loadRun } from "../../src/run";
import { loadNamedWorkflow } from "../../src/workflow";

const nonGitRunner: GitCommandRunner = async () => ({
  exitCode: 128,
  stdout: "",
  stderr: "fatal: not a git repository",
});

let directory: string;
let paths: AiraProjectPaths;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-core-"));
  paths = (await initializeAiraProject(directory)).paths;
  await Promise.all([
    clearDirectory(paths.workflowsDir),
    clearDirectory(paths.commandsDir),
  ]);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function clearDirectory(target: string): Promise<void> {
  const entries = await readdir(target);
  await Promise.all(
    entries.map((entry) =>
      rm(path.join(target, entry), { recursive: true, force: true }),
    ),
  );
}

async function writeWorkflow(name: string, source: string): Promise<void> {
  await writeFile(
    path.join(paths.workflowsDir, `${name}.yaml`),
    source.trimStart(),
    "utf8",
  );
}

async function writeCommand(name: string, source: string): Promise<void> {
  await writeFile(path.join(paths.commandsDir, `${name}.md`), source, "utf8");
}

function createCore(
  options: {
    runtime?: AgentRuntime;
    runtimeFactory?: () => AgentRuntime;
    executor?: CoreWorkflowExecutor;
    git?: GitCommandRunner;
    clock?: () => Date;
  } = {},
): AiraCore {
  return new AiraCore({
    cwd: directory,
    gitCommandRunner: options.git ?? nonGitRunner,
    executor: options.executor,
    clock: options.clock,
    agentRuntimeFactory:
      options.runtimeFactory ??
      (options.runtime === undefined ? undefined : () => options.runtime!),
  });
}

interface RecordingRuntime extends AgentRuntime {
  requests: AgentStepRequest[];
}

function recordingRuntime(
  result?: (request: AgentStepRequest, call: number) => AgentStepResult | Promise<AgentStepResult>,
): RecordingRuntime {
  const requests: AgentStepRequest[] = [];
  return {
    requests,
    async runStep(request) {
      requests.push(request);
      const call = requests.length;

      if (result !== undefined) {
        return await result(request, call);
      }

      const expected = request.completion?.expectedArtifacts ?? [];
      return {
        success: true,
        sessionId: `session-${call}`,
        finalText: `finished ${request.stepId}`,
        timedOut: false,
        completion: {
          status: "completed",
          summary: `${request.stepId} complete`,
          artifacts: expected.map((name) => ({
            name,
            content: `${name} content ${call}`,
          })),
        },
      };
    },
  };
}

async function writeApprovalWorkflow(): Promise<void> {
  await writeCommand("plan", "Create plan for {{ input.task }}.");
  await writeWorkflow(
    "feature",
    `
name: feature
description: Plan and implement
steps:
  - id: plan
    uses: agent
    command: plan
    artifact:
      name: plan
      filename: plan.md
      versioned: true
  - id: approve-plan
    uses: approval
    artifact: plan
    message: Approve this plan?
    revise: plan
  - id: finish
    uses: shell
    run: "printf done"
`,
  );
}

describe("AiraCore public boundary", () => {
  test("Core source has no CLI, readline, process-exit, or Pi SDK dependency", async () => {
    const coreDirectory = path.resolve(import.meta.dir, "../../src/core");
    const files = (await readdir(coreDirectory)).filter((file) => file.endsWith(".ts"));
    const source = (
      await Promise.all(
        files.map((file) => readFile(path.join(coreDirectory, file), "utf8")),
      )
    ).join("\n");

    for (const forbidden of [
      'from "../cli',
      "node:readline",
      "process.exit",
      "pi-coding-agent",
      "PiRuntime",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  test("uses typed project, workflow, and configuration errors", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "aira-core-errors-"));

    try {
      await expect(
        new AiraCore({ cwd: fresh }).listWorkflows(),
      ).rejects.toBeInstanceOf(ProjectNotInitializedError);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }

    await expect(
      createCore().previewRun({ workflow: "missing", task: "brief" }),
    ).rejects.toBeInstanceOf(CoreWorkflowNotFoundError);

    await writeWorkflow(
      "invalid-config",
      `
name: invalid-config
steps:
  - id: work
    uses: shell
    run: work
`,
    );
    await writeFile(paths.configFile, "defaults:\n  agent_timeout: 0\n", "utf8");
    await expect(
      createCore().previewRun({ workflow: "invalid-config", task: "brief" }),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  test("keeps persisted technical execution failures distinct from failed boundaries", async () => {
    await writeWorkflow(
      "technical-failure",
      `
name: technical-failure
steps:
  - id: work
    uses: shell
    run: "echo {{ input.missing }}"
`,
    );

    try {
      await createCore().startRun({
        workflow: "technical-failure",
        task: "brief",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CoreExecutionError);
      expect((error as CoreExecutionError).persisted).toBe(true);
      expect(error).toHaveProperty("cause");
      return;
    }

    throw new Error("expected CoreExecutionError");
  });
});

describe("AiraCore project and preview operations", () => {
  test("inspects initialized and uninitialized projects", async () => {
    const initialized = await createCore().inspectProject();
    expect(initialized).toMatchObject({
      initialized: true,
      root: directory,
      airaDirectory: paths.airaDir,
    });

    const uninitializedDirectory = path.join(directory, "outside");
    await mkdir(uninitializedDirectory);
    await rm(paths.airaDir, { recursive: true, force: true });
    expect(
      await new AiraCore({ cwd: uninitializedDirectory }).inspectProject(),
    ).toEqual({ initialized: false, root: uninitializedDirectory });
  });

  test("initialization is idempotent", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "aira-core-init-"));

    try {
      const core = new AiraCore({ cwd: fresh });
      expect(await core.initializeProject()).toMatchObject({
        initialized: true,
        created: true,
      });
      const config = getAiraProjectPaths(fresh).configFile;
      await writeFile(config, "models: {}\n# keep me\n", "utf8");
      expect(await core.initializeProject()).toMatchObject({
        initialized: true,
        created: false,
      });
      expect(await Bun.file(config).text()).toContain("# keep me");
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  test("lists workflows with descriptions and step metadata", async () => {
    await writeWorkflow(
      "one",
      `
name: one
description: First workflow
steps:
  - id: check
    uses: shell
    run: check
`,
    );
    await writeCommand("work", "Work.");
    await writeWorkflow(
      "two",
      `
name: two
steps:
  - id: work
    uses: agent
    command: work
`,
    );

    expect(await createCore().listWorkflows()).toEqual([
      {
        name: "one",
        description: "First workflow",
        stepCount: 1,
        topLevelStepCount: 1,
        hasAgentSteps: false,
      },
      {
        name: "two",
        stepCount: 1,
        topLevelStepCount: 1,
        hasAgentSteps: true,
      },
    ]);
  });

  test("refuses a start when files changed after the authorized preview", async () => {
    await writeWorkflow(
      "prepared",
      `
name: prepared
steps:
  - id: work
    uses: shell
    run: "printf first"
`,
    );
    const core = createCore();
    const preview = await core.previewRun({
      workflow: "prepared",
      task: "brief",
    });
    await writeWorkflow(
      "prepared",
      `
name: prepared
steps:
  - id: work
    uses: shell
    run: "printf changed"
`,
    );

    await expect(
      core.startRun({
        workflow: "prepared",
        task: "brief",
        allowDirty: true,
        expectedPreparationToken: preview.preparationToken,
      }),
    ).rejects.toBeInstanceOf(StaleRunPreparationError);
    expect(await listRunIds(paths.runsDir)).toEqual([]);
  });

  test("previews resolved nested steps without Git, runtime, run, or execution", async () => {
    await writeFile(
      paths.configFile,
      `models:\n  coding: provider/model\ndefaults:\n  model: coding\n  agent_timeout: 41\n  technical_retries: 2\n`,
      "utf8",
    );
    await writeCommand("work", "Work on {{ input.task }}.");
    await writeWorkflow(
      "preview",
      `
name: preview
description: Preview workflow
steps:
  - id: cycle
    uses: loop
    max_attempts: 2
    until: "steps.work.success == true"
    steps:
      - id: work
        uses: agent
        command: work
`,
    );
    let runtimeCalls = 0;
    let gitCalls = 0;
    let executorCalls = 0;
    const core = new AiraCore({
      cwd: directory,
      agentRuntimeFactory() {
        runtimeCalls += 1;
        throw new Error("runtime must not be created");
      },
      gitCommandRunner: async () => {
        gitCalls += 1;
        throw new Error("Git must not run");
      },
      executor: async () => {
        executorCalls += 1;
        throw new Error("executor must not run");
      },
    });

    const preview = await core.previewRun({
      workflow: "preview",
      task: "Keep this brief unchanged",
    });

    expect(preview.task).toBe("Keep this brief unchanged");
    expect(preview.hasAgentSteps).toBe(true);
    expect(preview.steps[0]).toMatchObject({
      id: "cycle",
      type: "loop",
      maxAttempts: 2,
      steps: [
        {
          id: "work",
          type: "agent",
          parentStepId: "cycle",
          command: "work",
          agent: {
            model: "provider/model",
            timeoutSeconds: 41,
            technicalRetries: 2,
          },
        },
      ],
    });
    expect(runtimeCalls).toBe(0);
    expect(gitCalls).toBe(0);
    expect(executorCalls).toBe(0);
    expect(await listRunIds(paths.runsDir)).toEqual([]);
  });
});

describe("AiraCore start boundaries", () => {
  test("runs a workflow without agent steps and never creates AgentRuntime", async () => {
    await writeWorkflow(
      "shell-only",
      `
name: shell-only
steps:
  - id: work
    uses: shell
    run: "printf shell-only"
`,
    );
    let runtimeCalls = 0;
    const core = createCore({
      runtimeFactory() {
        runtimeCalls += 1;
        throw new Error("runtime must not be created");
      },
    });

    const boundary = await core.startRun({
      workflow: "shell-only",
      task: "Run shell",
    });

    expect(boundary.kind).toBe("completed");
    expect(runtimeCalls).toBe(0);
    expect(boundary.artifacts).toEqual([]);
  });

  test("returns a completed boundary with artifact metadata and summary", async () => {
    await writeCommand("report", "Report {{ input.task }}.");
    await writeWorkflow(
      "report",
      `
name: report
steps:
  - id: report
    uses: agent
    command: report
    artifact:
      name: report
      filename: report.md
`,
    );
    const runtime = recordingRuntime();
    const boundary = await createCore({ runtime }).startRun({
      workflow: "report",
      task: "execution brief",
    });

    expect(boundary).toMatchObject({
      kind: "completed",
      workflow: "report",
      summary: "report complete",
      artifacts: [
        {
          name: "report",
          currentPath: "artifacts/report.md",
          versioned: false,
          producerStepId: "report",
        },
      ],
    });
    expect(runtime.requests[0]?.prompt).toContain("execution brief");
  });

  test("returns a domain failure boundary", async () => {
    await writeWorkflow(
      "fail",
      `
name: fail
steps:
  - id: check
    uses: shell
    run: "exit 7"
`,
    );
    const boundary = await createCore().startRun({
      workflow: "fail",
      task: "Fail deterministically",
    });

    expect(boundary).toMatchObject({
      kind: "failed",
      status: "failed",
      currentStep: { id: "check", type: "shell" },
      allowedActions: [],
    });
  });

  test("returns approval content and legal decisions without parsing text", async () => {
    await writeApprovalWorkflow();
    const boundary = await createCore({ runtime: recordingRuntime() }).startRun({
      workflow: "feature",
      task: "Build it",
    });

    expect(boundary).toMatchObject({
      kind: "approval-required",
      currentStep: { id: "approve-plan", type: "approval" },
      allowedActions: ["approve", "revise", "cancel"],
      approval: {
        stepId: "approve-plan",
        message: "Approve this plan?",
        revisionTargetStepId: "plan",
        artifact: {
          name: "plan",
          available: true,
          currentPath: "artifacts/plan-v1.md",
          content: "plan content 1",
        },
      },
    });
  });

  test("maps exhausted loops to manual intervention", async () => {
    await writeWorkflow(
      "loop",
      `
name: loop
steps:
  - id: cycle
    uses: loop
    max_attempts: 2
    until: "steps.check.success == true"
    steps:
      - id: check
        uses: shell
        run: "exit 1"
`,
    );
    const boundary = await createCore().startRun({
      workflow: "loop",
      task: "Check",
    });

    expect(boundary).toMatchObject({
      kind: "manual-intervention",
      reason: "loop-exhausted",
      currentStep: { id: "cycle", type: "loop", attempt: 2 },
      intervention: {
        supported: false,
        maxAttempts: 2,
        attempts: 2,
      },
      allowedActions: [],
    });
  });

  test("refuses dirty worktrees and allowDirty bypasses the check", async () => {
    await writeWorkflow(
      "clean",
      `
name: clean
steps:
  - id: work
    uses: shell
    run: "printf clean"
`,
    );
    let gitCalls = 0;
    const dirty: GitCommandRunner = async (args) => {
      gitCalls += 1;
      return args[0] === "rev-parse"
        ? { exitCode: 0, stdout: "true\n", stderr: "" }
        : { exitCode: 0, stdout: " M file\n", stderr: "" };
    };
    const core = createCore({ git: dirty });

    await expect(
      core.startRun({ workflow: "clean", task: "work" }),
    ).rejects.toBeInstanceOf(DirtyWorktreeError);
    expect(await listRunIds(paths.runsDir)).toEqual([]);

    expect(
      await core.startRun({
        workflow: "clean",
        task: "work",
        allowDirty: true,
      }),
    ).toMatchObject({ kind: "completed" });
    expect(gitCalls).toBe(2);
  });

  test("propagates execution events", async () => {
    await writeWorkflow(
      "events",
      `
name: events
steps:
  - id: work
    uses: shell
    run: "printf event"
`,
    );
    const eventTypes: string[] = [];
    await createCore().startRun(
      { workflow: "events", task: "observe" },
      { onEvent: (event) => eventTypes.push(event.type) },
    );
    expect(eventTypes).toEqual([
      "step.started",
      "shell.started",
      "shell.completed",
      "step.completed",
    ]);
  });
});

describe("AiraCore continuation and revision", () => {
  test("approves and continues to completion without an unneeded new runtime", async () => {
    await writeApprovalWorkflow();
    const runtime = recordingRuntime();
    let runtimeFactoryCalls = 0;
    const core = createCore({
      runtimeFactory: () => {
        runtimeFactoryCalls += 1;
        return runtime;
      },
    });
    const waiting = await core.startRun({ workflow: "feature", task: "Build" });
    const completed = await core.continueRun({
      runId: waiting.runId,
      action: "approve",
    });

    expect(completed.kind).toBe("completed");
    expect(runtimeFactoryCalls).toBe(1);
    const state = await loadRun(paths.runsDir, waiting.runId);
    expect(state.steps["approve-plan"]).toMatchObject({
      status: "completed",
      result: "approved",
    });
  });

  test("revision uses exact prior artifacts and repeated revision increments versions", async () => {
    await writeApprovalWorkflow();
    const runtime = recordingRuntime((request, call) => ({
      success: true,
      sessionId: `session-${call}`,
      finalText: "done",
      timedOut: false,
      completion: {
        status: "completed",
        summary: `plan ${call}`,
        artifacts: [{ name: "plan", content: `EXACT PLAN ${call}\n` }],
      },
    }));
    const core = createCore({ runtime });
    const first = await core.startRun({ workflow: "feature", task: "Build" });
    const second = await core.continueRun({
      runId: first.runId,
      action: "revise",
      feedback: "Add rollback tests",
    });

    expect(second).toMatchObject({
      kind: "approval-required",
      approval: {
        artifact: {
          currentPath: "artifacts/plan-v2.md",
          content: "EXACT PLAN 2\n",
        },
      },
    });
    expect(runtime.requests[1]?.prompt).toContain("Add rollback tests");
    expect(runtime.requests[1]?.prompt).toContain("EXACT PLAN 1\n");

    const third = await core.continueRun({
      runId: second.runId,
      action: "revise",
      feedback: "Keep the API compatible",
    });
    expect(third).toMatchObject({
      kind: "approval-required",
      approval: {
        artifact: {
          currentPath: "artifacts/plan-v3.md",
          content: "EXACT PLAN 3\n",
        },
      },
    });
    expect(runtime.requests[2]?.prompt).toContain("Keep the API compatible");
    expect(runtime.requests[2]?.prompt).toContain("EXACT PLAN 2\n");

    const state = await loadRun(paths.runsDir, first.runId);
    expect(state.artifacts.plan?.versions).toEqual([
      "artifacts/plan-v1.md",
      "artifacts/plan-v2.md",
      "artifacts/plan-v3.md",
    ]);
    expect(state.revisions?.map((revision) => revision.status)).toEqual([
      "resolved",
      "resolved",
    ]);
  });

  test("rejects empty revision feedback before mutating", async () => {
    await writeApprovalWorkflow();
    const core = createCore({ runtime: recordingRuntime() });
    const waiting = await core.startRun({ workflow: "feature", task: "Build" });

    await expect(
      core.continueRun({
        runId: waiting.runId,
        action: "revise",
        feedback: "  ",
      }),
    ).rejects.toBeInstanceOf(InvalidRevisionFeedbackError);
    expect((await loadRun(paths.runsDir, waiting.runId)).status).toBe("waiting");
  });

  test("inspectRun remains readable when an approval artifact file is missing", async () => {
    await writeApprovalWorkflow();
    const core = createCore({ runtime: recordingRuntime() });
    const waiting = await core.startRun({ workflow: "feature", task: "Build" });
    await unlink(
      path.join(paths.runsDir, waiting.runId, "artifacts", "plan-v1.md"),
    );

    const view = await core.inspectRun(waiting.runId);
    expect(view?.boundary).toMatchObject({
      kind: "approval-required",
      approval: {
        artifact: {
          name: "plan",
          available: false,
          reason: expect.stringContaining("Could not read artifact"),
        },
      },
    });
  });

  test("rejects a boundary whose approved artifact changed after inspection", async () => {
    await writeApprovalWorkflow();
    const core = createCore({ runtime: recordingRuntime() });
    const waiting = await core.startRun({ workflow: "feature", task: "Build" });
    await writeFile(
      path.join(paths.runsDir, waiting.runId, "artifacts", "plan-v1.md"),
      "changed outside Aira",
      "utf8",
    );

    await expect(
      core.continueRun({
        runId: waiting.runId,
        action: "approve",
        expectedBoundaryToken: waiting.checkpointToken,
      }),
    ).rejects.toBeInstanceOf(StaleRunBoundaryError);
    expect((await loadRun(paths.runsDir, waiting.runId)).status).toBe("waiting");
  });

  test("cancels without invoking the executor again", async () => {
    await writeApprovalWorkflow();
    let executorCalls = 0;
    const executor: CoreWorkflowExecutor = async (params) => {
      executorCalls += 1;
      return await (await import("../../src/executor")).executeWorkflow(params);
    };
    const core = createCore({ runtime: recordingRuntime(), executor });
    const waiting = await core.startRun({ workflow: "feature", task: "Build" });
    const cancelled = await core.continueRun({
      runId: waiting.runId,
      action: "cancel",
    });

    expect(cancelled.kind).toBe("cancelled");
    expect(executorCalls).toBe(1);
  });

  test("rejects an action that is invalid for the current boundary", async () => {
    await writeWorkflow(
      "done",
      `
name: done
steps:
  - id: work
    uses: shell
    run: "printf done"
`,
    );
    const core = createCore();
    const completed = await core.startRun({ workflow: "done", task: "done" });

    await expect(
      core.continueRun({ runId: completed.runId, action: "approve" }),
    ).rejects.toBeInstanceOf(InvalidLifecycleActionError);
  });
});

describe("AiraCore interruption and resume", () => {
  test("an aborted signal before a step returns a resumable interruption", async () => {
    await writeWorkflow(
      "interrupt",
      `
name: interrupt
steps:
  - id: work
    uses: shell
    run: "printf work"
`,
    );
    const controller = new AbortController();
    controller.abort();
    const core = createCore();
    const interrupted = await core.startRun(
      { workflow: "interrupt", task: "interrupt" },
      { signal: controller.signal },
    );

    expect(interrupted).toMatchObject({
      kind: "interrupted",
      resumable: true,
      allowedActions: ["resume"],
      currentStep: { id: "work", status: "pending", attempt: 0 },
    });
    expect(
      await core.continueRun({ runId: interrupted.runId, action: "resume" }),
    ).toMatchObject({ kind: "completed" });
  });

  test("aborts an active agent operation and later resumes with fresh execution", async () => {
    await writeCommand("work", "Work.");
    await writeWorkflow(
      "agent-interrupt",
      `
name: agent-interrupt
steps:
  - id: work
    uses: agent
    command: work
`,
    );
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const runtime = recordingRuntime(async (request) => {
      calls += 1;

      if (calls === 1) {
        started();
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return {
          success: false,
          sessionId: "interrupted",
          finalText: "",
          timedOut: false,
          aborted: true,
        };
      }

      return {
        success: true,
        sessionId: "resumed",
        finalText: "done",
        timedOut: false,
        completion: {
          status: "completed",
          summary: "resumed",
          artifacts: [],
        },
      };
    });
    const core = createCore({ runtime });
    const controller = new AbortController();
    const execution = core.startRun(
      { workflow: "agent-interrupt", task: "work" },
      { signal: controller.signal },
    );
    await active;
    controller.abort();
    const interrupted = await execution;

    expect(interrupted).toMatchObject({ kind: "interrupted", resumable: true });
    const completed = await core.continueRun({
      runId: interrupted.runId,
      action: "resume",
    });
    expect(completed).toMatchObject({ kind: "completed", summary: "resumed" });
    expect(runtime.requests).toHaveLength(2);
  });

  test("resumes a pending durable revision checkpoint", async () => {
    await writeApprovalWorkflow();
    const runtime = recordingRuntime();
    const core = createCore({ runtime });
    const waiting = await core.startRun({ workflow: "feature", task: "Build" });
    const state = await loadRun(paths.runsDir, waiting.runId);
    const revised = await applyApprovalDecision({
      workflow: (await loadNamedWorkflow(paths.workflowsDir, "feature")).workflow,
      runsRoot: paths.runsDir,
      state,
      stepId: "approve-plan",
      decision: "revise",
      feedback: "Resume this revision",
    });
    expect(revised.status).toBe("running");

    const resumed = await core.continueRun({
      runId: waiting.runId,
      action: "resume",
    });
    expect(resumed.kind).toBe("approval-required");
    expect((await loadRun(paths.runsDir, waiting.runId)).revisions?.[0]?.status)
      .toBe("resolved");
    expect(runtime.requests[1]?.prompt).toContain("Resume this revision");
  });
});

describe("AiraCore inspection and artifact access", () => {
  test("inspects explicit and latest runs", async () => {
    await writeWorkflow(
      "status",
      `
name: status
steps:
  - id: work
    uses: shell
    run: "printf status"
`,
    );
    const firstCore = createCore({
      clock: () => new Date("2026-09-06T12:00:00.000Z"),
    });
    const secondCore = createCore({
      clock: () => new Date("2026-09-06T12:00:01.000Z"),
    });
    const first = await firstCore.startRun({ workflow: "status", task: "first" });
    const second = await secondCore.startRun({ workflow: "status", task: "second" });

    expect((await firstCore.inspectRun(first.runId))?.task).toBe("first");
    expect((await firstCore.inspectRun())?.runId).toBe(second.runId);
    await expect(
      firstCore.inspectRun("20990101-000000-deadbeef"),
    ).rejects.toBeInstanceOf(CoreRunNotFoundError);
  });

  test("status remains readable when the current workflow definition is unavailable", async () => {
    await writeWorkflow(
      "durable-status",
      `
name: durable-status
steps:
  - id: work
    uses: shell
    run: "printf done"
`,
    );
    const core = createCore();
    const completed = await core.startRun({
      workflow: "durable-status",
      task: "status",
    });
    await writeFile(
      path.join(paths.workflowsDir, "durable-status.yaml"),
      "name: broken\nsteps: nope\n",
      "utf8",
    );

    const view = await core.inspectRun(completed.runId);
    expect(view).toMatchObject({
      runId: completed.runId,
      status: "completed",
      workflowAvailable: false,
    });
    expect(view?.workflowIssue).toContain("Workflow validation failed");
  });

  test("reads current and historical artifact versions and rejects unknown versions", async () => {
    await writeApprovalWorkflow();
    const core = createCore({ runtime: recordingRuntime() });
    const first = await core.startRun({ workflow: "feature", task: "Build" });
    await core.continueRun({
      runId: first.runId,
      action: "revise",
      feedback: "Revise",
    });

    const current = await core.readArtifact({
      runId: first.runId,
      name: "plan",
    });
    const historical = await core.readArtifact({
      runId: first.runId,
      name: "plan",
      version: 1,
    });
    const byPath = await core.readArtifact({
      runId: first.runId,
      name: "plan",
      path: "artifacts/plan-v1.md",
    });

    expect(current).toMatchObject({
      path: "artifacts/plan-v2.md",
      version: 2,
      isCurrent: true,
      versioned: true,
    });
    expect(historical).toMatchObject({
      path: "artifacts/plan-v1.md",
      version: 1,
      isCurrent: false,
    });
    expect(byPath.content).toBe(historical.content);
    await expect(
      core.readArtifact({
        runId: first.runId,
        name: "plan",
        version: 99,
      }),
    ).rejects.toThrow("Artifact version is not present in run state");
    await expect(
      core.readArtifact({
        runId: first.runId,
        name: "plan",
        path: "../../secret",
      }),
    ).rejects.toThrow("Artifact version is not present in run state");
  });
});
