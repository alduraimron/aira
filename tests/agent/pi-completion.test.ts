import { describe, expect, test } from "bun:test";

import {
  defineTool,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type ModelRuntime,
  type PromptOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  AgentRuntimeError,
  PiRuntime,
  type AgentStepRequest,
  type PiSession,
  type PiSessionCreationOptions,
} from "../../src/agent";

class FakeSession implements PiSession {
  readonly state: { errorMessage?: string } = {};
  readonly sessionId: string;
  finalText = "Pi finished.";
  disposeCalls = 0;
  unsubscribeCalls = 0;

  private readonly onPrompt: () => Promise<void>;
  private listener: AgentSessionEventListener | undefined;

  constructor(sessionId: string, onPrompt: () => Promise<void>) {
    this.sessionId = sessionId;
    this.onPrompt = onPrompt;
  }

  async prompt(_text: string, _options?: PromptOptions): Promise<void> {
    await this.onPrompt();
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listener = listener;
    return () => {
      this.unsubscribeCalls += 1;
      this.listener = undefined;
    };
  }

  emit(event: AgentSessionEvent): void {
    this.listener?.(event);
  }

  async abort(): Promise<void> {}

  dispose(): void {
    this.disposeCalls += 1;
  }

  getLastAssistantText(): string | undefined {
    return this.finalText;
  }
}

function request(
  overrides: Partial<AgentStepRequest> = {},
): AgentStepRequest {
  return {
    stepId: "plan",
    prompt: "Create a plan.",
    cwd: "/tmp/project",
    tools: ["read", "complete_step"],
    timeoutSeconds: 1,
    completion: { expectedArtifacts: [] },
    ...overrides,
  };
}

function runtimeWithFactory(
  factory: (options: PiSessionCreationOptions) => Promise<PiSession>,
  customTools?: ToolDefinition<any, any>[],
): PiRuntime {
  return new PiRuntime({
    modelRuntime: {} as ModelRuntime,
    sessionFactory: factory,
    customTools,
  });
}

async function callCompleteStep(
  options: PiSessionCreationOptions | undefined,
  payload: unknown,
  callId = "call-1",
): Promise<void> {
  const tool = options?.customTools?.find(
    (candidate) => candidate.name === "complete_step",
  );

  if (tool === undefined) {
    throw new Error("complete_step was not registered");
  }

  await tool.execute(
    callId,
    payload,
    undefined,
    undefined,
    {} as never,
  );
}

describe("PiRuntime completion protocol", () => {
  test("registers complete_step, merges custom tools, and preserves the allowlist", async () => {
    const otherTool = defineTool({
      name: "other_tool",
      label: "Other",
      description: "Other test tool",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    });
    let creationOptions: PiSessionCreationOptions | undefined;
    const session = new FakeSession("session-register", async () => {});
    const runtime = runtimeWithFactory(async (options) => {
      creationOptions = options;
      return session;
    }, [otherTool]);
    const tools = ["read", "grep", "complete_step"];

    const result = await runtime.runStep(request({ tools }));

    expect(creationOptions?.tools).toBe(tools);
    expect(creationOptions?.customTools?.map((tool) => tool.name)).toEqual([
      "other_tool",
      "complete_step",
    ]);
    expect(result.success).toBe(true);
    expect(result.completion).toBeUndefined();
    expect(session.disposeCalls).toBe(1);
  });

  test("returns one accepted complete_step payload", async () => {
    let creationOptions: PiSessionCreationOptions | undefined;
    const session = new FakeSession("session-complete", async () => {
      await callCompleteStep(creationOptions, {
        status: "completed",
        summary: "Created the plan.",
        artifacts: [{ name: "plan", content: "# Plan\n" }],
      });
    });
    const runtime = runtimeWithFactory(async (options) => {
      creationOptions = options;
      return session;
    });

    const result = await runtime.runStep(
      request({ completion: { expectedArtifacts: ["plan"] } }),
    );

    expect(result.success).toBe(true);
    expect(result.completion).toEqual({
      status: "completed",
      summary: "Created the plan.",
      artifacts: [{ name: "plan", content: "# Plan\n" }],
    });
    expect(result.completionError).toBeUndefined();
    expect(session.unsubscribeCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
  });

  test("leaves completion absent when the tool is never called", async () => {
    const session = new FakeSession("session-zero", async () => {});
    const runtime = runtimeWithFactory(async () => session);

    const result = await runtime.runStep(request());

    expect(result.success).toBe(true);
    expect(result.completion).toBeUndefined();
    expect(result.completionError).toBeUndefined();
  });

  test("exposes a protocol error after repeated calls", async () => {
    let creationOptions: PiSessionCreationOptions | undefined;
    const payload = {
      status: "completed",
      summary: "Done",
      artifacts: [],
    };
    const session = new FakeSession("session-repeat", async () => {
      await callCompleteStep(creationOptions, payload, "call-1");
      await callCompleteStep(creationOptions, payload, "call-2");
    });
    const runtime = runtimeWithFactory(async (options) => {
      creationOptions = options;
      return session;
    });

    const result = await runtime.runStep(request());

    expect(result.success).toBe(true);
    expect(result.completion?.summary).toBe("Done");
    expect(result.completionError).toContain("exactly once");
    expect(session.disposeCalls).toBe(1);
  });

  test("does not accept a valid call after Pi rejected an earlier call", async () => {
    let creationOptions: PiSessionCreationOptions | undefined;
    let session: FakeSession;
    session = new FakeSession("session-structural-error", async () => {
      session.emit({
        type: "tool_execution_start",
        toolCallId: "invalid-call",
        toolName: "complete_step",
        args: { status: "done" },
      } as AgentSessionEvent);
      session.emit({
        type: "tool_execution_end",
        toolCallId: "invalid-call",
        toolName: "complete_step",
        result: { content: [], details: {} },
        isError: true,
      } as AgentSessionEvent);
      session.emit({
        type: "tool_execution_start",
        toolCallId: "valid-call",
        toolName: "complete_step",
        args: {},
      } as AgentSessionEvent);
      await callCompleteStep(
        creationOptions,
        { status: "completed", summary: "Done", artifacts: [] },
        "valid-call",
      );
    });
    const runtime = runtimeWithFactory(async (options) => {
      creationOptions = options;
      return session;
    });

    const result = await runtime.runStep(request());

    expect(result.success).toBe(true);
    expect(result.completion).toBeUndefined();
    expect(result.completionError).toContain("exactly once");
    expect(result.completionError).toContain("2 calls");
  });

  test("uses fresh completion capture for each runStep call", async () => {
    let invocation = 0;
    let creationOptions: PiSessionCreationOptions | undefined;
    const runtime = runtimeWithFactory(async (options) => {
      invocation += 1;
      creationOptions = options;
      return new FakeSession(`session-${invocation}`, async () => {
        if (invocation === 1) {
          await callCompleteStep(creationOptions, {
            status: "completed",
            summary: "First",
            artifacts: [],
          });
        }
      });
    });

    const first = await runtime.runStep(request({ stepId: "first" }));
    const second = await runtime.runStep(request({ stepId: "second" }));

    expect(first.completion?.summary).toBe("First");
    expect(second.completion).toBeUndefined();
    expect(second.completionError).toBeUndefined();
  });

  test("keeps Phase 8 requests without completion unchanged", async () => {
    let creationOptions: PiSessionCreationOptions | undefined;
    const session = new FakeSession("session-phase-8", async () => {});
    const runtime = runtimeWithFactory(async (options) => {
      creationOptions = options;
      return session;
    });

    const result = await runtime.runStep(
      request({
        tools: ["read"],
        completion: undefined,
      }),
    );

    expect(creationOptions?.customTools).toBeUndefined();
    expect(creationOptions?.tools).toEqual(["read"]);
    expect(result).toEqual({
      success: true,
      sessionId: "session-phase-8",
      finalText: "Pi finished.",
      timedOut: false,
    });
  });

  test("rejects a reserved static custom-tool collision before session creation", async () => {
    const collision = defineTool({
      name: "complete_step",
      label: "Collision",
      description: "Must not override Aira",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "bad" }], details: {} };
      },
    });
    let sessionCreations = 0;
    const runtime = runtimeWithFactory(async () => {
      sessionCreations += 1;
      return new FakeSession("never", async () => {});
    }, [collision]);

    try {
      await runtime.runStep(request());
      throw new Error("expected collision rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRuntimeError);
      expect((error as AgentRuntimeError).kind).toBe("invalid-request");
      expect((error as Error).message).toContain(
        'custom tool name "complete_step" is reserved by Aira',
      );
    }

    expect(sessionCreations).toBe(0);
  });
});
