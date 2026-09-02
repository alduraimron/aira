import path from "node:path";

import { validateAgentCompletion } from "../agent/completion";
import { AgentRuntimeError } from "../agent/errors";
import type { AgentRuntime } from "../agent/runtime";
import type { AgentStepResult } from "../agent/types";
import {
  readArtifact,
  readArtifactVersion,
  writeArtifact,
} from "../artifacts/manager";
import { loadCommand } from "../commands/loader";
import { evaluateCondition } from "../conditions/evaluator";
import { sanitizeDisplayText } from "../observability/display";
import { getRunPaths } from "../run/paths";
import { saveRun } from "../run/persistence";
import {
  getPendingRevision,
  resolveRevisionForStep,
} from "../run/revisions";
import { patchStepState, setRunStatus } from "../run/state";
import type { RunState, StepState } from "../run/types";
import {
  DEFAULT_SHELL_TIMEOUT_SECONDS,
  runShellCommand,
  ShellCommandError,
} from "../shell/runner";
import type {
  RunShellCommandParams,
  ShellCommandResult,
} from "../shell/types";
import { interpolateTemplate } from "../template/interpolate";
import type {
  AgentStep,
  LoopStep,
  ShellStep,
  Workflow,
  WorkflowStep,
} from "../workflow/types";
import {
  composeAgentPrompt,
  createAgentCompletionSpec,
  resolveAgentCommandPath,
  resolveAgentStepConfiguration,
} from "./agent-step";
import {
  createExecutionTemplateContext,
  type ExecutionContextInput,
  type ResolvedExecutionContext,
  type RevisionContext,
} from "./context";
import { ExecutionError } from "./errors";
import type {
  AiraExecutionEvent,
  ExecutionEventListener,
} from "./events";
import { resolveTechnicalRetryCount } from "./retry";
import { prepareRunForResume } from "./resume";

export type ShellRunner = (
  params: RunShellCommandParams,
) => Promise<ShellCommandResult>;

const MAX_SHELL_COMMAND_DISPLAY_LENGTH = 220;

export type ExecutionMode = "fresh" | "continue" | "resume";

export interface ExecuteWorkflowParams {
  workflow: Workflow;
  runsRoot: string;
  state: RunState;
  context: ExecutionContextInput;
  cwd: string;
  /** Caller-resolved default timeout in seconds. */
  shellTimeout?: number;
  /** Cancels active agent or shell execution. */
  signal?: AbortSignal;
  /** Defaults to strict fresh execution. */
  mode?: ExecutionMode;
  now?: () => Date;
  shellRunner?: ShellRunner;
  /** Required only when an agent step is reached. */
  agentRuntime?: AgentRuntime;
  /** Root containing reusable command Markdown files. */
  commandsDir?: string;
  /** Optional best-effort listener for operator-visible execution activity. */
  onEvent?: ExecutionEventListener;
}

interface PreparedShellCommand {
  name?: string;
  command: string;
}

interface PreparedShellStep {
  commands: PreparedShellCommand[];
  multiCommand: boolean;
}

interface CommandExecution {
  name: string;
  result: ShellCommandResult;
}

interface RuntimeFailure {
  cause: unknown;
  message: string;
}

interface ExecutionRuntime {
  runsRoot: string;
  context: ResolvedExecutionContext;
  cwd: string;
  shellTimeout?: number;
  clock: () => Date;
  shellRunner: ShellRunner;
  agentRuntime?: AgentRuntime;
  commandsDir?: string;
  signal?: AbortSignal;
  onEvent?: ExecutionEventListener;
  observableSteps: Map<string, { startedAtMs: number }>;
  replayLoopId?: string;
  state: RunState;
}

type StepOutcome =
  | "completed"
  | "failed"
  | "skipped"
  | "waiting"
  | "interrupted";

type StepScope =
  | { kind: "top-level" }
  | { kind: "loop-child"; loopId: string };

interface TechnicalFailureParams {
  stepId: string;
  message: string;
  cause?: unknown;
  parentLoopId?: string;
  markStep?: boolean;
  stepPatch?: Partial<StepState>;
}

const systemClock = () => new Date();

export async function executeWorkflow(
  params: ExecuteWorkflowParams,
): Promise<RunState> {
  const mode = params.mode ?? "fresh";
  const runtime: ExecutionRuntime = {
    runsRoot: params.runsRoot,
    context: {
      config: params.context.config,
      ...(params.context.artifacts === undefined
        ? {}
        : { artifacts: params.context.artifacts }),
    },
    cwd: params.cwd,
    shellTimeout: params.shellTimeout,
    clock: params.now ?? systemClock,
    shellRunner: params.shellRunner ?? runShellCommand,
    agentRuntime: params.agentRuntime,
    commandsDir: params.commandsDir,
    signal: params.signal,
    onEvent: params.onEvent,
    observableSteps: new Map(),
    state: params.state,
  };

  if (mode !== "fresh" && mode !== "continue" && mode !== "resume") {
    throw new ExecutionError(`unsupported execution mode "${String(mode)}"`, {
      runId: runtime.state.id,
    });
  }

  if (runtime.state.workflow !== params.workflow.name) {
    throw new ExecutionError(
      `run "${runtime.state.id}" was created for workflow ` +
        `"${runtime.state.workflow}" but executor received ` +
        `"${params.workflow.name}"`,
      { runId: runtime.state.id },
    );
  }

  if (mode === "resume") {
    const prepared = prepareRunForResume(params.workflow, runtime.state);
    runtime.state = prepared.state;
    runtime.replayLoopId = prepared.replayLoopId;
    const preparedAt = readClock(runtime.clock, runtime.state.id);
    await persistRuntimeState(runtime, preparedAt, runtime.state.current_step);
  } else if (runtime.state.status !== "running") {
    throw new ExecutionError(
      `run "${runtime.state.id}" must have status "running" before execution; ` +
        `found "${runtime.state.status}"`,
      { runId: runtime.state.id },
    );
  }

  if (runtime.signal?.aborted === true) {
    const nextStep = params.workflow.steps.find((step) => {
      const status = getStepState(runtime.state, step.id)?.status;
      return (
        mode === "fresh" || (status !== "completed" && status !== "skipped")
      );
    });

    if (nextStep !== undefined && nextStep.uses !== "approval") {
      runtime.state = { ...runtime.state, current_step: nextStep.id };

      if (runtime.replayLoopId === nextStep.id) {
        await interruptLoop(runtime, nextStep.id);
      } else {
        await interruptBeforeStep(runtime, nextStep.id);
      }

      return runtime.state;
    }
  }

  await initializeEffectiveExecutionContext(runtime, params.workflow);

  for (const step of params.workflow.steps) {
    const stepState = getStepState(runtime.state, step.id);

    if (
      mode !== "fresh" &&
      (stepState?.status === "completed" || stepState?.status === "skipped")
    ) {
      continue;
    }

    runtime.state = {
      ...runtime.state,
      current_step: step.id,
    };

    if (stepState === undefined) {
      return failTechnically(runtime, {
        stepId: step.id,
        message: `step "${step.id}" is missing from run state`,
        markStep: false,
      });
    }

    const replayingLoop =
      step.uses === "loop" && runtime.replayLoopId === step.id;

    if (
      stepState.status !== "pending" &&
      !(replayingLoop && stepState.status === "running")
    ) {
      return failTechnically(runtime, {
        stepId: step.id,
        message:
          `step "${step.id}" must have status "pending" before execution; ` +
          `found "${stepState.status}"`,
      });
    }

    if (runtime.signal?.aborted === true && step.uses !== "approval") {
      if (replayingLoop) {
        await interruptLoop(runtime, step.id);
      } else {
        await interruptBeforeStep(runtime, step.id);
      }

      return runtime.state;
    }

    let outcome: StepOutcome;

    switch (step.uses) {
      case "shell":
      case "approval":
      case "agent":
        outcome = await executeTopLevelNonLoopStep(runtime, step);
        break;
      case "loop":
        outcome = await executeLoopStep(runtime, step);
        break;
      default:
        return failTechnically(runtime, {
          stepId: (step as WorkflowStep).id,
          message:
            `step "${(step as WorkflowStep).id}" uses unsupported step ` +
            `type "${String((step as WorkflowStep).uses)}"`,
        });
    }

    if (
      outcome === "waiting" ||
      outcome === "failed" ||
      outcome === "interrupted"
    ) {
      return runtime.state;
    }
  }

  runtime.state = setRunStatus(runtime.state, "completed");
  delete runtime.state.current_step;
  const completedAt = readClock(runtime.clock, runtime.state.id);
  await persistRuntimeState(runtime, completedAt);
  return runtime.state;
}

async function initializeEffectiveExecutionContext(
  runtime: ExecutionRuntime,
  workflow: Workflow,
): Promise<void> {
  const persistedArtifacts: Record<string, string> = {};
  let revisionContext: RevisionContext | undefined;

  try {
    for (const name of Object.keys(runtime.state.artifacts)) {
      persistedArtifacts[name] = await readArtifact({
        runsRoot: runtime.runsRoot,
        state: runtime.state,
        name,
      });
    }

    const pendingRevision = getPendingRevision(runtime.state);

    if (pendingRevision !== undefined) {
      const previousArtifact = pendingRevision.previous_artifact;
      revisionContext = {
        targetStep: pendingRevision.target_step,
        requestedAt: pendingRevision.requested_at,
        feedback: pendingRevision.feedback,
        ...(previousArtifact === undefined
          ? {}
          : {
              previousArtifact: await readArtifactVersion({
                runsRoot: runtime.runsRoot,
                state: runtime.state,
                name: previousArtifact.name,
                path: previousArtifact.path,
              }),
              previousArtifactName: previousArtifact.name,
              previousArtifactPath: previousArtifact.path,
            }),
      };
    }
  } catch (cause) {
    const step =
      workflow.steps.find(
        (candidate) =>
          getStepState(runtime.state, candidate.id)?.status === "pending",
      ) ?? workflow.steps[0];

    if (step === undefined) {
      throw new ExecutionError(
        `could not load persisted artifact context: ${getErrorMessage(cause)}`,
        { runId: runtime.state.id, cause },
      );
    }

    runtime.state = {
      ...runtime.state,
      current_step: step.id,
    };
    return failTechnically(runtime, {
      stepId: step.id,
      message:
        `could not load persisted artifact context: ` +
        getErrorMessage(cause),
      cause,
      markStep: getStepState(runtime.state, step.id) !== undefined,
    });
  }

  runtime.context = {
    ...runtime.context,
    artifacts: {
      ...(runtime.context.artifacts ?? {}),
      ...persistedArtifacts,
    },
    ...(revisionContext === undefined ? {} : { revision: revisionContext }),
  };
}

async function executeTopLevelNonLoopStep(
  runtime: ExecutionRuntime,
  step: Extract<WorkflowStep, { uses: "shell" | "approval" | "agent" }>,
): Promise<StepOutcome> {
  const shouldExecute = await evaluateStepWhen(runtime, step);

  if (!shouldExecute) {
    return "skipped";
  }

  if (step.uses === "approval") {
    runtime.state = patchStepState(runtime.state, step.id, {
      status: "waiting",
    });
    runtime.state = setRunStatus(runtime.state, "waiting");
    const waitingAt = readClock(runtime.clock, runtime.state.id, step.id);
    await persistRuntimeState(runtime, waitingAt, step.id);
    emitStepStarted(runtime, step, waitingAt, { kind: "top-level" });
    emitExecutionEvent(runtime, {
      type: "approval.waiting",
      stepId: step.id,
      ...(step.message === undefined ? {} : { message: step.message }),
    });
    return "waiting";
  }

  if (step.uses === "agent") {
    return executeAgentStep(runtime, step, { kind: "top-level" });
  }

  return executeShellStep(runtime, step, { kind: "top-level" });
}

async function executeLoopStep(
  runtime: ExecutionRuntime,
  loop: LoopStep,
): Promise<StepOutcome> {
  let replayingCurrentIteration = runtime.replayLoopId === loop.id;

  if (!replayingCurrentIteration) {
    const shouldExecute = await evaluateStepWhen(runtime, loop);

    if (!shouldExecute) {
      return "skipped";
    }
  }

  await validateInitialLoopChildren(runtime, loop);

  const initialLoopState = getStepState(runtime.state, loop.id);

  if (initialLoopState === undefined) {
    return failTechnically(runtime, {
      stepId: loop.id,
      message: `loop step "${loop.id}" is missing from run state`,
      markStep: false,
    });
  }

  if (
    (!replayingCurrentIteration &&
      initialLoopState.status !== "pending") ||
    (replayingCurrentIteration && initialLoopState.status !== "running")
  ) {
    return failTechnically(runtime, {
      stepId: loop.id,
      message:
        `loop step "${loop.id}" has invalid status for execution: ` +
        `"${initialLoopState.status}"`,
    });
  }

  if (
    !replayingCurrentIteration &&
    initialLoopState.attempt >= loop.max_attempts
  ) {
    return failTechnically(runtime, {
      stepId: loop.id,
      message:
        `loop step "${loop.id}" cannot start with attempt ` +
        `${initialLoopState.attempt}; max_attempts is ${loop.max_attempts}`,
    });
  }

  if (runtime.signal?.aborted === true) {
    if (replayingCurrentIteration) {
      await interruptLoop(runtime, loop.id);
    } else {
      await interruptBeforeStep(runtime, loop.id);
    }

    return "interrupted";
  }

  while (true) {
    await startLoopIteration(runtime, loop, !replayingCurrentIteration);
    replayingCurrentIteration = false;
    runtime.replayLoopId = undefined;

    if (isAbortRequested(runtime.signal)) {
      await interruptLoop(runtime, loop.id);
      return "interrupted";
    }

    for (const child of loop.steps) {
      const outcome = await executeLoopChild(runtime, loop, child);

      if (outcome === "interrupted") {
        return outcome;
      }
    }

    if (isAbortRequested(runtime.signal)) {
      await interruptLoop(runtime, loop.id);
      return "interrupted";
    }

    let satisfied: boolean;

    try {
      satisfied = evaluateCondition(
        loop.until,
        createExecutionTemplateContext(runtime.state, runtime.context),
      );
    } catch (cause) {
      const message =
        `loop step "${loop.id}" until condition failed: ` +
        getErrorMessage(cause);
      return failTechnically(runtime, {
        stepId: loop.id,
        message,
        cause,
      });
    }

    if (satisfied) {
      const completedAt = readClock(
        runtime.clock,
        runtime.state.id,
        loop.id,
      );
      runtime.state = patchStepState(runtime.state, loop.id, {
        status: "completed",
        success: true,
        completed_at: completedAt.toISOString(),
      });
      await persistRuntimeState(runtime, completedAt, loop.id);
      emitStepCompleted(runtime, loop.id, completedAt);
      return "completed";
    }

    const loopState = getStepState(runtime.state, loop.id);

    if (loopState === undefined) {
      return failTechnically(runtime, {
        stepId: loop.id,
        message: `loop step "${loop.id}" is missing from run state`,
        markStep: false,
      });
    }

    if (loopState.attempt >= loop.max_attempts) {
      const waitingAt = readClock(
        runtime.clock,
        runtime.state.id,
        loop.id,
      );
      runtime.state = patchStepState(runtime.state, loop.id, {
        status: "waiting",
        success: false,
        completed_at: undefined,
      });
      runtime.state = setRunStatus(runtime.state, "waiting");
      await persistRuntimeState(runtime, waitingAt, loop.id);
      emitExecutionEvent(runtime, {
        type: "step.waiting",
        stepId: loop.id,
        message: `waiting after ${loop.max_attempts} attempts`,
      });
      return "waiting";
    }

    await resetLoopChildren(runtime, loop);
  }
}

async function validateInitialLoopChildren(
  runtime: ExecutionRuntime,
  loop: LoopStep,
): Promise<void> {
  for (const child of loop.steps) {
    const childState = getStepState(runtime.state, child.id);

    if (childState === undefined) {
      return failTechnically(runtime, {
        stepId: child.id,
        parentLoopId: loop.id,
        message:
          `child step "${child.id}" of loop "${loop.id}" is missing ` +
          "from run state",
        markStep: false,
      });
    }

    if (childState.status !== "pending") {
      return failTechnically(runtime, {
        stepId: child.id,
        parentLoopId: loop.id,
        message:
          `child step "${child.id}" of loop "${loop.id}" must have ` +
          `status "pending" before initial execution; found ` +
          `"${childState.status}"`,
      });
    }
  }
}

async function startLoopIteration(
  runtime: ExecutionRuntime,
  loop: LoopStep,
  incrementAttempt: boolean,
): Promise<void> {
  const loopState = getStepState(runtime.state, loop.id);

  if (loopState === undefined) {
    return failTechnically(runtime, {
      stepId: loop.id,
      message: `loop step "${loop.id}" is missing from run state`,
      markStep: false,
    });
  }

  if (loopState.status !== "pending" && loopState.status !== "running") {
    return failTechnically(runtime, {
      stepId: loop.id,
      message:
        `loop step "${loop.id}" must be pending or running before an ` +
        `iteration; found "${loopState.status}"`,
    });
  }

  const startedAt = readClock(runtime.clock, runtime.state.id, loop.id);
  const firstIteration = loopState.status === "pending";
  const nextLoopState: StepState = {
    status: "running",
    attempt: loopState.attempt + (incrementAttempt ? 1 : 0),
    started_at: firstIteration
      ? startedAt.toISOString()
      : (loopState.started_at ?? startedAt.toISOString()),
  };

  runtime.state = replaceStepState(
    runtime.state,
    loop.id,
    nextLoopState,
  );
  await persistRuntimeState(runtime, startedAt, loop.id);
  emitStepStarted(runtime, loop, startedAt, { kind: "top-level" });
  emitExecutionEvent(runtime, {
    type: "loop.iteration.started",
    stepId: loop.id,
    attempt: nextLoopState.attempt,
    maxAttempts: loop.max_attempts,
  });
}

async function executeLoopChild(
  runtime: ExecutionRuntime,
  loop: LoopStep,
  child: WorkflowStep,
): Promise<StepOutcome> {
  const childState = getStepState(runtime.state, child.id);

  if (childState === undefined) {
    return failTechnically(runtime, {
      stepId: child.id,
      parentLoopId: loop.id,
      message:
        `child step "${child.id}" of loop "${loop.id}" is missing ` +
        "from run state",
      markStep: false,
    });
  }

  if (childState.status !== "pending") {
    return failTechnically(runtime, {
      stepId: child.id,
      parentLoopId: loop.id,
      message:
        `child step "${child.id}" of loop "${loop.id}" must have ` +
        `status "pending" before execution; found ` +
        `"${childState.status}"`,
    });
  }

  if (runtime.signal?.aborted === true) {
    await interruptLoop(runtime, loop.id);
    return "interrupted";
  }

  const shouldExecute = await evaluateStepWhen(runtime, child, loop.id);

  if (!shouldExecute) {
    return "skipped";
  }

  switch (child.uses) {
    case "shell":
      return executeShellStep(runtime, child, {
        kind: "loop-child",
        loopId: loop.id,
      });
    case "agent":
      return executeAgentStep(runtime, child, {
        kind: "loop-child",
        loopId: loop.id,
      });
    case "approval":
      return failTechnically(runtime, {
        stepId: child.id,
        parentLoopId: loop.id,
        message:
          "approval steps inside loops are not supported by the current " +
          "runtime",
      });
    case "loop":
      return failTechnically(runtime, {
        stepId: child.id,
        parentLoopId: loop.id,
        message:
          `step "${child.id}" uses unsupported nested step type ` +
          `"${child.uses}"`,
      });
    default:
      return failTechnically(runtime, {
        stepId: (child as WorkflowStep).id,
        parentLoopId: loop.id,
        message:
          `step "${(child as WorkflowStep).id}" uses unsupported step ` +
          `type "${String((child as WorkflowStep).uses)}"`,
      });
  }
}

async function evaluateStepWhen(
  runtime: ExecutionRuntime,
  step: WorkflowStep,
  parentLoopId?: string,
): Promise<boolean> {
  if (step.when === undefined) {
    return true;
  }

  let shouldExecute: boolean;

  try {
    shouldExecute = evaluateCondition(
      step.when,
      createExecutionTemplateContext(runtime.state, runtime.context),
    );
  } catch (cause) {
    const message =
      `step "${step.id}" when condition failed: ` + getErrorMessage(cause);
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId,
      message,
      cause,
    });
  }

  if (!shouldExecute) {
    runtime.state = patchStepState(runtime.state, step.id, {
      status: "skipped",
    });
    const skippedAt = readClock(runtime.clock, runtime.state.id, step.id);
    await persistRuntimeState(runtime, skippedAt, step.id);
    emitExecutionEvent(runtime, {
      type: "step.skipped",
      stepId: step.id,
      ...(parentLoopId === undefined ? {} : { parentStepId: parentLoopId }),
    });
    return false;
  }

  return true;
}

async function executeAgentStep(
  runtime: ExecutionRuntime,
  step: AgentStep,
  scope: StepScope,
): Promise<Extract<StepOutcome, "completed" | "interrupted">> {
  let agentRuntime: AgentRuntime;
  let command: Awaited<ReturnType<typeof loadCommand>>;
  let configuration: ReturnType<typeof resolveAgentStepConfiguration>;
  let completionSpec: ReturnType<typeof createAgentCompletionSpec>;
  let prompt: string;

  try {
    if (runtime.agentRuntime === undefined) {
      throw new ExecutionError(
        `agent step "${step.id}" requires an AgentRuntime`,
        { stepId: step.id },
      );
    }

    if (runtime.commandsDir === undefined) {
      throw new ExecutionError(
        `agent step "${step.id}" requires a commands directory`,
        { stepId: step.id },
      );
    }

    agentRuntime = runtime.agentRuntime;
    const commandPath = resolveAgentCommandPath(
      runtime.commandsDir,
      step.command,
      step.id,
    );
    command = await loadCommand(commandPath);
    configuration = resolveAgentStepConfiguration(
      step,
      command,
      runtime.context.config,
    );
    completionSpec = createAgentCompletionSpec(step);
    prompt = composeAgentPrompt(
      command.prompt,
      createExecutionTemplateContext(runtime.state, runtime.context),
      completionSpec,
    );
  } catch (cause) {
    const message =
      cause instanceof ExecutionError
        ? cause.message
        : `agent step "${step.id}" setup failed: ${getErrorMessage(cause)}`;
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message,
      cause,
    });
  }

  if (getStepState(runtime.state, step.id) === undefined) {
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message: `step "${step.id}" is missing from run state`,
      markStep: false,
    });
  }

  let result: AgentStepResult | undefined;

  for (
    let retryIndex = 0;
    retryIndex <= configuration.technicalRetries;
    retryIndex += 1
  ) {
    if (runtime.signal?.aborted === true) {
      await interruptForScopeBeforeAttempt(runtime, step.id, scope);
      return "interrupted";
    }

    const { attempt, startedAt } = await startExecutionAttempt(
      runtime,
      step.id,
    );
    emitStepStarted(runtime, step, startedAt, scope, { attempt });
    const sessionLogPath = path.join(
      getRunPaths(runtime.runsRoot, runtime.state.id).sessionsDir,
      `${step.id}-${attempt}.jsonl`,
    );

    try {
      result = await agentRuntime.runStep({
        stepId: step.id,
        prompt,
        cwd: runtime.cwd,
        ...(configuration.model === undefined
          ? {}
          : { model: configuration.model }),
        ...(configuration.thinking === undefined
          ? {}
          : { thinking: configuration.thinking }),
        tools: configuration.tools,
        timeoutSeconds: configuration.timeoutSeconds,
        signal: runtime.signal,
        sessionLogPath,
        ...(runtime.onEvent === undefined
          ? {}
          : {
              onEvent: (event) => emitExecutionEvent(runtime, event),
            }),
        completion: {
          expectedArtifacts: [...completionSpec.expectedArtifacts],
        },
      });
    } catch (cause) {
      if (isAbortRequested(runtime.signal)) {
        await interruptActiveStep(runtime, step.id, scope);
        return "interrupted";
      }

      const message =
        `agent step "${step.id}" runtime threw: ` + getErrorMessage(cause);
      const canRetry =
        isRetryableAgentRuntimeError(cause) &&
        retryIndex < configuration.technicalRetries;

      if (canRetry) {
        await persistTechnicalAttemptFailure(runtime, step.id, message);
        emitStepRetry(
          runtime,
          step.id,
          scope,
          retryIndex,
          configuration.technicalRetries,
        );
        continue;
      }

      return failTechnically(runtime, {
        stepId: step.id,
        parentLoopId: getParentLoopId(scope),
        message,
        cause,
      });
    }

    if (result.aborted === true || isAbortRequested(runtime.signal)) {
      await interruptActiveStep(runtime, step.id, scope);
      return "interrupted";
    }

    if (!result.success || result.timedOut) {
      const detail =
        result.error?.trim().length === 0 || result.error === undefined
          ? undefined
          : result.error;
      const message = result.timedOut
        ? `agent step "${step.id}" timed out` +
          (detail === undefined ? "" : `: ${detail}`)
        : `agent step "${step.id}" runtime failed` +
          (detail === undefined ? "" : `: ${detail}`);
      const output = formatAgentFailureOutput(result.finalText, message);

      if (retryIndex < configuration.technicalRetries) {
        await persistTechnicalAttemptFailure(runtime, step.id, message, {
          output,
        });
        emitStepRetry(
          runtime,
          step.id,
          scope,
          retryIndex,
          configuration.technicalRetries,
        );
        continue;
      }

      return failTechnically(runtime, {
        stepId: step.id,
        parentLoopId: getParentLoopId(scope),
        message,
        stepPatch: { output },
      });
    }

    break;
  }

  if (result === undefined) {
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message: `agent step "${step.id}" produced no execution result`,
    });
  }

  if (result.completion === undefined) {
    if (result.completionError !== undefined) {
      const detail =
        result.completionError.trim().length === 0
          ? "unspecified completion protocol error"
          : result.completionError;
      const message =
        `agent step "${step.id}" completion protocol failed: ${detail}`;
      return failTechnically(runtime, {
        stepId: step.id,
        parentLoopId: getParentLoopId(scope),
        message,
        stepPatch: {
          output: formatAgentFailureOutput(result.finalText, message),
        },
      });
    }

    const message =
      `agent step "${step.id}" completed without calling complete_step`;
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message,
      stepPatch: {
        output: formatAgentFailureOutput(result.finalText, message),
      },
    });
  }

  const validation = validateAgentCompletion(
    result.completion,
    completionSpec,
  );

  if (!validation.success) {
    const message =
      `agent step "${step.id}" returned invalid complete_step completion: ` +
      validation.error;
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message,
      stepPatch: {
        output: formatAgentFailureOutput(result.finalText, message),
      },
    });
  }

  if (isAbortRequested(runtime.signal)) {
    await interruptActiveStep(runtime, step.id, scope);
    return "interrupted";
  }

  const completion = validation.completion;
  let storedArtifactPath: string | undefined;

  if (step.artifact !== undefined) {
    const artifact = completion.artifacts.find(
      (candidate) => candidate.name === step.artifact?.name,
    );

    if (artifact === undefined) {
      const message =
        `agent step "${step.id}" completion omitted artifact ` +
        `"${step.artifact.name}"`;
      return failTechnically(runtime, {
        stepId: step.id,
        parentLoopId: getParentLoopId(scope),
        message,
        stepPatch: {
          output: formatAgentFailureOutput(result.finalText, message),
        },
      });
    }

    try {
      const written = await writeArtifact({
        runsRoot: runtime.runsRoot,
        state: runtime.state,
        name: step.artifact.name,
        filename: step.artifact.filename,
        versioned: step.artifact.versioned ?? false,
        content: artifact.content,
      });
      runtime.state = written.state;
      storedArtifactPath = written.path;
      emitExecutionEvent(runtime, {
        type: "artifact.written",
        stepId: step.id,
        artifact: written.path,
        ...(scope.kind === "loop-child"
          ? { parentStepId: scope.loopId }
          : {}),
      });
      runtime.context = {
        ...runtime.context,
        artifacts: {
          ...(runtime.context.artifacts ?? {}),
          [step.artifact.name]: artifact.content,
        },
      };
    } catch (cause) {
      const message =
        `agent step "${step.id}" could not persist artifact ` +
        `"${step.artifact.name}": ${getErrorMessage(cause)}`;
      return failTechnically(runtime, {
        stepId: step.id,
        parentLoopId: getParentLoopId(scope),
        message,
        cause,
        stepPatch: {
          output: formatAgentFailureOutput(result.finalText, message),
        },
      });
    }
  }

  if (isAbortRequested(runtime.signal)) {
    await interruptActiveStep(runtime, step.id, scope);
    return "interrupted";
  }

  const completedAt = readClock(runtime.clock, runtime.state.id, step.id);
  const runningState = getStepState(runtime.state, step.id);

  if (runningState === undefined) {
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message: `step "${step.id}" is missing from run state after agent execution`,
      markStep: false,
    });
  }

  runtime.state = replaceStepState(
    resolveRevisionForStep(runtime.state, step.id, completedAt),
    step.id,
    {
      status: "completed",
      attempt: runningState.attempt,
      ...(runningState.started_at === undefined
        ? {}
        : { started_at: runningState.started_at }),
      completed_at: completedAt.toISOString(),
      success: true,
      summary: completion.summary,
      ...(storedArtifactPath === undefined
        ? {}
        : { artifact: storedArtifactPath }),
      ...(result.finalText.trim().length === 0
        ? {}
        : { output: result.finalText }),
    },
  );
  await persistRuntimeState(runtime, completedAt, step.id);
  emitStepCompleted(runtime, step.id, completedAt, scope);
  return "completed";
}

function formatAgentFailureOutput(
  finalText: string,
  message: string,
): string {
  const error = `ERROR:\n${message}`;

  return finalText.trim().length === 0
    ? error
    : `FINAL RESPONSE:\n${finalText}\n\n${error}`;
}

async function executeShellStep(
  runtime: ExecutionRuntime,
  step: ShellStep,
  scope: StepScope,
): Promise<Extract<StepOutcome, "completed" | "failed" | "interrupted">> {
  let prepared: PreparedShellStep;
  let timeout: number;
  let technicalRetries: number;

  try {
    prepared = prepareShellStep(
      step,
      createExecutionTemplateContext(runtime.state, runtime.context),
    );
    timeout = resolveShellTimeout(step.timeout, runtime.shellTimeout);
    technicalRetries = resolveTechnicalRetryCount({
      config: runtime.context.config.defaults?.technical_retries,
    });
  } catch (cause) {
    const message =
      cause instanceof ExecutionError
        ? cause.message
        : `step "${step.id}" shell setup failed: ${getErrorMessage(cause)}`;
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message,
      cause,
    });
  }

  if (getStepState(runtime.state, step.id) === undefined) {
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message: `step "${step.id}" is missing from run state`,
      markStep: false,
    });
  }

  const command = prepared.commands[0];

  if (!prepared.multiCommand && command === undefined) {
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message: `step "${step.id}" has no shell command to execute`,
    });
  }

  for (
    let retryIndex = 0;
    retryIndex <= technicalRetries;
    retryIndex += 1
  ) {
    if (runtime.signal?.aborted === true) {
      await interruptForScopeBeforeAttempt(runtime, step.id, scope);
      return "interrupted";
    }

    const { attempt, startedAt } = await startExecutionAttempt(
      runtime,
      step.id,
    );
    emitStepStarted(runtime, step, startedAt, scope, { attempt });

    if (prepared.multiCommand) {
      let execution: Awaited<ReturnType<typeof executeMultipleCommands>>;

      try {
        execution = await executeMultipleCommands({
          commands: prepared.commands,
          cwd: runtime.cwd,
          timeout,
          signal: runtime.signal,
          shellRunner: runtime.shellRunner,
          stepId: step.id,
          runtime,
          scope,
        });
      } catch (cause) {
        if (isShellAbort(cause, runtime.signal)) {
          await interruptActiveStep(runtime, step.id, scope);
          return "interrupted";
        }

        const message =
          `step "${step.id}" shell execution failed: ` +
          getErrorMessage(cause);
        const failure = makeRuntimeFailureResult(cause);

        if (retryIndex < technicalRetries) {
          await persistTechnicalAttemptFailure(runtime, step.id, message, {
            exit_code: failure.exitCode,
            output: failure.output,
          });
          emitStepRetry(runtime, step.id, scope, retryIndex, technicalRetries);
          continue;
        }

        return failTechnically(runtime, {
          stepId: step.id,
          parentLoopId: getParentLoopId(scope),
          message,
          cause,
          stepPatch: {
            exit_code: failure.exitCode,
            output: failure.output,
          },
        });
      }

      if (isAbortRequested(runtime.signal)) {
        await interruptActiveStep(runtime, step.id, scope);
        return "interrupted";
      }

      const aggregate = aggregateCommandResults(execution.commands);

      if (execution.runtimeFailure !== undefined) {
        const failure = execution.runtimeFailure;

        if (retryIndex < technicalRetries) {
          await persistTechnicalAttemptFailure(
            runtime,
            step.id,
            failure.message,
            {
              exit_code: aggregate.exitCode,
              output: aggregate.output,
            },
          );
          emitStepRetry(runtime, step.id, scope, retryIndex, technicalRetries);
          continue;
        }

        return failTechnically(runtime, {
          stepId: step.id,
          parentLoopId: getParentLoopId(scope),
          message: failure.message,
          cause: failure.cause,
          stepPatch: {
            exit_code: aggregate.exitCode,
            output: aggregate.output,
          },
        });
      }

      return persistShellResult(runtime, step.id, aggregate, scope);
    }

    let result: ShellCommandResult;
    const shellCommand = command?.command ?? "";
    const shellStartedAt = performance.now();
    emitShellStarted(runtime, step.id, shellCommand, scope);

    try {
      result = await runtime.shellRunner({
        command: shellCommand,
        cwd: runtime.cwd,
        timeout,
        signal: runtime.signal,
      });
    } catch (cause) {
      if (isShellAbort(cause, runtime.signal)) {
        await interruptActiveStep(runtime, step.id, scope);
        return "interrupted";
      }

      const detail = getErrorMessage(cause);
      const message = `step "${step.id}" shell execution failed: ${detail}`;
      const failure = makeRuntimeFailureResult(cause);
      emitShellCompleted(runtime, step.id, failure, scope, shellStartedAt);

      if (retryIndex < technicalRetries) {
        await persistTechnicalAttemptFailure(runtime, step.id, message, {
          exit_code: failure.exitCode,
          output: failure.output,
        });
        emitStepRetry(runtime, step.id, scope, retryIndex, technicalRetries);
        continue;
      }

      return failTechnically(runtime, {
        stepId: step.id,
        parentLoopId: getParentLoopId(scope),
        message,
        cause,
        stepPatch: {
          exit_code: failure.exitCode,
          output: failure.output,
        },
      });
    }

    if (isAbortRequested(runtime.signal)) {
      await interruptActiveStep(runtime, step.id, scope);
      return "interrupted";
    }

    const normalized = normalizeShellResult(result);
    emitShellCompleted(runtime, step.id, normalized, scope, shellStartedAt);
    return persistShellResult(runtime, step.id, normalized, scope);
  }

  return failTechnically(runtime, {
    stepId: step.id,
    parentLoopId: getParentLoopId(scope),
    message: `step "${step.id}" exhausted without a shell result`,
  });
}

function prepareShellStep(
  step: ShellStep,
  context: ReturnType<typeof createExecutionTemplateContext>,
): PreparedShellStep {
  const hasRun = typeof step.run === "string";
  const hasCommands = Array.isArray(step.commands);

  if (hasRun === hasCommands) {
    throw new ExecutionError(
      `step "${step.id}" must define exactly one of "run" or "commands"`,
      { stepId: step.id },
    );
  }

  if (hasRun) {
    return {
      commands: [
        {
          command: interpolateShellCommand(
            step.id,
            step.run as string,
            context,
          ),
        },
      ],
      multiCommand: false,
    };
  }

  const commands = step.commands;

  if (commands === undefined || commands.length === 0) {
    throw new ExecutionError(
      `step "${step.id}" must define at least one shell command`,
      { stepId: step.id },
    );
  }

  return {
    commands: commands.map((command) => ({
      name: command.name,
      command: interpolateShellCommand(step.id, command.run, context),
    })),
    multiCommand: true,
  };
}

function interpolateShellCommand(
  stepId: string,
  source: string,
  context: ReturnType<typeof createExecutionTemplateContext>,
): string {
  const command = interpolateTemplate(source, context);

  if (command.trim().length === 0) {
    throw new ExecutionError(
      `step "${stepId}" shell command is empty after interpolation`,
      { stepId },
    );
  }

  return command;
}

function resolveShellTimeout(
  stepTimeout: number | undefined,
  defaultTimeout: number | undefined,
): number {
  const timeout =
    stepTimeout ?? defaultTimeout ?? DEFAULT_SHELL_TIMEOUT_SECONDS;

  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError("timeout must be a positive number of seconds");
  }

  return timeout;
}

async function executeMultipleCommands(params: {
  commands: readonly PreparedShellCommand[];
  cwd: string;
  timeout: number;
  signal?: AbortSignal;
  shellRunner: ShellRunner;
  stepId: string;
  runtime: ExecutionRuntime;
  scope: StepScope;
}): Promise<{
  commands: CommandExecution[];
  runtimeFailure?: RuntimeFailure;
}> {
  const commands: CommandExecution[] = [];
  let runtimeFailure: RuntimeFailure | undefined;

  for (const command of params.commands) {
    if (params.signal?.aborted === true) {
      throw makeShellAbortError();
    }

    const name = command.name ?? "command";
    let result: ShellCommandResult;
    const shellStartedAt = performance.now();
    emitShellStarted(
      params.runtime,
      params.stepId,
      command.command,
      params.scope,
    );

    try {
      result = normalizeShellResult(
        await params.shellRunner({
          command: command.command,
          cwd: params.cwd,
          timeout: params.timeout,
          signal: params.signal,
        }),
      );

      if (isAbortRequested(params.signal)) {
        throw makeShellAbortError();
      }
    } catch (cause) {
      if (isShellAbort(cause, params.signal)) {
        emitShellCompleted(
          params.runtime,
          params.stepId,
          makeRuntimeFailureResult(cause),
          params.scope,
          shellStartedAt,
        );
        throw cause;
      }

      const detail = getErrorMessage(cause);
      result = makeRuntimeFailureResult(cause);
      runtimeFailure ??= {
        cause,
        message:
          `step "${params.stepId}" command "${name}" shell execution ` +
          `failed: ${detail}`,
      };
    }

    emitShellCompleted(
      params.runtime,
      params.stepId,
      result,
      params.scope,
      shellStartedAt,
    );
    commands.push({ name, result });
  }

  return { commands, runtimeFailure };
}

function aggregateCommandResults(
  commands: readonly CommandExecution[],
): ShellCommandResult {
  const success = commands.every((command) => command.result.success);
  const firstFailure = commands.find(
    (command) => command.result.exitCode !== 0,
  );
  const exitCode = firstFailure?.result.exitCode ?? (success ? 0 : 1);
  const stdout = commands.map((command) => command.result.stdout).join("");
  const stderr = commands.map((command) => command.result.stderr).join("");
  const output = commands
    .map(
      (command) =>
        `== ${command.name} ==\nexit_code: ${command.result.exitCode}\n\n` +
        command.result.output,
    )
    .join("\n\n");

  return {
    exitCode,
    stdout,
    stderr,
    output,
    success,
  };
}

function normalizeShellResult(result: ShellCommandResult): ShellCommandResult {
  const success = result.success && result.exitCode === 0;

  return success === result.success ? result : { ...result, success };
}

function makeRuntimeFailureResult(cause: unknown): ShellCommandResult {
  const detail = getErrorMessage(cause);

  if (cause instanceof ShellCommandError) {
    return {
      exitCode: cause.exitCode,
      stdout: cause.stdout,
      stderr: cause.stderr,
      output: appendError(cause.output, detail),
      success: false,
    };
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: "",
    output: `ERROR:\n${detail}`,
    success: false,
  };
}

function appendError(output: string, message: string): string {
  return `${output}\n\nERROR:\n${message}`;
}

async function persistShellResult(
  runtime: ExecutionRuntime,
  stepId: string,
  result: ShellCommandResult,
  scope: StepScope,
): Promise<Extract<StepOutcome, "completed" | "failed">> {
  const completedAt = readClock(runtime.clock, runtime.state.id, stepId);
  runtime.state = patchStepState(runtime.state, stepId, {
    status: result.success ? "completed" : "failed",
    completed_at: completedAt.toISOString(),
    success: result.success,
    exit_code: result.exitCode,
    output: result.output,
  });

  if (!result.success && scope.kind === "top-level") {
    runtime.state = setRunStatus(runtime.state, "failed");
  }

  await persistRuntimeState(runtime, completedAt, stepId);

  if (result.success) {
    emitStepCompleted(runtime, stepId, completedAt, scope);
  } else {
    emitStepFailed(runtime, stepId, completedAt, undefined, scope);
  }

  return result.success ? "completed" : "failed";
}

async function startExecutionAttempt(
  runtime: ExecutionRuntime,
  stepId: string,
): Promise<{ attempt: number; startedAt: Date }> {
  const stepState = getStepState(runtime.state, stepId);

  if (stepState === undefined) {
    return failTechnically(runtime, {
      stepId,
      message: `step "${stepId}" is missing from run state before attempt`,
      markStep: false,
    });
  }

  const attempt = stepState.attempt + 1;
  const startedAt = readClock(runtime.clock, runtime.state.id, stepId);
  runtime.state = replaceStepState(runtime.state, stepId, {
    status: "running",
    attempt,
    started_at: startedAt.toISOString(),
  });
  await persistRuntimeState(runtime, startedAt, stepId);
  return { attempt, startedAt };
}

async function persistTechnicalAttemptFailure(
  runtime: ExecutionRuntime,
  stepId: string,
  message: string,
  patch: Pick<StepState, "exit_code" | "output"> = {},
): Promise<void> {
  const stepState = getStepState(runtime.state, stepId);

  if (stepState === undefined) {
    return failTechnically(runtime, {
      stepId,
      message: `step "${stepId}" is missing after a technical attempt failure`,
      markStep: false,
    });
  }

  runtime.state = replaceStepState(runtime.state, stepId, {
    status: "running",
    attempt: stepState.attempt,
    ...(stepState.started_at === undefined
      ? {}
      : { started_at: stepState.started_at }),
    success: false,
    ...(patch.exit_code === undefined ? {} : { exit_code: patch.exit_code }),
    output: patch.output ?? `ERROR:\n${message}`,
  });
  const failedAt = readClock(runtime.clock, runtime.state.id, stepId);
  await persistRuntimeState(runtime, failedAt, stepId);
}

async function interruptForScopeBeforeAttempt(
  runtime: ExecutionRuntime,
  stepId: string,
  scope: StepScope,
): Promise<void> {
  const state = getStepState(runtime.state, stepId);

  if (state?.status === "running") {
    await interruptActiveStep(runtime, stepId, scope);
    return;
  }

  if (scope.kind === "loop-child") {
    await interruptLoop(runtime, scope.loopId);
    return;
  }

  await interruptBeforeStep(runtime, stepId);
}

async function interruptBeforeStep(
  runtime: ExecutionRuntime,
  stepId: string,
): Promise<void> {
  runtime.state = {
    ...setRunStatus(runtime.state, "interrupted"),
    current_step: stepId,
  };
  const interruptedAt = readClock(runtime.clock, runtime.state.id, stepId);
  await persistRuntimeState(runtime, interruptedAt, stepId);
}

async function interruptActiveStep(
  runtime: ExecutionRuntime,
  stepId: string,
  scope: StepScope,
): Promise<void> {
  const stepState = getStepState(runtime.state, stepId);

  if (stepState === undefined) {
    return failTechnically(runtime, {
      stepId,
      parentLoopId: getParentLoopId(scope),
      message: `active step "${stepId}" is missing during interruption`,
      markStep: false,
    });
  }

  let state = replaceStepState(runtime.state, stepId, {
    status: "interrupted",
    attempt: stepState.attempt,
    ...(stepState.started_at === undefined
      ? {}
      : { started_at: stepState.started_at }),
    success: false,
    output: "INTERRUPTED:\nexecution aborted by external signal",
  });
  const logicalStepId =
    scope.kind === "loop-child" ? scope.loopId : stepId;

  if (scope.kind === "loop-child") {
    state = markLoopInterrupted(state, scope.loopId);
  }

  runtime.state = {
    ...setRunStatus(state, "interrupted"),
    current_step: logicalStepId,
  };
  const interruptedAt = readClock(runtime.clock, runtime.state.id, stepId);
  await persistRuntimeState(runtime, interruptedAt, stepId);
}

async function interruptLoop(
  runtime: ExecutionRuntime,
  loopId: string,
): Promise<void> {
  runtime.state = {
    ...setRunStatus(markLoopInterrupted(runtime.state, loopId), "interrupted"),
    current_step: loopId,
  };
  const interruptedAt = readClock(runtime.clock, runtime.state.id, loopId);
  await persistRuntimeState(runtime, interruptedAt, loopId);
}

function markLoopInterrupted(state: RunState, loopId: string): RunState {
  const loopState = getStepState(state, loopId);

  if (loopState === undefined) {
    throw new ExecutionError(
      `loop step "${loopId}" is missing during interruption`,
      { runId: state.id, stepId: loopId },
    );
  }

  return replaceStepState(state, loopId, {
    status: "interrupted",
    attempt: loopState.attempt,
    ...(loopState.started_at === undefined
      ? {}
      : { started_at: loopState.started_at }),
    success: false,
    output: "INTERRUPTED:\nexecution aborted by external signal",
  });
}

function isRetryableAgentRuntimeError(cause: unknown): boolean {
  return !(
    cause instanceof AgentRuntimeError &&
    (cause.kind === "invalid-request" || cause.kind === "model-resolution")
  );
}

function isAbortRequested(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function isShellAbort(cause: unknown, signal?: AbortSignal): boolean {
  return (
    isAbortRequested(signal) ||
    (cause instanceof ShellCommandError && cause.kind === "aborted")
  );
}

function makeShellAbortError(): ShellCommandError {
  return new ShellCommandError("shell command aborted by external signal", {
    kind: "aborted",
  });
}

async function resetLoopChildren(
  runtime: ExecutionRuntime,
  loop: LoopStep,
): Promise<void> {
  const nextSteps = { ...runtime.state.steps };

  for (const child of loop.steps) {
    const childState = getStepState(runtime.state, child.id);

    if (childState === undefined) {
      return failTechnically(runtime, {
        stepId: child.id,
        parentLoopId: loop.id,
        message:
          `child step "${child.id}" of loop "${loop.id}" is missing ` +
          "from run state during replay reset",
        markStep: false,
      });
    }

    nextSteps[child.id] = {
      status: "pending",
      attempt: childState.attempt,
    };
  }

  runtime.state = {
    ...runtime.state,
    steps: nextSteps,
  };
  const resetAt = readClock(runtime.clock, runtime.state.id, loop.id);
  await persistRuntimeState(runtime, resetAt, loop.id);
}

async function failTechnically(
  runtime: ExecutionRuntime,
  params: TechnicalFailureParams,
): Promise<never> {
  const failedAt = readClock(
    runtime.clock,
    runtime.state.id,
    params.stepId,
  );
  let state = runtime.state;
  const stepState = getStepState(state, params.stepId);

  if (params.markStep !== false && stepState !== undefined) {
    state = patchStepState(state, params.stepId, {
      status: "failed",
      completed_at: failedAt.toISOString(),
      success: false,
      exit_code: undefined,
      output: `ERROR:\n${params.message}`,
      ...params.stepPatch,
    });
  }

  if (
    params.parentLoopId !== undefined &&
    params.parentLoopId !== params.stepId
  ) {
    const loopState = getStepState(state, params.parentLoopId);

    if (loopState !== undefined) {
      state = patchStepState(state, params.parentLoopId, {
        status: "failed",
        completed_at: failedAt.toISOString(),
        success: false,
        exit_code: undefined,
        output: `ERROR:\n${params.message}`,
      });
    }
  }

  state = setRunStatus(state, "failed");
  runtime.state = state;
  await persistRuntimeState(runtime, failedAt, params.stepId);

  const failedScope: StepScope =
    params.parentLoopId === undefined
      ? { kind: "top-level" }
      : { kind: "loop-child", loopId: params.parentLoopId };
  emitStepFailed(
    runtime,
    params.stepId,
    failedAt,
    params.message,
    failedScope,
  );

  if (
    params.parentLoopId !== undefined &&
    params.parentLoopId !== params.stepId
  ) {
    emitStepFailed(
      runtime,
      params.parentLoopId,
      failedAt,
      params.message,
      { kind: "top-level" },
    );
  }

  throw new ExecutionError(params.message, {
    runId: runtime.state.id,
    stepId: params.stepId,
    cause: params.cause,
  });
}

async function persistRuntimeState(
  runtime: ExecutionRuntime,
  now: Date,
  stepId?: string,
): Promise<void> {
  try {
    await saveRun(runtime.runsRoot, runtime.state, now);
  } catch (cause) {
    throw new ExecutionError(
      `could not persist run "${runtime.state.id}": ${getErrorMessage(cause)}`,
      { runId: runtime.state.id, stepId, cause },
    );
  }
}

function replaceStepState(
  state: RunState,
  stepId: string,
  stepState: StepState,
): RunState {
  return {
    ...state,
    steps: {
      ...state.steps,
      [stepId]: stepState,
    },
  };
}

function emitStepStarted(
  runtime: ExecutionRuntime,
  step: WorkflowStep,
  startedAt: Date,
  scope: StepScope,
  metadata: { attempt?: number } = {},
): void {
  if (runtime.observableSteps.has(step.id)) {
    return;
  }

  runtime.observableSteps.set(step.id, {
    startedAtMs: startedAt.getTime(),
  });
  emitExecutionEvent(runtime, {
    type: "step.started",
    stepId: step.id,
    stepType: step.uses,
    ...(scope.kind === "loop-child"
      ? { parentStepId: scope.loopId }
      : {}),
    ...(metadata.attempt === undefined
      ? {}
      : { attempt: metadata.attempt }),
  });
}

function emitStepCompleted(
  runtime: ExecutionRuntime,
  stepId: string,
  completedAt: Date,
  scope: StepScope = { kind: "top-level" },
): void {
  emitExecutionEvent(runtime, {
    type: "step.completed",
    stepId,
    success: true,
    ...stepTiming(runtime, stepId, completedAt),
    ...(scope.kind === "loop-child"
      ? { parentStepId: scope.loopId }
      : {}),
  });
  runtime.observableSteps.delete(stepId);
}

function emitStepFailed(
  runtime: ExecutionRuntime,
  stepId: string,
  completedAt: Date,
  error?: string,
  scope: StepScope = { kind: "top-level" },
): void {
  emitExecutionEvent(runtime, {
    type: "step.failed",
    stepId,
    ...stepTiming(runtime, stepId, completedAt),
    ...(error === undefined ? {} : { error: inlineEventText(error, 300) }),
    ...(scope.kind === "loop-child"
      ? { parentStepId: scope.loopId }
      : {}),
  });
  runtime.observableSteps.delete(stepId);
}

function emitStepRetry(
  runtime: ExecutionRuntime,
  stepId: string,
  scope: StepScope,
  retryIndex: number,
  maxAttempts: number,
): void {
  emitExecutionEvent(runtime, {
    type: "step.retry",
    stepId,
    attempt: retryIndex + 1,
    maxAttempts,
    ...(scope.kind === "loop-child"
      ? { parentStepId: scope.loopId }
      : {}),
  });
}

function emitShellStarted(
  runtime: ExecutionRuntime,
  stepId: string,
  command: string,
  scope: StepScope,
): void {
  emitExecutionEvent(runtime, {
    type: "shell.started",
    stepId,
    command: sanitizeDisplayText(
      command,
      MAX_SHELL_COMMAND_DISPLAY_LENGTH,
    ),
    ...(scope.kind === "loop-child"
      ? { parentStepId: scope.loopId }
      : {}),
  });
}

function emitShellCompleted(
  runtime: ExecutionRuntime,
  stepId: string,
  result: ShellCommandResult,
  scope: StepScope,
  startedAt?: number,
): void {
  emitExecutionEvent(runtime, {
    type: "shell.completed",
    stepId,
    success: result.success,
    exitCode: result.exitCode,
    ...(startedAt === undefined
      ? {}
      : { durationMs: Math.max(0, performance.now() - startedAt) }),
    ...(scope.kind === "loop-child"
      ? { parentStepId: scope.loopId }
      : {}),
  });
}

function emitExecutionEvent(
  runtime: ExecutionRuntime,
  event: AiraExecutionEvent,
): void {
  try {
    runtime.onEvent?.(event);
  } catch {
    // Operator reporting is best-effort and cannot affect workflow semantics.
  }
}

function stepTiming(
  runtime: ExecutionRuntime,
  stepId: string,
  completedAt: Date,
): { durationMs?: number } {
  const started = runtime.observableSteps.get(stepId);

  if (started === undefined) {
    return {};
  }

  return {
    durationMs: Math.max(0, completedAt.getTime() - started.startedAtMs),
  };
}

function inlineEventText(value: string, maxLength: number): string {
  const inline = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return inline.length <= maxLength
    ? inline
    : `${inline.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function getParentLoopId(scope: StepScope): string | undefined {
  return scope.kind === "loop-child" ? scope.loopId : undefined;
}

function getStepState(
  state: RunState,
  stepId: string,
): StepState | undefined {
  if (!Object.prototype.hasOwnProperty.call(state.steps, stepId)) {
    return undefined;
  }

  return state.steps[stepId];
}

function readClock(
  clock: () => Date,
  runId: string,
  stepId?: string,
): Date {
  let value: Date;

  try {
    value = clock();
  } catch (cause) {
    throw new ExecutionError(
      `execution clock failed: ${getErrorMessage(cause)}`,
      { runId, stepId, cause },
    );
  }

  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ExecutionError("execution clock must return a valid Date", {
      runId,
      stepId,
    });
  }

  return value;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
