import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEventListener,
  type CreateAgentSessionOptions,
  type PromptOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  COMPLETE_STEP_TOOL_NAME,
  getAgentCompletionSpecError,
} from "../completion";
import { AgentRuntimeError } from "../errors";
import type { AgentRuntime } from "../runtime";
import type { AgentStepRequest, AgentStepResult } from "../types";
import {
  createSessionAuditLog,
  type SessionAuditLog,
  type SessionAuditLogFactory,
} from "./audit-log";
import {
  createCompleteStepTool,
  type CompleteStepToolCapture,
} from "./completion-tool";
import {
  toAiraSessionEventRecord,
  updateAssistantSnapshot,
  type PiAssistantSnapshot,
} from "./events";
import {
  formatPiThinkingLevels,
  isPiThinkingLevel,
  resolvePiModel,
  type PiModel,
  type PiModelResolver,
  type PiThinkingLevel,
} from "./model";
import { createAiraResourceLoader } from "./resources";

export const DEFAULT_AGENT_TIMEOUT_SECONDS = 900;
const ABORT_SETTLE_TIMEOUT_MILLISECONDS = 5_000;

export interface PiSession {
  readonly sessionId: string;
  readonly state: {
    readonly errorMessage?: string;
  };
  prompt(text: string, options?: PromptOptions): Promise<void>;
  subscribe(listener: AgentSessionEventListener): () => void;
  abort(): Promise<void>;
  dispose(): void;
  getLastAssistantText(): string | undefined;
}

export interface PiSessionCreationOptions {
  cwd: string;
  modelRuntime: ModelRuntime;
  model?: PiModel;
  thinkingLevel?: PiThinkingLevel;
  tools?: string[];
  customTools?: ToolDefinition<any, any>[];
}

export type PiSessionFactory = (
  options: PiSessionCreationOptions,
) => Promise<PiSession>;

export interface PiRuntimeOptions {
  /** Reused across all sessions created by this runtime. */
  modelRuntime?: ModelRuntime;
  /** Small Phase 9 seam for Aira-owned custom tools. */
  customTools?: ToolDefinition<any, any>[];
  /** Narrow SDK seams used by unit tests. */
  sessionFactory?: PiSessionFactory;
  modelRuntimeFactory?: () => Promise<ModelRuntime>;
  modelResolver?: PiModelResolver;
  /** Test seam for filesystem failure paths. */
  auditLogFactory?: SessionAuditLogFactory;
}

interface PromptCompleted {
  kind: "completed";
}

interface PromptRejected {
  kind: "rejected";
  cause: unknown;
}

interface PromptTimedOut {
  kind: "timed-out";
}

interface PromptAborted {
  kind: "aborted";
}

type PromptOutcome =
  | PromptCompleted
  | PromptRejected
  | PromptTimedOut
  | PromptAborted;

interface CleanupFailure {
  kind: "session-log" | "session-cleanup";
  cause: unknown;
  message: string;
}

export class PiRuntime implements AgentRuntime {
  private readonly customTools?: ToolDefinition<any, any>[];
  private readonly sessionFactory: PiSessionFactory;
  private readonly modelRuntimeFactory: () => Promise<ModelRuntime>;
  private readonly modelResolver: PiModelResolver;
  private readonly auditLogFactory: SessionAuditLogFactory;
  private modelRuntimePromise?: Promise<ModelRuntime>;

  constructor(options: PiRuntimeOptions = {}) {
    this.customTools = options.customTools;
    this.sessionFactory = options.sessionFactory ?? createFreshPiSession;
    this.modelRuntimeFactory =
      options.modelRuntimeFactory ?? (() => ModelRuntime.create());
    this.modelResolver = options.modelResolver ?? resolvePiModel;
    this.auditLogFactory = options.auditLogFactory ?? createSessionAuditLog;

    if (options.modelRuntime !== undefined) {
      this.modelRuntimePromise = Promise.resolve(options.modelRuntime);
    }
  }

  async runStep(request: AgentStepRequest): Promise<AgentStepResult> {
    assertAgentStepRequest(request);
    assertNoCompleteStepToolCollision(request, this.customTools);

    const completionCapture =
      request.completion === undefined
        ? undefined
        : createCompleteStepTool(request.completion);
    const customTools =
      completionCapture === undefined
        ? this.customTools
        : [...(this.customTools ?? []), completionCapture.tool];
    const requestedThinking = resolveRequestedThinking(request);
    const modelRuntime = await this.getModelRuntime(request.stepId);
    const { model, thinkingLevel } = this.resolveModel(
      request,
      modelRuntime,
      requestedThinking,
    );

    let session: PiSession;

    try {
      session = await this.sessionFactory({
        cwd: request.cwd,
        modelRuntime,
        model,
        thinkingLevel,
        tools: request.tools,
        customTools,
      });
    } catch (cause) {
      throw new AgentRuntimeError(
        `could not create Pi session for step "${request.stepId}": ` +
          getErrorMessage(cause),
        {
          kind: "session-creation",
          stepId: request.stepId,
          cause,
        },
      );
    }

    return await this.runSession(request, session, completionCapture);
  }

  private async getModelRuntime(stepId: string): Promise<ModelRuntime> {
    this.modelRuntimePromise ??= this.modelRuntimeFactory();

    try {
      return await this.modelRuntimePromise;
    } catch (cause) {
      throw new AgentRuntimeError(
        `could not initialize Pi model runtime: ${getErrorMessage(cause)}`,
        { kind: "model-runtime", stepId, cause },
      );
    }
  }

  private resolveModel(
    request: AgentStepRequest,
    modelRuntime: ModelRuntime,
    requestedThinking: PiThinkingLevel | undefined,
  ): { model?: PiModel; thinkingLevel?: PiThinkingLevel } {
    if (request.model === undefined) {
      return { thinkingLevel: requestedThinking };
    }

    let resolution: ReturnType<PiModelResolver>;

    try {
      resolution = this.modelResolver(
        request.model,
        modelRuntime,
        requestedThinking,
      );
    } catch (cause) {
      throw new AgentRuntimeError(
        `could not resolve Pi model "${request.model}": ` +
          getErrorMessage(cause),
        {
          kind: "model-resolution",
          stepId: request.stepId,
          cause,
        },
      );
    }

    const resolutionFailure =
      resolution.error ??
      resolution.warning ??
      (resolution.model === undefined
        ? `model "${request.model}" was not found`
        : undefined);

    if (resolutionFailure !== undefined || resolution.model === undefined) {
      throw new AgentRuntimeError(
        `could not resolve Pi model "${request.model}": ${resolutionFailure}`,
        {
          kind: "model-resolution",
          stepId: request.stepId,
        },
      );
    }

    const resolverThinking = resolution.thinkingLevel;

    if (
      resolverThinking !== undefined &&
      !isPiThinkingLevel(resolverThinking)
    ) {
      throw new AgentRuntimeError(
        `Pi model resolver returned invalid thinking level ` +
          `"${String(resolverThinking)}" for model "${request.model}"`,
        {
          kind: "model-resolution",
          stepId: request.stepId,
        },
      );
    }

    return {
      model: resolution.model,
      thinkingLevel: requestedThinking ?? resolverThinking,
    };
  }

  private async runSession(
    request: AgentStepRequest,
    session: PiSession,
    completionCapture?: CompleteStepToolCapture,
  ): Promise<AgentStepResult> {
    let auditLog: SessionAuditLog | undefined;
    let unsubscribe: (() => void) | undefined;
    let assistantSnapshot: PiAssistantSnapshot | undefined;
    let result: AgentStepResult | undefined;
    let operationError: AgentRuntimeError | undefined;
    let sessionEndRecorded = false;

    try {
      if (request.sessionLogPath !== undefined) {
        try {
          auditLog = await this.auditLogFactory(request.sessionLogPath);
          auditLog.record({
            timestamp: timestamp(),
            type: "session_start",
            stepId: request.stepId,
            sessionId: session.sessionId,
          });
          await auditLog.flush();
        } catch (cause) {
          throw sessionLogError(request, cause);
        }
      }

      const listener: AgentSessionEventListener = (event) => {
        if (
          event.type === "tool_execution_start" &&
          event.toolName === COMPLETE_STEP_TOOL_NAME
        ) {
          completionCapture?.recordInvocationStart(event.toolCallId);
        } else if (
          event.type === "tool_execution_end" &&
          event.toolName === COMPLETE_STEP_TOOL_NAME &&
          event.isError
        ) {
          completionCapture?.recordInvocationError(event.toolCallId);
        }

        assistantSnapshot = updateAssistantSnapshot(assistantSnapshot, event);
        auditLog?.record(toAiraSessionEventRecord(event, timestamp()));
      };

      try {
        unsubscribe = session.subscribe(listener);
      } catch (cause) {
        throw new AgentRuntimeError(
          `could not subscribe to Pi session events for step ` +
            `"${request.stepId}": ${getErrorMessage(cause)}`,
          {
            kind: "session-execution",
            stepId: request.stepId,
            cause,
          },
        );
      }

      const timeoutSeconds =
        request.timeoutSeconds ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
      const promptOutcome = await promptWithTimeout(
        session,
        request.prompt,
        timeoutSeconds,
        request.signal,
      );

      if (promptOutcome.kind === "aborted") {
        const abortFailure = await abortAndWait(session);
        const error =
          "Pi session aborted by external signal" +
          (abortFailure === undefined
            ? ""
            : `; abort failed: ${getErrorMessage(abortFailure)}`);

        result = {
          success: false,
          sessionId: session.sessionId,
          finalText: readFinalText(session, assistantSnapshot, request),
          timedOut: false,
          aborted: true,
          error,
        };
      } else if (promptOutcome.kind === "timed-out") {
        const abortFailure = await abortAndWait(session);
        const error =
          `Pi session timed out after ${timeoutSeconds} seconds` +
          (abortFailure === undefined
            ? ""
            : `; abort failed: ${getErrorMessage(abortFailure)}`);

        result = {
          success: false,
          sessionId: session.sessionId,
          finalText: readFinalText(session, assistantSnapshot, request),
          timedOut: true,
          error,
        };
      } else if (promptOutcome.kind === "rejected") {
        const abortFailure = await abortAndWait(session);
        const abortDetail =
          abortFailure === undefined
            ? ""
            : `; cleanup abort failed: ${getErrorMessage(abortFailure)}`;

        throw new AgentRuntimeError(
          `Pi prompt failed for step "${request.stepId}": ` +
            `${getErrorMessage(promptOutcome.cause)}${abortDetail}`,
          {
            kind: "session-execution",
            stepId: request.stepId,
            cause: promptOutcome.cause,
          },
        );
      } else {
        result = makeCompletedResult(request, session, assistantSnapshot);
      }

      result = attachCompletionState(result, completionCapture);

      if (auditLog !== undefined) {
        auditLog.record({
          timestamp: timestamp(),
          type: "session_end",
          success: result.success,
          timedOut: result.timedOut,
          aborted: result.aborted === true,
        });
        sessionEndRecorded = true;

        try {
          await auditLog.flush();
        } catch (cause) {
          throw sessionLogError(request, cause);
        }
      }
    } catch (cause) {
      operationError =
        cause instanceof AgentRuntimeError
          ? cause
          : new AgentRuntimeError(
              `Pi session failed for step "${request.stepId}": ` +
                getErrorMessage(cause),
              {
                kind: "session-execution",
                stepId: request.stepId,
                cause,
              },
            );

      if (auditLog !== undefined && !sessionEndRecorded) {
        auditLog.record({
          timestamp: timestamp(),
          type: "session_end",
          success: false,
          timedOut: false,
          aborted: request.signal?.aborted === true,
        });

        try {
          await auditLog.flush();
        } catch (cause) {
          operationError = sessionLogError(request, cause);
        }
      }
    }

    const cleanupFailure = await cleanupSession(
      session,
      unsubscribe,
      auditLog,
    );

    if (operationError !== undefined) {
      throw operationError;
    }

    if (cleanupFailure !== undefined) {
      throw new AgentRuntimeError(cleanupFailure.message, {
        kind: cleanupFailure.kind,
        stepId: request.stepId,
        cause: cleanupFailure.cause,
      });
    }

    if (result === undefined) {
      throw new AgentRuntimeError(
        `Pi session for step "${request.stepId}" produced no result`,
        { kind: "session-execution", stepId: request.stepId },
      );
    }

    return result;
  }
}

export async function createFreshPiSession(
  options: PiSessionCreationOptions,
): Promise<AgentSession> {
  const settingsManager = SettingsManager.inMemory(
    {
      compaction: { enabled: false },
      retry: {
        enabled: false,
        provider: { maxRetries: 0 },
      },
    },
    { projectTrusted: false },
  );
  const resourceLoader = await createAiraResourceLoader({
    cwd: options.cwd,
    settingsManager,
  });

  const sessionOptions: CreateAgentSessionOptions = {
    cwd: options.cwd,
    modelRuntime: options.modelRuntime,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    tools: options.tools,
    customTools: options.customTools,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager,
    resourceLoader,
  };
  const { session } = await createAgentSession(sessionOptions);
  return session;
}

function resolveRequestedThinking(
  request: AgentStepRequest,
): PiThinkingLevel | undefined {
  if (request.thinking === undefined) {
    return undefined;
  }

  if (!isPiThinkingLevel(request.thinking)) {
    throw new AgentRuntimeError(
      `invalid Pi thinking level "${request.thinking}"; expected one of: ` +
        formatPiThinkingLevels(),
      {
        kind: "invalid-request",
        stepId: request.stepId,
      },
    );
  }

  return request.thinking;
}

function assertAgentStepRequest(request: AgentStepRequest): void {
  if (typeof request.stepId !== "string" || request.stepId.trim().length === 0) {
    throw new AgentRuntimeError("agent step id must be a non-empty string", {
      kind: "invalid-request",
      stepId:
        typeof request.stepId === "string" ? request.stepId : String(request.stepId),
    });
  }

  if (typeof request.prompt !== "string" || request.prompt.length === 0) {
    throw new AgentRuntimeError(
      `agent prompt for step "${request.stepId}" must be a non-empty string`,
      { kind: "invalid-request", stepId: request.stepId },
    );
  }

  if (typeof request.cwd !== "string" || request.cwd.length === 0) {
    throw new AgentRuntimeError(
      `agent cwd for step "${request.stepId}" must be a non-empty string`,
      { kind: "invalid-request", stepId: request.stepId },
    );
  }

  if (
    request.model !== undefined &&
    (typeof request.model !== "string" || request.model.trim().length === 0)
  ) {
    throw new AgentRuntimeError(
      `agent model for step "${request.stepId}" must be a non-empty string`,
      { kind: "invalid-request", stepId: request.stepId },
    );
  }

  if (
    request.tools !== undefined &&
    (!Array.isArray(request.tools) ||
      request.tools.some((tool) => typeof tool !== "string"))
  ) {
    throw new AgentRuntimeError(
      `agent tools for step "${request.stepId}" must be an array of strings`,
      { kind: "invalid-request", stepId: request.stepId },
    );
  }

  const timeoutSeconds =
    request.timeoutSeconds ?? DEFAULT_AGENT_TIMEOUT_SECONDS;

  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    throw new AgentRuntimeError(
      `agent timeout for step "${request.stepId}" must be a positive number`,
      { kind: "invalid-request", stepId: request.stepId },
    );
  }

  if (
    request.sessionLogPath !== undefined &&
    (typeof request.sessionLogPath !== "string" ||
      request.sessionLogPath.length === 0)
  ) {
    throw new AgentRuntimeError(
      `agent session log path for step "${request.stepId}" must be non-empty`,
      { kind: "invalid-request", stepId: request.stepId },
    );
  }

  if (request.completion !== undefined) {
    const completionSpecError = getAgentCompletionSpecError(request.completion);

    if (completionSpecError !== undefined) {
      throw new AgentRuntimeError(
        `invalid completion specification for step "${request.stepId}": ` +
          completionSpecError,
        { kind: "invalid-request", stepId: request.stepId },
      );
    }
  }
}

function assertNoCompleteStepToolCollision(
  request: AgentStepRequest,
  customTools: readonly ToolDefinition<any, any>[] | undefined,
): void {
  if (
    customTools?.some((tool) => tool.name === COMPLETE_STEP_TOOL_NAME) !== true
  ) {
    return;
  }

  throw new AgentRuntimeError(
    `custom tool name "${COMPLETE_STEP_TOOL_NAME}" is reserved by Aira`,
    { kind: "invalid-request", stepId: request.stepId },
  );
}

async function promptWithTimeout(
  session: PiSession,
  prompt: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<PromptOutcome> {
  if (signal?.aborted === true) {
    return { kind: "aborted" };
  }

  const promptOutcome = Promise.resolve()
    .then(() => session.prompt(prompt, { expandPromptTemplates: false }))
    .then<PromptOutcome, PromptOutcome>(
      () => ({ kind: "completed" }),
      (cause: unknown) => ({ kind: "rejected", cause }),
    );

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutOutcome = new Promise<PromptTimedOut>((resolve) => {
    timeoutTimer = setTimeout(
      () => resolve({ kind: "timed-out" }),
      Math.ceil(timeoutSeconds * 1_000),
    );
  });
  let abortListener: (() => void) | undefined;
  const abortOutcome = new Promise<PromptAborted>((resolve) => {
    if (signal === undefined) {
      return;
    }

    if (signal.aborted) {
      resolve({ kind: "aborted" });
      return;
    }

    abortListener = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", abortListener, { once: true });
  });
  const outcome = await Promise.race([
    promptOutcome,
    timeoutOutcome,
    abortOutcome,
  ]);

  if (timeoutTimer !== undefined) {
    clearTimeout(timeoutTimer);
  }

  if (abortListener !== undefined) {
    signal?.removeEventListener("abort", abortListener);
  }

  return outcome;
}

async function abortAndWait(session: PiSession): Promise<unknown | undefined> {
  const abortOutcome = Promise.resolve()
    .then(() => session.abort())
    .then<
      { kind: "settled" } | { kind: "failed"; cause: unknown },
      { kind: "settled" } | { kind: "failed"; cause: unknown }
    >(
      () => ({ kind: "settled" }),
      (cause: unknown) => ({ kind: "failed", cause }),
    );

  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const settleTimeout = new Promise<{ kind: "timeout" }>((resolve) => {
    settleTimer = setTimeout(
      () => resolve({ kind: "timeout" }),
      ABORT_SETTLE_TIMEOUT_MILLISECONDS,
    );
  });
  const outcome = await Promise.race([abortOutcome, settleTimeout]);

  if (settleTimer !== undefined) {
    clearTimeout(settleTimer);
  }

  if (outcome.kind === "failed") {
    return outcome.cause;
  }

  if (outcome.kind === "timeout") {
    return new Error(
      `Pi abort did not settle within ` +
        `${ABORT_SETTLE_TIMEOUT_MILLISECONDS} milliseconds`,
    );
  }

  return undefined;
}

function makeCompletedResult(
  request: AgentStepRequest,
  session: PiSession,
  assistantSnapshot: PiAssistantSnapshot | undefined,
): AgentStepResult {
  const finalText = readFinalText(session, assistantSnapshot, request);
  const failedStop =
    assistantSnapshot?.stopReason === "error" ||
    assistantSnapshot?.stopReason === "aborted";
  const stateError =
    assistantSnapshot === undefined ? session.state.errorMessage : undefined;

  if (failedStop || stateError !== undefined) {
    return {
      success: false,
      sessionId: session.sessionId,
      finalText,
      timedOut: false,
      error:
        assistantSnapshot?.errorMessage ??
        stateError ??
        `Pi agent failed while processing step "${request.stepId}"`,
    };
  }

  return {
    success: true,
    sessionId: session.sessionId,
    finalText,
    timedOut: false,
  };
}

function attachCompletionState(
  result: AgentStepResult,
  capture: CompleteStepToolCapture | undefined,
): AgentStepResult {
  if (capture === undefined) {
    return result;
  }

  const state = capture.getState();

  return {
    ...result,
    ...(state.completion === undefined
      ? {}
      : { completion: state.completion }),
    ...(state.completionError === undefined
      ? {}
      : { completionError: state.completionError }),
  };
}

function readFinalText(
  session: PiSession,
  assistantSnapshot: PiAssistantSnapshot | undefined,
  request: AgentStepRequest,
): string {
  try {
    return session.getLastAssistantText() ?? assistantSnapshot?.text ?? "";
  } catch (cause) {
    throw new AgentRuntimeError(
      `could not read final Pi response for step "${request.stepId}": ` +
        getErrorMessage(cause),
      {
        kind: "session-execution",
        stepId: request.stepId,
        cause,
      },
    );
  }
}

async function cleanupSession(
  session: PiSession,
  unsubscribe: (() => void) | undefined,
  auditLog: SessionAuditLog | undefined,
): Promise<CleanupFailure | undefined> {
  let failure: CleanupFailure | undefined;

  try {
    unsubscribe?.();
  } catch (cause) {
    failure = {
      kind: "session-cleanup",
      cause,
      message: `could not unsubscribe from Pi session events: ${getErrorMessage(cause)}`,
    };
  }

  if (auditLog !== undefined) {
    try {
      await auditLog.close();
    } catch (cause) {
      failure ??= {
        kind: "session-log",
        cause,
        message: `could not close Pi session audit log: ${getErrorMessage(cause)}`,
      };
    }
  }

  try {
    session.dispose();
  } catch (cause) {
    failure ??= {
      kind: "session-cleanup",
      cause,
      message: `could not dispose Pi session: ${getErrorMessage(cause)}`,
    };
  }

  return failure;
}

function sessionLogError(
  request: AgentStepRequest,
  cause: unknown,
): AgentRuntimeError {
  return new AgentRuntimeError(
    `could not persist Pi session audit log for step ` +
      `"${request.stepId}": ${getErrorMessage(cause)}`,
    {
      kind: "session-log",
      stepId: request.stepId,
      cause,
    },
  );
}

function timestamp(): string {
  return new Date().toISOString();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
