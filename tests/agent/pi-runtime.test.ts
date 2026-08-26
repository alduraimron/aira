import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SettingsManager,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type ModelRuntime,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent";

import {
  AgentRuntimeError,
  createFreshPiSession,
  PiRuntime,
  type AgentRuntime,
  type AgentStepRequest,
  type PiRuntimeOptions,
  type PiSession,
  type PiSessionCreationOptions,
} from "../../src/agent";
import { createAiraResourceLoader } from "../../src/agent/pi/resources";

type PiModel = NonNullable<PiSessionCreationOptions["model"]>;
type PromptBehavior = (
  session: FakePiSession,
  prompt: string,
  options: PromptOptions | undefined,
) => Promise<void>;

const fakeModel = {
  provider: "test-provider",
  id: "test-model",
  name: "Test model",
} as PiModel;
const fakeModelRuntime = {} as ModelRuntime;

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-agent-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

class FakePiSession implements PiSession {
  readonly sessionId: string;
  readonly state: { errorMessage?: string } = {};
  readonly promptCalls: Array<{
    text: string;
    options: PromptOptions | undefined;
  }> = [];
  abortCalls = 0;
  disposeCalls = 0;
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  finalText: string | undefined;

  private readonly behavior: PromptBehavior;
  private listener: AgentSessionEventListener | undefined;

  constructor(
    sessionId: string,
    behavior: PromptBehavior = async () => {},
  ) {
    this.sessionId = sessionId;
    this.behavior = behavior;
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    this.promptCalls.push({ text, options });
    await this.behavior(this, text, options);
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.subscribeCalls += 1;
    this.listener = listener;
    let active = true;

    return () => {
      if (!active) {
        return;
      }

      active = false;
      this.unsubscribeCalls += 1;
      this.listener = undefined;
    };
  }

  emit(event: AgentSessionEvent): void {
    this.listener?.(event);
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  getLastAssistantText(): string | undefined {
    return this.finalText;
  }
}

function baseRequest(
  overrides: Partial<AgentStepRequest> = {},
): AgentStepRequest {
  return {
    stepId: "plan",
    prompt: "Inspect this repository exactly as written: λ",
    cwd: directory,
    timeoutSeconds: 1,
    ...overrides,
  };
}

function successfulSession(
  sessionId: string,
  finalText = "Inspection complete.",
): FakePiSession {
  return new FakePiSession(sessionId, async (session) => {
    const message = assistantMessage(finalText);
    session.finalText = finalText;
    session.emit({ type: "agent_start" });
    session.emit({
      type: "message_end",
      message,
    } as unknown as AgentSessionEvent);
    session.emit({
      type: "agent_end",
      messages: [message],
      willRetry: false,
    } as unknown as AgentSessionEvent);
  });
}

function createRuntime(
  sessionFactory: (options: PiSessionCreationOptions) => Promise<PiSession>,
  options: PiRuntimeOptions = {},
): PiRuntime {
  return new PiRuntime({
    modelRuntime: fakeModelRuntime,
    modelResolver: () => ({
      model: fakeModel,
      thinkingLevel: undefined,
      warning: undefined,
      error: undefined,
    }),
    ...options,
    sessionFactory,
  });
}

function assistantMessage(
  text: string,
  stopReason = "stop",
  errorMessage?: string,
): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "test-provider",
    model: "test-model",
    stopReason,
    errorMessage,
  };
}

async function getRuntimeError(
  operation: () => Promise<unknown>,
): Promise<AgentRuntimeError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError);
    return error as AgentRuntimeError;
  }

  throw new Error("expected AgentRuntimeError");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("PiRuntime session boundary", () => {
  test("implements AgentRuntime", async () => {
    const session = successfulSession("session-1");
    const runtime: AgentRuntime = createRuntime(async () => session);

    const result = await runtime.runStep(baseRequest());

    expect(result).toEqual({
      success: true,
      sessionId: "session-1",
      finalText: "Inspection complete.",
      timedOut: false,
    });
  });

  test("creates one fresh session per runStep call", async () => {
    const sessions = [
      successfulSession("session-a", "first"),
      successfulSession("session-b", "second"),
    ];
    let creationCount = 0;
    const runtime = createRuntime(async () => sessions[creationCount++]!);

    const first = await runtime.runStep(baseRequest({ stepId: "first" }));
    const second = await runtime.runStep(baseRequest({ stepId: "second" }));

    expect(creationCount).toBe(2);
    expect(first.sessionId).toBe("session-a");
    expect(second.sessionId).toBe("session-b");
    expect(sessions[0]).not.toBe(sessions[1]);
    expect(sessions[0]?.disposeCalls).toBe(1);
    expect(sessions[1]?.disposeCalls).toBe(1);
  });

  test("reuses one lazily-created model runtime", async () => {
    const sessions = [successfulSession("one"), successfulSession("two")];
    let runtimeCreations = 0;
    let sessionCreations = 0;
    const runtime = new PiRuntime({
      modelRuntimeFactory: async () => {
        runtimeCreations += 1;
        return fakeModelRuntime;
      },
      sessionFactory: async () => sessions[sessionCreations++]!,
    });

    await runtime.runStep(baseRequest({ stepId: "one" }));
    await runtime.runStep(baseRequest({ stepId: "two" }));

    expect(runtimeCreations).toBe(1);
    expect(sessionCreations).toBe(2);
  });

  test("wraps session creation failures clearly", async () => {
    const runtime = createRuntime(async () => {
      throw new Error("factory unavailable");
    });

    const error = await getRuntimeError(() => runtime.runStep(baseRequest()));

    expect(error.kind).toBe("session-creation");
    expect(error.message).toContain("factory unavailable");
  });

  test("suppresses discovered project and global system prompt files", async () => {
    const projectCwd = path.join(directory, "project");
    const otherCwd = path.join(directory, "other-project");
    const agentDir = path.join(directory, "pi-agent");
    const projectSystemPath = path.join(projectCwd, ".pi", "SYSTEM.md");
    const projectAppendPath = path.join(
      projectCwd,
      ".pi",
      "APPEND_SYSTEM.md",
    );
    const globalSystemPath = path.join(agentDir, "SYSTEM.md");
    const globalAppendPath = path.join(agentDir, "APPEND_SYSTEM.md");

    await mkdir(path.dirname(projectSystemPath), { recursive: true });
    await mkdir(otherCwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(projectSystemPath, "PROJECT_SYSTEM_MARKER", "utf8");
    await writeFile(projectAppendPath, "PROJECT_APPEND_MARKER", "utf8");
    await writeFile(globalSystemPath, "GLOBAL_SYSTEM_MARKER", "utf8");
    await writeFile(globalAppendPath, "GLOBAL_APPEND_MARKER", "utf8");

    const projectLoader = await createAiraResourceLoader({
      cwd: projectCwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
    });
    const globalLoader = await createAiraResourceLoader({
      cwd: otherCwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
    });

    expect(projectLoader.getSystemPromptSource()?.path).toBe(
      projectSystemPath,
    );
    expect(projectLoader.getAppendSystemPromptSources()).toEqual([
      { path: projectAppendPath },
    ]);
    expect(projectLoader.getSystemPrompt()).toBeUndefined();
    expect(projectLoader.getAppendSystemPrompt()).toEqual([]);

    expect(globalLoader.getSystemPromptSource()?.path).toBe(globalSystemPath);
    expect(globalLoader.getAppendSystemPromptSources()).toEqual([
      { path: globalAppendPath },
    ]);
    expect(globalLoader.getSystemPrompt()).toBeUndefined();
    expect(globalLoader.getAppendSystemPrompt()).toEqual([]);
  });

  test("creates isolated in-memory sessions through the real Pi SDK", async () => {
    const piDirectory = path.join(directory, ".pi");
    await mkdir(path.join(piDirectory, "extensions"), { recursive: true });
    await mkdir(path.join(piDirectory, "prompts"), { recursive: true });
    await mkdir(path.join(piDirectory, "skills", "local"), {
      recursive: true,
    });
    await writeFile(
      path.join(directory, "AGENTS.md"),
      "AIRA_CONTEXT_MARKER",
      "utf8",
    );
    await writeFile(
      path.join(piDirectory, "SYSTEM.md"),
      "AIRA_SYSTEM_MARKER",
      "utf8",
    );
    await writeFile(
      path.join(piDirectory, "APPEND_SYSTEM.md"),
      "AIRA_APPEND_SYSTEM_MARKER",
      "utf8",
    );
    await writeFile(
      path.join(piDirectory, "extensions", "must-not-load.ts"),
      'throw new Error("project extension loaded");\n',
      "utf8",
    );
    await writeFile(
      path.join(piDirectory, "prompts", "local.md"),
      "project prompt",
      "utf8",
    );
    await writeFile(
      path.join(piDirectory, "skills", "local", "SKILL.md"),
      "---\nname: local\ndescription: local\n---\nproject skill\n",
      "utf8",
    );

    const sdkModel = {
      provider: "test-provider",
      id: "test-model",
      name: "Test model",
      api: "openai-completions",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 10_000,
      maxTokens: 1_000,
    } as PiModel;
    const first = await createFreshPiSession({
      cwd: directory,
      modelRuntime: fakeModelRuntime,
      model: sdkModel,
      thinkingLevel: "off",
      tools: [],
    });
    const second = await createFreshPiSession({
      cwd: directory,
      modelRuntime: fakeModelRuntime,
      model: sdkModel,
      thinkingLevel: "off",
      tools: ["read", "grep", "find", "ls"],
    });

    try {
      expect(first.sessionId).not.toBe(second.sessionId);
      expect(first.sessionFile).toBeUndefined();
      expect(first.sessionManager.isPersisted()).toBe(false);
      expect(first.settingsManager.getRetrySettings().enabled).toBe(false);
      expect(first.settingsManager.getProviderRetrySettings().maxRetries).toBe(0);
      expect(first.autoCompactionEnabled).toBe(false);
      expect(first.getActiveToolNames()).toEqual([]);
      expect(second.getActiveToolNames()).toEqual([
        "read",
        "grep",
        "find",
        "ls",
      ]);
      expect(first.resourceLoader.getExtensions().extensions).toEqual([]);
      expect(first.resourceLoader.getSkills().skills).toEqual([]);
      expect(first.resourceLoader.getPrompts().prompts).toEqual([]);
      expect(first.resourceLoader.getThemes().themes).toEqual([]);
      expect(first.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
      expect(first.resourceLoader.getSystemPrompt()).toBeUndefined();
      expect(first.resourceLoader.getAppendSystemPrompt()).toEqual([]);
      expect(first.systemPrompt).toContain(
        "You are an expert coding assistant operating inside pi",
      );
      expect(first.systemPrompt).not.toContain("AIRA_CONTEXT_MARKER");
      expect(first.systemPrompt).not.toContain("AIRA_SYSTEM_MARKER");
      expect(first.systemPrompt).not.toContain("AIRA_APPEND_SYSTEM_MARKER");
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});

describe("PiRuntime tools and cwd", () => {
  test.each([
    ["read-only", ["read", "grep", "find", "ls"]],
    [
      "coding",
      ["read", "grep", "find", "ls", "edit", "write", "bash"],
    ],
    ["empty", []],
  ])("passes the %s tool allowlist unchanged", async (_name, tools) => {
    const session = successfulSession(`session-${_name}`);
    let creationOptions: PiSessionCreationOptions | undefined;
    const runtime = createRuntime(async (options) => {
      creationOptions = options;
      return session;
    });

    await runtime.runStep(baseRequest({ tools }));

    expect(creationOptions?.tools).toBe(tools);
    expect(creationOptions?.tools).toEqual(tools);
  });

  test("does not add tools when the allowlist is omitted", async () => {
    const session = successfulSession("session-no-tools");
    let creationOptions: PiSessionCreationOptions | undefined;
    const runtime = createRuntime(async (options) => {
      creationOptions = options;
      return session;
    });

    await runtime.runStep(baseRequest());

    expect(creationOptions?.tools).toBeUndefined();
  });

  test("passes cwd without changing the process cwd", async () => {
    const requestedCwd = path.join(directory, "repository");
    await mkdir(requestedCwd);
    const originalCwd = process.cwd();
    const session = successfulSession("session-cwd");
    let creationOptions: PiSessionCreationOptions | undefined;
    const runtime = createRuntime(async (options) => {
      creationOptions = options;
      return session;
    });

    await runtime.runStep(baseRequest({ cwd: requestedCwd }));

    expect(creationOptions?.cwd).toBe(requestedCwd);
    expect(process.cwd()).toBe(originalCwd);
  });
});

describe("PiRuntime model resolution", () => {
  test("uses resolveCliModel semantics and passes the resolved model", async () => {
    const modelRuntime = {
      getModels: () => [fakeModel],
      hasConfiguredAuth: () => false,
    } as unknown as ModelRuntime;
    const session = successfulSession("session-model");
    let creationOptions: PiSessionCreationOptions | undefined;
    const runtime = new PiRuntime({
      modelRuntime,
      sessionFactory: async (options) => {
        creationOptions = options;
        return session;
      },
    });

    await runtime.runStep(
      baseRequest({ model: "test-provider/test-model" }),
    );

    expect(creationOptions?.model).toBe(fakeModel);
  });

  test("fails an invalid model without creating a session", async () => {
    let sessionCreations = 0;
    const runtime = new PiRuntime({
      modelRuntime: {
        getModels: () => [fakeModel],
        hasConfiguredAuth: () => false,
      } as unknown as ModelRuntime,
      sessionFactory: async () => {
        sessionCreations += 1;
        return successfulSession("should-not-exist");
      },
    });

    const error = await getRuntimeError(() =>
      runtime.runStep(baseRequest({ model: "missing-provider/model" })),
    );

    expect(error.kind).toBe("model-resolution");
    expect(error.message).toContain("not found");
    expect(sessionCreations).toBe(0);
  });

  test("rejects resolver warnings instead of accepting a custom-id fallback", async () => {
    let sessionCreations = 0;
    const runtime = new PiRuntime({
      modelRuntime: {
        getModels: () => [fakeModel],
        hasConfiguredAuth: () => false,
      } as unknown as ModelRuntime,
      sessionFactory: async () => {
        sessionCreations += 1;
        return successfulSession("should-not-exist");
      },
    });

    const error = await getRuntimeError(() =>
      runtime.runStep(
        baseRequest({ model: "test-provider/model-not-in-catalog" }),
      ),
    );

    expect(error.kind).toBe("model-resolution");
    expect(error.message).toContain("Using custom model id");
    expect(sessionCreations).toBe(0);
  });

  test("omitted model skips explicit resolution and leaves model undefined", async () => {
    let resolverCalls = 0;
    let creationOptions: PiSessionCreationOptions | undefined;
    const runtime = createRuntime(
      async (options) => {
        creationOptions = options;
        return successfulSession("session-default-model");
      },
      {
        modelResolver: () => {
          resolverCalls += 1;
          throw new Error("should not resolve");
        },
      },
    );

    await runtime.runStep(baseRequest());

    expect(resolverCalls).toBe(0);
    expect(creationOptions?.model).toBeUndefined();
  });
});

describe("PiRuntime thinking level", () => {
  test("passes a valid thinking level", async () => {
    let creationOptions: PiSessionCreationOptions | undefined;
    const runtime = createRuntime(async (options) => {
      creationOptions = options;
      return successfulSession("session-thinking");
    });

    await runtime.runStep(baseRequest({ thinking: "xhigh" }));

    expect(creationOptions?.thinkingLevel).toBe("xhigh");
  });

  test("uses a thinking suffix resolved from the model selector", async () => {
    let creationOptions: PiSessionCreationOptions | undefined;
    const runtime = createRuntime(
      async (options) => {
        creationOptions = options;
        return successfulSession("session-model-thinking");
      },
      {
        modelResolver: () => ({
          model: fakeModel,
          thinkingLevel: "high",
          warning: undefined,
          error: undefined,
        }),
      },
    );

    await runtime.runStep(baseRequest({ model: "test-provider/test-model:high" }));

    expect(creationOptions?.thinkingLevel).toBe("high");
  });

  test("rejects an invalid thinking level before session creation", async () => {
    let sessionCreations = 0;
    const runtime = createRuntime(async () => {
      sessionCreations += 1;
      return successfulSession("should-not-exist");
    });

    const error = await getRuntimeError(() =>
      runtime.runStep(baseRequest({ thinking: "extreme" })),
    );

    expect(error.kind).toBe("invalid-request");
    expect(error.message).toContain("invalid Pi thinking level");
    expect(sessionCreations).toBe(0);
  });

  test("supports omitted thinking level", async () => {
    let creationOptions: PiSessionCreationOptions | undefined;
    const runtime = createRuntime(async (options) => {
      creationOptions = options;
      return successfulSession("session-no-thinking");
    });

    await runtime.runStep(baseRequest());

    expect(creationOptions?.thinkingLevel).toBeUndefined();
  });
});

describe("PiRuntime prompting and failures", () => {
  test("sends the prompt once, preserves it, and extracts final text", async () => {
    const prompt = "/literal final prompt\nwith UTF-8 λ";
    const session = successfulSession("session-prompt", "Final answer λ");
    const runtime = createRuntime(async () => session);

    const result = await runtime.runStep(baseRequest({ prompt }));

    expect(session.promptCalls).toHaveLength(1);
    expect(session.promptCalls[0]?.text).toBe(prompt);
    expect(session.promptCalls[0]?.options).toEqual({
      expandPromptTemplates: false,
    });
    expect(result.finalText).toBe("Final answer λ");
  });

  test("returns a normal Pi provider failure as an unsuccessful result", async () => {
    const session = new FakePiSession("session-provider-error", async (current) => {
      const message = assistantMessage("", "error", "provider overloaded");
      current.emit({
        type: "message_end",
        message,
      } as unknown as AgentSessionEvent);
      current.emit({
        type: "agent_end",
        messages: [message],
        willRetry: false,
      } as unknown as AgentSessionEvent);
    });
    const runtime = createRuntime(async () => session);

    const result = await runtime.runStep(baseRequest());

    expect(result).toEqual({
      success: false,
      sessionId: "session-provider-error",
      finalText: "",
      timedOut: false,
      error: "provider overloaded",
    });
    expect(session.abortCalls).toBe(0);
  });

  test("cleans up and throws when Pi prompt rejects", async () => {
    const session = new FakePiSession("session-prompt-error", async () => {
      throw new Error("no API key available");
    });
    const runtime = createRuntime(async () => session);

    const error = await getRuntimeError(() => runtime.runStep(baseRequest()));

    expect(error.kind).toBe("session-execution");
    expect(error.message).toContain("no API key available");
    expect(session.abortCalls).toBe(1);
    expect(session.unsubscribeCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
  });
});

describe("PiRuntime timeout and cleanup", () => {
  test("completes before timeout without aborting", async () => {
    const session = successfulSession("session-before-timeout");
    const runtime = createRuntime(async () => session);

    const result = await runtime.runStep(
      baseRequest({ timeoutSeconds: 0.05 }),
    );

    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(session.abortCalls).toBe(0);
    expect(session.unsubscribeCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
  });

  test("aborts, unsubscribes, and disposes a timed-out session", async () => {
    const session = new FakePiSession(
      "session-timeout",
      async () => await new Promise<void>(() => {}),
    );
    const runtime = createRuntime(async () => session);
    const started = performance.now();

    const result = await runtime.runStep(
      baseRequest({ timeoutSeconds: 0.005 }),
    );

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out after 0.005 seconds");
    expect(session.abortCalls).toBe(1);
    expect(session.unsubscribeCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("PiRuntime session audit log", () => {
  test("creates ordered JSONL records with a final newline", async () => {
    const logPath = path.join(directory, "nested", "sessions", "plan.jsonl");
    const secret = "sk-test-credential-that-must-not-be-logged";
    const session = new FakePiSession("session-log", async (current) => {
      const message = assistantMessage("Finished λ");
      current.finalText = "Finished λ";
      current.emit({ type: "agent_start", apiKey: secret } as AgentSessionEvent);
      current.emit({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "text_delta",
          delta: "Finished λ",
          apiKey: secret,
        },
      } as unknown as AgentSessionEvent);
      current.emit({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { apiKey: secret },
      } as AgentSessionEvent);
      current.emit({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result: { apiKey: secret },
        isError: false,
      } as AgentSessionEvent);
      current.emit({
        type: "message_end",
        message,
      } as unknown as AgentSessionEvent);
      current.emit({
        type: "agent_end",
        messages: [message],
        willRetry: false,
      } as unknown as AgentSessionEvent);
    });
    const runtime = createRuntime(async () => session);

    await runtime.runStep(baseRequest({ sessionLogPath: logPath }));

    const source = await readFile(logPath, "utf8");
    const records = source
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(source.endsWith("\n")).toBe(true);
    expect(records.map((record) => record.type)).toEqual([
      "session_start",
      "agent_start",
      "message_update",
      "tool_execution_start",
      "tool_execution_end",
      "message_end",
      "agent_end",
      "session_end",
    ]);
    expect(records[0]).toMatchObject({
      stepId: "plan",
      sessionId: "session-log",
    });
    expect(records[5]).toMatchObject({
      role: "assistant",
      text: "Finished λ",
      stopReason: "stop",
      failed: false,
    });
    expect(records[7]).toMatchObject({ success: true, timedOut: false });
    expect(source).not.toContain(secret);
    expect(await pathExists(path.dirname(logPath))).toBe(true);
  });

  test("does not create a log when sessionLogPath is omitted", async () => {
    const unrequestedPath = path.join(directory, "sessions", "missing.jsonl");
    const runtime = createRuntime(async () => successfulSession("session-no-log"));

    await runtime.runStep(baseRequest());

    expect(await pathExists(unrequestedPath)).toBe(false);
  });

  test("treats a log write failure as a runtime error and cleans up", async () => {
    const session = successfulSession("session-log-failure");
    let flushCalls = 0;
    let closeCalls = 0;
    const runtime = createRuntime(async () => session, {
      auditLogFactory: async () => ({
        record() {},
        async flush() {
          flushCalls += 1;
          if (flushCalls >= 2) {
            throw new Error("disk full");
          }
        },
        async close() {
          closeCalls += 1;
        },
      }),
    });

    const error = await getRuntimeError(() =>
      runtime.runStep(
        baseRequest({ sessionLogPath: path.join(directory, "audit.jsonl") }),
      ),
    );

    expect(error.kind).toBe("session-log");
    expect(error.message).toContain("disk full");
    expect(session.unsubscribeCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
    expect(closeCalls).toBe(1);
  });

  test("cleans up a created session when the log path cannot be opened", async () => {
    const session = successfulSession("session-bad-log-path");
    const runtime = createRuntime(async () => session);

    const error = await getRuntimeError(() =>
      runtime.runStep(baseRequest({ sessionLogPath: directory })),
    );

    expect(error.kind).toBe("session-log");
    expect(session.promptCalls).toHaveLength(0);
    expect(session.disposeCalls).toBe(1);
  });
});
