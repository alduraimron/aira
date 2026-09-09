import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { AgentRuntime } from "../../src/agent";
import {
  AiraCore,
  DirtyWorktreeError,
  type ArtifactView,
  type ProjectInfo,
  type RunBoundary,
  type RunPreview,
  type RunView,
  type WorkflowInfo,
} from "../../src/core";
import type { AiraExecutionEvent } from "../../src/executor";
import { initializeAiraProject } from "../../src/project";
import {
  AIRA_SESSION_ENTRY_TYPE,
  registerAiraPiExtension,
  type ActiveRunSessionEntry,
  type AiraCoreApi,
} from "../../src/pi/extension";

const projectRoot = "/tmp/aira-extension-project";
const otherRoot = "/tmp/other-project";
const runId = "20260906-120000-deadbeef";
const otherRunId = "20260906-120001-feedface";

interface CapturedCommand {
  description?: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

class RecordingPi {
  readonly tools = new Map<string, ToolDefinition<any, any, any>>();
  readonly commands = new Map<string, CapturedCommand>();
  readonly handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  readonly entries: Array<{ customType: string; data: unknown }> = [];

  readonly api = {
    registerTool: (tool: ToolDefinition<any, any, any>) => {
      this.tools.set(tool.name, tool);
    },
    registerCommand: (name: string, command: CapturedCommand) => {
      this.commands.set(name, command);
    },
    on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    },
    appendEntry: (customType: string, data: unknown) => {
      this.entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;

  async emit(event: string, ctx: ExtensionContext): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler({ type: event }, ctx);
    }
  }

  tool(name: string): ToolDefinition<any, any, any> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new Error(`missing tool ${name}`);
    }
    return tool;
  }
}

interface TestContextOptions {
  cwd?: string;
  hasUI?: boolean;
  trusted?: boolean;
  confirms?: boolean[];
  entries?: unknown[];
}

function createContext(options: TestContextOptions = {}) {
  const confirmationResults = [...(options.confirms ?? [])];
  const confirmations: Array<{ title: string; message: string }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const branch = options.entries ?? [];
  const ctx = {
    cwd: options.cwd ?? projectRoot,
    hasUI: options.hasUI ?? true,
    mode: options.hasUI === false ? "print" : "tui",
    sessionManager: {
      getBranch: () => branch,
    },
    isProjectTrusted: () => options.trusted ?? true,
    ui: {
      async confirm(title: string, message: string) {
        confirmations.push({ title, message });
        return confirmationResults.shift() ?? false;
      },
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, confirmations, notifications };
}

class FakeCore implements AiraCoreApi {
  project: ProjectInfo = {
    initialized: true,
    root: projectRoot,
    airaDirectory: path.join(projectRoot, ".aira"),
  };
  workflows: WorkflowInfo[] = [
    {
      name: "feature",
      description: "Plan and implement a feature",
      stepCount: 2,
      topLevelStepCount: 2,
      hasAgentSteps: true,
    },
  ];
  preview = previewFixture();
  startBoundary: RunBoundary = approvalBoundary();
  continueBoundary: RunBoundary = completedBoundary();
  artifact = artifactFixture();
  runs = new Map<string, RunView>();
  latest: RunView | undefined = approvalRunView();

  inspectProjectCalls = 0;
  initializeCalls = 0;
  listCalls = 0;
  previewCalls: Array<{ workflow: string; task: string }> = [];
  startCalls: Array<{
    input: {
      workflow: string;
      task: string;
      allowDirty?: boolean;
      expectedPreparationToken?: string;
    };
    signal?: AbortSignal;
  }> = [];
  inspectRunCalls: Array<string | undefined> = [];
  continueCalls: Array<{ input: unknown; signal?: AbortSignal }> = [];
  artifactCalls: unknown[] = [];
  startEvents: AiraExecutionEvent[] = [];
  continueEvents: AiraExecutionEvent[] = [];
  startError?: Error;

  async inspectProject(): Promise<ProjectInfo> {
    this.inspectProjectCalls += 1;
    return this.project;
  }

  async initializeProject(): Promise<ProjectInfo> {
    this.initializeCalls += 1;
    return { ...this.project, initialized: true, created: true } as ProjectInfo;
  }

  async listWorkflows(): Promise<WorkflowInfo[]> {
    this.listCalls += 1;
    return this.workflows;
  }

  async previewRun(input: { workflow: string; task: string }): Promise<RunPreview> {
    this.previewCalls.push(input);
    return { ...this.preview, task: input.task, workflow: { ...this.preview.workflow, name: input.workflow } };
  }

  async startRun(
    input: {
      workflow: string;
      task: string;
      allowDirty?: boolean;
      expectedPreparationToken?: string;
    },
    execution?: {
      signal?: AbortSignal;
      onEvent?: (event: AiraExecutionEvent) => void;
    },
  ): Promise<RunBoundary> {
    this.startCalls.push({ input, signal: execution?.signal });
    if (this.startError !== undefined) {
      throw this.startError;
    }
    for (const event of this.startEvents) {
      execution?.onEvent?.(event);
    }
    return this.startBoundary;
  }

  async inspectRun(requestedRunId?: string): Promise<RunView | undefined> {
    this.inspectRunCalls.push(requestedRunId);
    if (requestedRunId !== undefined) {
      return this.runs.get(requestedRunId);
    }
    return this.latest;
  }

  async continueRun(
    input: any,
    execution?: {
      signal?: AbortSignal;
      onEvent?: (event: AiraExecutionEvent) => void;
    },
  ): Promise<RunBoundary> {
    this.continueCalls.push({ input, signal: execution?.signal });
    for (const event of this.continueEvents) {
      execution?.onEvent?.(event);
    }
    return this.continueBoundary;
  }

  async readArtifact(input: any): Promise<ArtifactView> {
    this.artifactCalls.push(input);
    return this.artifact;
  }
}

function previewFixture(): RunPreview {
  return {
    projectRoot,
    preparationToken: "preview-token",
    workflow: {
      name: "feature",
      description: "Plan and implement a feature",
      stepCount: 2,
      topLevelStepCount: 2,
      hasAgentSteps: true,
    },
    task: "brief",
    hasAgentSteps: true,
    steps: [
      {
        id: "plan",
        type: "agent",
        command: "plan",
        agent: {
          timeoutSeconds: 60,
          technicalRetries: 1,
          tools: ["read", "complete_step"],
        },
      },
      {
        id: "approve-plan",
        type: "approval",
        approvalArtifact: "plan",
        revisionTargetStepId: "plan",
      },
    ],
  };
}

function artifactMetadata() {
  return {
    name: "plan",
    currentPath: "artifacts/plan-v1.md",
    versioned: true,
    versionCount: 1,
    versions: [
      { path: "artifacts/plan-v1.md", isCurrent: true, version: 1 },
    ],
    producerStepId: "plan",
  };
}

function approvalBoundary(id = runId): RunBoundary {
  return {
    kind: "approval-required",
    runId: id,
    workflow: "feature",
    checkpointToken: `checkpoint-${id}`,
    status: "waiting",
    summary: "Waiting for approval at plan.",
    currentStep: {
      id: "approve-plan",
      type: "approval",
      status: "waiting",
      attempt: 0,
    },
    allowedActions: ["approve", "revise", "cancel"],
    artifacts: [artifactMetadata()],
    approval: {
      stepId: "approve-plan",
      message: "Approve this plan?",
      revisionTargetStepId: "plan",
      allowedDecisions: ["approve", "revise", "cancel"],
      artifact: {
        ...artifactMetadata(),
        available: true,
        content: "# Plan\n\nUse the current session ID.\n",
      },
    },
  };
}

function completedBoundary(id = runId): RunBoundary {
  return {
    kind: "completed",
    runId: id,
    workflow: "feature",
    checkpointToken: `checkpoint-${id}`,
    status: "completed",
    summary: "Implementation complete.",
    allowedActions: [],
    artifacts: [artifactMetadata()],
  };
}

function interruptedBoundary(id = runId): RunBoundary {
  return {
    kind: "interrupted",
    runId: id,
    workflow: "feature",
    checkpointToken: `checkpoint-${id}`,
    status: "interrupted",
    summary: "Interrupted at implement.",
    currentStep: {
      id: "implement",
      type: "agent",
      status: "interrupted",
      attempt: 1,
    },
    allowedActions: ["resume"],
    artifacts: [artifactMetadata()],
    resumable: true,
  };
}

function runViewFromBoundary(boundary: RunBoundary): RunView {
  return {
    runId: boundary.runId,
    workflow: boundary.workflow,
    checkpointToken: boundary.checkpointToken,
    status: boundary.status,
    task: "brief",
    startedAt: "2026-09-06T12:00:00.000Z",
    updatedAt: "2026-09-06T12:01:00.000Z",
    summary: boundary.summary,
    ...(boundary.currentStep === undefined
      ? {}
      : {
          currentStep: {
            ...boundary.currentStep,
          },
        }),
    steps: [
      { id: "plan", type: "agent", status: "completed", attempt: 1 },
      ...(boundary.currentStep === undefined
        ? []
        : [{ ...boundary.currentStep }]),
    ],
    artifacts: boundary.artifacts,
    allowedActions: boundary.allowedActions,
    resumable:
      boundary.kind === "interrupted" ? boundary.resumable : false,
    workflowAvailable: true,
    boundary,
  };
}

function approvalRunView(id = runId): RunView {
  return runViewFromBoundary(approvalBoundary(id));
}

function interruptedRunView(id = runId): RunView {
  return runViewFromBoundary(interruptedBoundary(id));
}

function artifactFixture(content = "# Plan\n\nComplete artifact.\n"): ArtifactView {
  return {
    runId,
    workflow: "feature",
    name: "plan",
    path: "artifacts/plan-v1.md",
    content,
    byteLength: Buffer.byteLength(content),
    lineCount: content.split("\n").length,
    isCurrent: true,
    versioned: true,
    version: 1,
    versions: artifactMetadata().versions,
  };
}

function setup(core: FakeCore) {
  const pi = new RecordingPi();
  registerAiraPiExtension(pi.api, { createCore: () => core });
  return pi;
}

async function executeTool(
  pi: RecordingPi,
  name: string,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  options: {
    signal?: AbortSignal;
    onUpdate?: (result: AgentToolResult<any>) => void;
  } = {},
): Promise<AgentToolResult<any>> {
  return await pi.tool(name).execute(
    `call-${name}`,
    params,
    options.signal,
    options.onUpdate,
    ctx,
  );
}

function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
}

describe("Aira Pi extension registration", () => {
  test("registers all typed tools and the read-only command", () => {
    const pi = setup(new FakeCore());

    expect([...pi.tools.keys()]).toEqual([
      "aira_project",
      "aira_init",
      "aira_start",
      "aira_status",
      "aira_continue",
      "aira_artifact",
    ]);
    expect(pi.commands.has("aira")).toBe(true);
    expect(pi.tool("aira_start").parameters).toMatchObject({
      type: "object",
      required: ["workflow", "task"],
    });
    expect(pi.tool("aira_continue").parameters).toMatchObject({
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["approve", "revise", "cancel", "resume"],
        },
      },
    });
    expect(pi.tool("aira_artifact").parameters).toMatchObject({
      type: "object",
      required: ["name"],
    });
    expect(pi.tool("aira_start").description).toContain("execution brief");
    expect(pi.tool("aira_continue").description).toContain("Never call approve automatically");
  });
});

describe("Aira Pi read-only tools", () => {
  test("inspects initialized and uninitialized projects without authorization", async () => {
    const core = new FakeCore();
    const pi = setup(core);
    const context = createContext({ confirms: [true] });
    const initialized = await executeTool(pi, "aira_project", {}, context.ctx);

    expect(resultText(initialized)).toContain("Workflows (1): feature");
    expect(resultText(initialized)).toContain("Plan and implement a feature");
    expect(context.confirmations).toHaveLength(0);

    core.project = { initialized: false, root: projectRoot };
    const uninitialized = await executeTool(pi, "aira_project", {}, context.ctx);
    expect(resultText(uninitialized)).toContain("not initialized");
    expect(core.listCalls).toBe(1);
  });

  test("status uses explicit ID, session association, then latest", async () => {
    const explicit = approvalRunView(otherRunId);
    const associated = approvalRunView(runId);
    const latest = approvalRunView("20260906-120002-cafebabe");

    const explicitCore = new FakeCore();
    explicitCore.runs.set(otherRunId, explicit);
    explicitCore.latest = latest;
    const explicitPi = setup(explicitCore);
    const explicitContext = createContext();
    await executeTool(
      explicitPi,
      "aira_status",
      { runId: otherRunId },
      explicitContext.ctx,
    );
    expect(explicitCore.inspectRunCalls).toEqual([otherRunId]);

    const sessionCore = new FakeCore();
    sessionCore.runs.set(runId, associated);
    sessionCore.latest = latest;
    const sessionPi = setup(sessionCore);
    const entry: ActiveRunSessionEntry = {
      version: 1,
      projectRoot,
      runId,
      active: true,
    };
    const sessionContext = createContext({
      entries: [
        {
          type: "custom",
          customType: AIRA_SESSION_ENTRY_TYPE,
          data: entry,
        },
      ],
    });
    await sessionPi.emit("session_start", sessionContext.ctx);
    const sessionStatus = await executeTool(
      sessionPi,
      "aira_status",
      {},
      sessionContext.ctx,
    );
    expect(sessionCore.inspectRunCalls).toEqual([runId]);
    expect((sessionStatus.details as any).source).toBe("session");

    const latestCore = new FakeCore();
    latestCore.latest = latest;
    const latestPi = setup(latestCore);
    const latestContext = createContext({
      entries: [
        {
          type: "custom",
          customType: AIRA_SESSION_ENTRY_TYPE,
          data: { ...entry, projectRoot: otherRoot },
        },
      ],
    });
    await latestPi.emit("session_start", latestContext.ctx);
    const latestStatus = await executeTool(
      latestPi,
      "aira_status",
      {},
      latestContext.ctx,
    );
    expect(latestCore.inspectRunCalls).toEqual([undefined]);
    expect((latestStatus.details as any).source).toBe("latest");
    expect(latestContext.confirmations).toHaveLength(0);
  });

  test("reads known artifact versions without authorization", async () => {
    const core = new FakeCore();
    core.latest = approvalRunView();
    const pi = setup(core);
    const context = createContext({ confirms: [true] });
    const result = await executeTool(
      pi,
      "aira_artifact",
      { name: "plan", version: 1 },
      context.ctx,
    );

    expect(core.artifactCalls).toEqual([{ runId, name: "plan", version: 1 }]);
    expect(resultText(result)).toContain("Complete artifact");
    expect(context.confirmations).toHaveLength(0);
  });

  test("bounds and paginates large artifacts with explicit truncation", async () => {
    const content = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n");
    const core = new FakeCore();
    core.latest = approvalRunView();
    core.artifact = artifactFixture(content);
    const pi = setup(core);
    const context = createContext();
    const first = await executeTool(
      pi,
      "aira_artifact",
      { name: "plan" },
      context.ctx,
    );

    expect(resultText(first)).toContain("Artifact output truncated");
    expect((first.details as any).truncated).toBe(true);
    const nextStartLine = (first.details as any).nextStartLine as number;
    expect(nextStartLine).toBeGreaterThan(1);
    expect(resultText(first)).toContain(`Next page: startLine ${nextStartLine}`);
    expect(resultText(first)).not.toContain("line 2500");

    const second = await executeTool(
      pi,
      "aira_artifact",
      { name: "plan", startLine: nextStartLine, maxLines: 600 },
      context.ctx,
    );
    expect(resultText(second)).toContain("line 2500");
    expect((second.details as any).truncated).toBe(false);
  });

  test("large single-line artifacts get an explicit bounded line preview", async () => {
    const core = new FakeCore();
    core.latest = approvalRunView();
    core.artifact = artifactFixture("x".repeat(100_000));
    const pi = setup(core);
    const result = await executeTool(
      pi,
      "aira_artifact",
      { name: "plan" },
      createContext().ctx,
    );
    const text = resultText(result);

    expect(text).toContain("only a preview");
    expect(text).toContain("exceeds the per-call byte limit");
    expect(Buffer.byteLength(text)).toBeLessThan(50 * 1024);
    expect((result.details as any).truncated).toBe(true);
  });

  test("the /aira command reports compact status without mutation", async () => {
    const core = new FakeCore();
    const pi = setup(core);
    const context = createContext();
    await pi.commands.get("aira")?.handler("", context.ctx);

    expect(context.notifications[0]?.message).toContain("Workflows (1): feature");
    expect(context.notifications[0]?.message).toContain("Next: approve, revise, cancel");
    expect(context.confirmations).toHaveLength(0);
  });
});

describe("Aira Pi authorization", () => {
  test("initialization runs only after accepted authorization", async () => {
    const acceptedCore = new FakeCore();
    acceptedCore.project = { initialized: false, root: projectRoot };
    const acceptedPi = setup(acceptedCore);
    const acceptedContext = createContext({ confirms: [true] });
    const accepted = await executeTool(
      acceptedPi,
      "aira_init",
      {},
      acceptedContext.ctx,
    );
    expect(acceptedCore.initializeCalls).toBe(1);
    expect(resultText(accepted)).toContain("Initialized Aira");
    expect(acceptedContext.confirmations).toHaveLength(1);
    expect(acceptedContext.confirmations[0]?.title).toContain("Initialize Aira");
    expect(acceptedContext.confirmations[0]?.message).toContain(projectRoot);
    expect(acceptedContext.confirmations[0]?.message).toContain("Create .aira");

    const rejectedCore = new FakeCore();
    rejectedCore.project = { initialized: false, root: projectRoot };
    const rejectedPi = setup(rejectedCore);
    const rejectedContext = createContext({ confirms: [false] });
    const rejected = await executeTool(
      rejectedPi,
      "aira_init",
      {},
      rejectedContext.ctx,
    );
    expect(rejectedCore.initializeCalls).toBe(0);
    expect((rejected.details as any).reason).toBe("rejected");
  });

  test("initialized projects remain a no-op after authorization", async () => {
    const core = new FakeCore();
    const pi = setup(core);
    const context = createContext({ confirms: [true] });
    const result = await executeTool(pi, "aira_init", {}, context.ctx);

    expect(core.initializeCalls).toBe(0);
    expect(resultText(result)).toContain("already initialized");
    expect(resultText(result)).toContain("no files were changed");
  });

  test("start keeps review detail out of its compact rejected authorization", async () => {
    const core = new FakeCore();
    const pi = setup(core);
    const context = createContext({ confirms: [false] });
    const brief =
      "Goal\n\nImplement rotation.\n\nDetailed context\n\n" +
      "LONG-BRIEF-DETAIL ".repeat(300) +
      "\n\nNon-goals\n\nNo family ID.";
    const updates: AgentToolResult<any>[] = [];
    const result = await executeTool(
      pi,
      "aira_start",
      { workflow: "feature", task: brief, allowDirty: true },
      context.ctx,
      { onUpdate: (update) => updates.push(update) },
    );

    expect(core.previewCalls).toEqual([{ workflow: "feature", task: brief }]);
    expect(core.startCalls).toHaveLength(0);
    expect(context.confirmations).toHaveLength(1);
    expect(context.confirmations[0]?.message).not.toContain(brief);
    expect(context.confirmations[0]?.message).toContain(projectRoot);
    expect(context.confirmations[0]?.message).toContain("Workflow: feature");
    expect(context.confirmations[0]?.message).toContain("Steps: 2");
    expect(context.confirmations[0]?.message).toContain(
      "Confirming creates and starts a new Aira run",
    );
    expect(context.confirmations[0]?.message).toContain(
      "Brief summary truncated",
    );
    expect((context.confirmations[0]?.message ?? "").length).toBeLessThan(1_000);
    expect(updates.some((update) => resultText(update).includes(brief))).toBe(
      true,
    );
    expect((result.details as any).reason).toBe("rejected");
  });

  test("accepted start passes the brief, dirty choice, signal, and progress events", async () => {
    const core = new FakeCore();
    core.startEvents = [
      { type: "step.started", stepId: "plan", stepType: "agent" },
      {
        type: "agent.tool.started",
        stepId: "plan",
        tool: "read",
        summary: "read src/auth.ts",
      },
    ];
    const pi = setup(core);
    const context = createContext({ confirms: [true] });
    const controller = new AbortController();
    const updates: AgentToolResult<any>[] = [];
    const brief =
      "Goal\n\nImplement token rotation.\n\nAcceptance criteria\n\n" +
      "Preserve the exact agreed behavior. ".repeat(100);
    const result = await executeTool(
      pi,
      "aira_start",
      { workflow: "feature", task: brief, allowDirty: true },
      context.ctx,
      {
        signal: controller.signal,
        onUpdate: (update) => updates.push(update),
      },
    );

    expect(core.startCalls[0]).toEqual({
      input: {
        workflow: "feature",
        task: brief,
        allowDirty: true,
        expectedPreparationToken: "preview-token",
      },
      signal: controller.signal,
    });
    expect(updates.some((update) => resultText(update).includes("read src/auth.ts")))
      .toBe(true);
    expect(context.confirmations[0]?.message).not.toContain(brief);
    expect(context.confirmations[0]?.message).toContain("Workflow: feature");
    expect(context.confirmations[0]?.message).toContain(projectRoot);
    expect(resultText(result)).toContain("approval-required");
    expect(resultText(result)).toContain("Use the current session ID.");
    expect(pi.entries).toEqual([
      {
        customType: AIRA_SESSION_ENTRY_TYPE,
        data: { version: 1, projectRoot, runId, active: true },
      },
    ]);
  });

  test("start forwards Core errors as useful tool errors", async () => {
    const core = new FakeCore();
    core.startError = new DirtyWorktreeError(projectRoot);
    const pi = setup(core);
    const context = createContext({ confirms: [true] });

    await expect(
      executeTool(
        pi,
        "aira_start",
        { workflow: "feature", task: "brief" },
        context.ctx,
      ),
    ).rejects.toThrow("dirty-worktree");
  });

  test("tool errors use Aira's operator-safe redaction", async () => {
    const core = new FakeCore();
    core.startError = new Error("API_TOKEN=super-secret-value");
    const pi = setup(core);
    const context = createContext({ confirms: [true] });

    try {
      await executeTool(
        pi,
        "aira_start",
        { workflow: "feature", task: "brief" },
        context.ctx,
      );
    } catch (error) {
      expect(String(error)).toContain("API_TOKEN=[redacted]");
      expect(String(error)).not.toContain("super-secret-value");
      return;
    }

    throw new Error("expected a redacted tool error");
  });

  test("mutations fail closed for an untrusted project", async () => {
    const core = new FakeCore();
    const pi = setup(core);
    const context = createContext({ trusted: false, confirms: [true] });
    const result = await executeTool(
      pi,
      "aira_start",
      { workflow: "feature", task: "brief" },
      context.ctx,
    );

    expect((result.details as any).reason).toBe("untrusted-project");
    expect(context.confirmations).toHaveLength(0);
    expect(core.startCalls).toHaveLength(0);
  });

  test("all mutations fail closed when interactive authorization is unavailable", async () => {
    const core = new FakeCore();
    core.runs.set(runId, approvalRunView());
    core.latest = approvalRunView();
    const pi = setup(core);
    const context = createContext({ hasUI: false });

    const init = await executeTool(pi, "aira_init", {}, context.ctx);
    const start = await executeTool(
      pi,
      "aira_start",
      { workflow: "feature", task: "brief" },
      context.ctx,
    );
    const continued = await executeTool(
      pi,
      "aira_continue",
      { runId, action: "approve" },
      context.ctx,
    );

    expect((init.details as any).reason).toBe("unavailable");
    expect((start.details as any).reason).toBe("unavailable");
    expect((continued.details as any).reason).toBe("unavailable");
    expect(core.initializeCalls).toBe(0);
    expect(core.startCalls).toHaveLength(0);
    expect(core.continueCalls).toHaveLength(0);
  });
});

describe("Aira Pi continuation", () => {
  test.each([
    ["approve", approvalRunView(), undefined],
    ["cancel", approvalRunView(), undefined],
    ["resume", interruptedRunView(), undefined],
    ["revise", approvalRunView(), "Use the existing session ID"],
  ] as const)(
    "authorizes and submits %s with exact parameters",
    async (action, view, feedback) => {
      const core = new FakeCore();
      core.runs.set(runId, view);
      core.latest = view;
      core.continueBoundary =
        action === "resume" ? approvalBoundary() : completedBoundary();
      const pi = setup(core);
      const context = createContext({ confirms: [true] });
      const controller = new AbortController();
      const params = {
        runId,
        action,
        ...(feedback === undefined ? {} : { feedback }),
      };
      await executeTool(pi, "aira_continue", params, context.ctx, {
        signal: controller.signal,
      });

      expect(core.continueCalls[0]).toEqual({
        input: {
          runId,
          action,
          ...(feedback === undefined ? {} : { feedback }),
          expectedBoundaryToken: `checkpoint-${runId}`,
        },
        signal: controller.signal,
      });
      expect(context.confirmations).toHaveLength(1);
      if (action === "approve") {
        expect(context.confirmations[0]?.message).toContain("Approve this plan");
        expect(context.confirmations[0]?.message).toContain("Artifact: plan");
        expect(context.confirmations[0]?.message).toContain(
          "Artifact path: artifacts/plan-v1.md",
        );
        expect(context.confirmations[0]?.message).toContain(
          "Artifact version: 1",
        );
        expect(context.confirmations[0]?.message).toContain(
          "continues Aira execution",
        );
        expect(context.confirmations[0]?.message).not.toContain(
          "Use the current session ID.",
        );
        expect((context.confirmations[0]?.message ?? "").length).toBeLessThan(
          1_000,
        );
      }
      if (action === "revise") {
        expect(context.confirmations[0]?.message).toEndWith(feedback ?? "");
        expect(context.confirmations[0]?.message).not.toContain(
          "Revision feedback preview (truncated)",
        );
      }
      if (action === "resume") {
        expect(context.confirmations[0]?.message).toContain("implement");
        expect(context.confirmations[0]?.message).toContain(
          "fresh worker session",
        );
      }
      if (action === "cancel") {
        expect(context.confirmations[0]?.message).toContain(runId);
        expect(context.confirmations[0]?.message).toContain(
          "records Aira's existing cancel decision",
        );
      }
    },
  );

  test("large revision feedback is previewed but submitted to Core unchanged", async () => {
    const core = new FakeCore();
    core.runs.set(runId, approvalRunView());
    const pi = setup(core);
    const context = createContext({ confirms: [true] });
    const feedback =
      "  BEGIN EXACT FEEDBACK\n" +
      Array.from(
        { length: 80 },
        (_, index) => `Requirement ${index + 1}: preserve behavior exactly.`,
      ).join("\n") +
      "\nEND EXACT FEEDBACK  ";

    await executeTool(
      pi,
      "aira_continue",
      { runId, action: "revise", feedback },
      context.ctx,
    );

    const message = context.confirmations[0]?.message ?? "";
    expect(message).not.toContain(feedback);
    expect(message).toContain("Revision feedback preview (truncated)");
    expect(message).toContain("Preview truncated:");
    expect(message).toContain(
      "Confirming submits the exact unmodified feedback, not only this preview.",
    );
    expect(message).toContain("BEGIN EXACT FEEDBACK");
    expect(message).not.toContain("END EXACT FEEDBACK");
    expect(message.split("\n").length).toBeLessThanOrEqual(22);
    expect(Buffer.byteLength(message, "utf8")).toBeLessThan(4 * 1024);
    expect(core.continueCalls).toHaveLength(1);
    expect((core.continueCalls[0]?.input as any).feedback).toBe(feedback);
    expect((core.continueCalls[0]?.input as any).expectedBoundaryToken).toBe(
      `checkpoint-${runId}`,
    );
  });

  test("rejected continuation does not call Core", async () => {
    const core = new FakeCore();
    core.runs.set(runId, approvalRunView());
    const pi = setup(core);
    const context = createContext({ confirms: [false] });
    const result = await executeTool(
      pi,
      "aira_continue",
      { runId, action: "approve" },
      context.ctx,
    );

    expect(core.continueCalls).toHaveLength(0);
    expect((result.details as any).reason).toBe("rejected");
  });

  test("explicit continuation overrides a restored active run", async () => {
    const core = new FakeCore();
    core.runs.set(runId, approvalRunView());
    core.runs.set(otherRunId, approvalRunView(otherRunId));
    const pi = setup(core);
    const context = createContext({
      confirms: [true],
      entries: [
        {
          type: "custom",
          customType: AIRA_SESSION_ENTRY_TYPE,
          data: { version: 1, projectRoot, runId, active: true },
        },
      ],
    });
    await pi.emit("session_start", context.ctx);
    await executeTool(
      pi,
      "aira_continue",
      { runId: otherRunId, action: "approve" },
      context.ctx,
    );

    expect(core.inspectRunCalls).toEqual([otherRunId]);
    expect((core.continueCalls[0]?.input as any).runId).toBe(otherRunId);
  });

  test("terminal continuation clears the persisted active association", async () => {
    const core = new FakeCore();
    core.runs.set(runId, approvalRunView());
    core.continueBoundary = completedBoundary();
    const pi = setup(core);
    const context = createContext({ confirms: [true] });
    await executeTool(
      pi,
      "aira_continue",
      { runId, action: "approve" },
      context.ctx,
    );

    expect(pi.entries.at(-1)?.data).toEqual({
      version: 1,
      projectRoot,
      runId,
      active: false,
    });
  });

  test("rejects empty revision feedback before authorization", async () => {
    const core = new FakeCore();
    core.runs.set(runId, approvalRunView());
    const pi = setup(core);
    const context = createContext({ confirms: [true] });

    await expect(
      executeTool(
        pi,
        "aira_continue",
        { runId, action: "revise", feedback: "   " },
        context.ctx,
      ),
    ).rejects.toThrow("invalid-revision-feedback");
    expect(context.confirmations).toHaveLength(0);
    expect(core.continueCalls).toHaveLength(0);
  });
});

describe("Aira Pi local integration", () => {
  test("loads tools and completes a model-free fake-worker lifecycle", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aira-pi-smoke-"));

    try {
      const paths = (await initializeAiraProject(directory)).paths;
      await writeFile(
        path.join(paths.commandsDir, "smoke.md"),
        "Create a smoke artifact for {{ input.task }}.",
        "utf8",
      );
      await writeFile(
        path.join(paths.workflowsDir, "smoke.yaml"),
        `name: smoke\ndescription: Model-free extension smoke workflow\nsteps:\n  - id: create\n    uses: agent\n    command: smoke\n    artifact:\n      name: smoke\n      filename: smoke.md\n  - id: approve\n    uses: approval\n    artifact: smoke\n    message: Approve smoke?\n  - id: finish\n    uses: shell\n    run: "printf finished"\n`,
        "utf8",
      );
      const runtime: AgentRuntime = {
        async runStep(request) {
          return {
            success: true,
            sessionId: "fake-worker",
            finalText: "fake worker complete",
            timedOut: false,
            completion: {
              status: "completed",
              summary: "smoke artifact created",
              artifacts: [{ name: "smoke", content: "# Smoke\n\nReady.\n" }],
            },
          };
        },
      };
      const pi = new RecordingPi();
      registerAiraPiExtension(pi.api, {
        createCore: (cwd) =>
          new AiraCore({ cwd, agentRuntimeFactory: () => runtime }),
      });
      const context = createContext({ cwd: directory, confirms: [true, true] });

      const project = await executeTool(pi, "aira_project", {}, context.ctx);
      expect(resultText(project)).toContain("smoke");

      const started = await executeTool(
        pi,
        "aira_start",
        { workflow: "smoke", task: "Exercise the extension", allowDirty: true },
        context.ctx,
      );
      expect(resultText(started)).toContain("approval-required");
      expect(resultText(started)).toContain("# Smoke");

      const artifact = await executeTool(
        pi,
        "aira_artifact",
        { name: "smoke" },
        context.ctx,
      );
      expect(resultText(artifact)).toContain("Ready.");

      const completed = await executeTool(
        pi,
        "aira_continue",
        { action: "approve" },
        context.ctx,
      );
      expect(resultText(completed)).toContain("Boundary: completed");

      const status = await executeTool(
        pi,
        "aira_status",
        {},
        context.ctx,
      );
      expect(resultText(status)).toContain("Status: completed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Aira Pi rendering", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const renderContext = {
    args: {},
    toolCallId: "call",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: projectRoot,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  };

  test("renders partial progress, approval, artifact, and degraded errors", async () => {
    const core = new FakeCore();
    const pi = setup(core);
    const start = pi.tool("aira_start");
    const partial = {
      content: [{ type: "text", text: "Aira · feature\n◉ plan" }],
      details: { kind: "progress", workflow: "feature" },
    } as AgentToolResult<any>;
    const partialText = start
      .renderResult?.(
        partial,
        { expanded: false, isPartial: true },
        theme,
        renderContext as any,
      )
      .render(120)
      .join("\n");
    expect(partialText).toContain("Aira · feature");

    const reviewBrief = "FULL EXECUTION BRIEF FOR EXPANDED REVIEW";
    const collapsedCall = start
      .renderCall?.(
        { workflow: "feature", task: reviewBrief, allowDirty: false },
        theme,
        renderContext as any,
      )
      .render(120)
      .join("\n");
    const expandedCall = start
      .renderCall?.(
        { workflow: "feature", task: reviewBrief, allowDirty: false },
        theme,
        { ...renderContext, expanded: true } as any,
      )
      .render(120)
      .join("\n");
    expect(collapsedCall).not.toContain(reviewBrief);
    expect(expandedCall).toContain(reviewBrief);

    const preview = {
      content: [{ type: "text", text: `Execution brief:\n${reviewBrief}` }],
      details: { kind: "preview", preview: previewFixture() },
    } as AgentToolResult<any>;
    const collapsedPreview = start
      .renderResult?.(
        preview,
        { expanded: false, isPartial: true },
        theme,
        renderContext as any,
      )
      .render(120)
      .join("\n");
    const expandedPreview = start
      .renderResult?.(
        preview,
        { expanded: true, isPartial: true },
        theme,
        { ...renderContext, expanded: true, isPartial: true } as any,
      )
      .render(120)
      .join("\n");
    expect(collapsedPreview).not.toContain(reviewBrief);
    expect(expandedPreview).toContain(reviewBrief);

    const boundary = await executeTool(
      pi,
      "aira_start",
      { workflow: "feature", task: "brief" },
      createContext({ confirms: [true] }).ctx,
    );
    const boundaryText = start
      .renderResult?.(
        boundary,
        { expanded: false, isPartial: false },
        theme,
        renderContext as any,
      )
      .render(120)
      .join("\n");
    expect(boundaryText).toContain("approval-required");

    core.runs.set(runId, approvalRunView());
    const revised = await executeTool(
      pi,
      "aira_continue",
      { runId, action: "revise", feedback: "Tighten the plan" },
      createContext({ confirms: [true] }).ctx,
    );
    const revisedText = pi
      .tool("aira_continue")
      .renderResult?.(
        revised,
        { expanded: false, isPartial: false },
        theme,
        renderContext as any,
      )
      .render(120)
      .join("\n");
    expect(revisedText).toContain("revision submitted");

    const artifact = await executeTool(
      pi,
      "aira_artifact",
      { name: "plan" },
      createContext().ctx,
    );
    const artifactText = pi
      .tool("aira_artifact")
      .renderResult?.(
        artifact,
        { expanded: true, isPartial: false },
        theme,
        renderContext as any,
      )
      .render(120)
      .join("\n");
    expect(artifactText).toContain("plan · lines");

    const degraded = {
      content: [{ type: "text", text: "Core failed clearly" }],
      details: undefined,
    } as AgentToolResult<any>;
    const degradedText = start
      .renderResult?.(
        degraded,
        { expanded: false, isPartial: false },
        theme,
        { ...renderContext, isError: true } as any,
      )
      .render(120)
      .join("\n");
    expect(degradedText).toContain("Core failed clearly");
  });
});
