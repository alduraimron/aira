import path from "node:path";

import { validateAgentCompletion } from "../agent/completion";
import type { AgentRuntime } from "../agent/runtime";
import type { AgentStepResult } from "../agent/types";
import { readArtifact, writeArtifact } from "../artifacts/manager";
import { loadCommand } from "../commands/loader";
import { evaluateCondition } from "../conditions/evaluator";
import { getRunPaths } from "../run/paths";
import { patchStepState, setRunStatus } from "../run/state";
import { saveRun } from "../run/persistence";
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
} from "./context";
import { ExecutionError } from "./errors";

export type ShellRunner = (
  params: RunShellCommandParams,
) => Promise<ShellCommandResult>;

export type ExecutionMode = "fresh" | "continue";

export interface ExecuteWorkflowParams {
  workflow: Workflow;
  runsRoot: string;
  state: RunState;
  context: ExecutionContextInput;
  cwd: string;
  /** Caller-resolved default timeout in seconds. */
  shellTimeout?: number;
  /** Defaults to strict fresh execution. */
  mode?: ExecutionMode;
  now?: () => Date;
  shellRunner?: ShellRunner;
  /** Required only when an agent step is reached. */
  agentRuntime?: AgentRuntime;
  /** Root containing reusable command Markdown files. */
  commandsDir?: string;
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
  context: ExecutionContextInput;
  cwd: string;
  shellTimeout?: number;
  clock: () => Date;
  shellRunner: ShellRunner;
  agentRuntime?: AgentRuntime;
  commandsDir?: string;
  state: RunState;
}

type StepOutcome = "completed" | "failed" | "skipped" | "waiting";

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
    context: params.context,
    cwd: params.cwd,
    shellTimeout: params.shellTimeout,
    clock: params.now ?? systemClock,
    shellRunner: params.shellRunner ?? runShellCommand,
    agentRuntime: params.agentRuntime,
    commandsDir: params.commandsDir,
    state: params.state,
  };

  if (mode !== "fresh" && mode !== "continue") {
    throw new ExecutionError(`unsupported execution mode "${String(mode)}"`, {
      runId: runtime.state.id,
    });
  }

  if (runtime.state.status !== "running") {
    throw new ExecutionError(
      `run "${runtime.state.id}" must have status "running" before execution; ` +
        `found "${runtime.state.status}"`,
      { runId: runtime.state.id },
    );
  }

  if (runtime.state.workflow !== params.workflow.name) {
    throw new ExecutionError(
      `run "${runtime.state.id}" was created for workflow ` +
        `"${runtime.state.workflow}" but executor received ` +
        `"${params.workflow.name}"`,
      { runId: runtime.state.id },
    );
  }

  await initializeEffectiveArtifactContext(runtime, params.workflow);

  for (const step of params.workflow.steps) {
    const stepState = getStepState(runtime.state, step.id);

    if (
      mode === "continue" &&
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

    if (stepState.status !== "pending") {
      return failTechnically(runtime, {
        stepId: step.id,
        message:
          `step "${step.id}" must have status "pending" before execution; ` +
          `found "${stepState.status}"`,
      });
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

    if (outcome === "waiting" || outcome === "failed") {
      return runtime.state;
    }
  }

  runtime.state = setRunStatus(runtime.state, "completed");
  delete runtime.state.current_step;
  const completedAt = readClock(runtime.clock, runtime.state.id);
  await persistRuntimeState(runtime, completedAt);
  return runtime.state;
}

async function initializeEffectiveArtifactContext(
  runtime: ExecutionRuntime,
  workflow: Workflow,
): Promise<void> {
  const persistedArtifacts: Record<string, string> = {};

  try {
    for (const name of Object.keys(runtime.state.artifacts)) {
      persistedArtifacts[name] = await readArtifact({
        runsRoot: runtime.runsRoot,
        state: runtime.state,
        name,
      });
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
  const shouldExecute = await evaluateStepWhen(runtime, loop);

  if (!shouldExecute) {
    return "skipped";
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

  if (initialLoopState.attempt >= loop.max_attempts) {
    return failTechnically(runtime, {
      stepId: loop.id,
      message:
        `loop step "${loop.id}" cannot start with attempt ` +
        `${initialLoopState.attempt}; max_attempts is ${loop.max_attempts}`,
    });
  }

  while (true) {
    await startLoopIteration(runtime, loop);

    for (const child of loop.steps) {
      await executeLoopChild(runtime, loop, child);
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
    attempt: loopState.attempt + 1,
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
    return false;
  }

  return true;
}

async function executeAgentStep(
  runtime: ExecutionRuntime,
  step: AgentStep,
  scope: StepScope,
): Promise<"completed"> {
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

  const stepState = getStepState(runtime.state, step.id);

  if (stepState === undefined) {
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message: `step "${step.id}" is missing from run state`,
      markStep: false,
    });
  }

  const attempt = stepState.attempt + 1;
  const sessionLogPath = path.join(
    getRunPaths(runtime.runsRoot, runtime.state.id).sessionsDir,
    `${step.id}-${attempt}.jsonl`,
  );
  const startedAt = readClock(runtime.clock, runtime.state.id, step.id);
  runtime.state = replaceStepState(runtime.state, step.id, {
    status: "running",
    attempt,
    started_at: startedAt.toISOString(),
  });
  await persistRuntimeState(runtime, startedAt, step.id);

  let result: AgentStepResult;

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
      sessionLogPath,
      completion: {
        expectedArtifacts: [...completionSpec.expectedArtifacts],
      },
    });
  } catch (cause) {
    const message =
      `agent step "${step.id}" runtime threw: ` + getErrorMessage(cause);
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message,
      cause,
    });
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
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message,
      stepPatch: {
        output: formatAgentFailureOutput(result.finalText, message),
      },
    });
  }

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

  if (result.completion === undefined) {
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

  runtime.state = replaceStepState(runtime.state, step.id, {
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
  });
  await persistRuntimeState(runtime, completedAt, step.id);
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
): Promise<Extract<StepOutcome, "completed" | "failed">> {
  let prepared: PreparedShellStep;

  try {
    prepared = prepareShellStep(
      step,
      createExecutionTemplateContext(runtime.state, runtime.context),
    );
  } catch (cause) {
    const message =
      cause instanceof ExecutionError
        ? cause.message
        : `step "${step.id}" shell command interpolation failed: ` +
          getErrorMessage(cause);
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message,
      cause,
    });
  }

  let timeout: number;

  try {
    timeout = resolveShellTimeout(step.timeout, runtime.shellTimeout);
  } catch (cause) {
    const message =
      `step "${step.id}" shell timeout is invalid: ` +
      getErrorMessage(cause);
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message,
      cause,
    });
  }

  const stepState = getStepState(runtime.state, step.id);

  if (stepState === undefined) {
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message: `step "${step.id}" is missing from run state`,
      markStep: false,
    });
  }

  const startedAt = readClock(runtime.clock, runtime.state.id, step.id);
  runtime.state = patchStepState(runtime.state, step.id, {
    status: "running",
    attempt: stepState.attempt + 1,
    started_at: startedAt.toISOString(),
    completed_at: undefined,
    success: undefined,
    exit_code: undefined,
    output: undefined,
  });
  await persistRuntimeState(runtime, startedAt, step.id);

  if (prepared.multiCommand) {
    const execution = await executeMultipleCommands({
      commands: prepared.commands,
      cwd: runtime.cwd,
      timeout,
      shellRunner: runtime.shellRunner,
      stepId: step.id,
    });
    const aggregate = aggregateCommandResults(execution.commands);

    if (execution.runtimeFailure !== undefined) {
      return failTechnically(runtime, {
        stepId: step.id,
        parentLoopId: getParentLoopId(scope),
        message: execution.runtimeFailure.message,
        cause: execution.runtimeFailure.cause,
        stepPatch: {
          exit_code: aggregate.exitCode,
          output: aggregate.output,
        },
      });
    }

    return persistShellResult(runtime, step.id, aggregate, scope);
  }

  const command = prepared.commands[0];

  if (command === undefined) {
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message: `step "${step.id}" has no shell command to execute`,
    });
  }

  let result: ShellCommandResult;

  try {
    result = await runtime.shellRunner({
      command: command.command,
      cwd: runtime.cwd,
      timeout,
    });
  } catch (cause) {
    const detail = getErrorMessage(cause);
    const message = `step "${step.id}" shell execution failed: ${detail}`;
    result = makeRuntimeFailureResult(cause);
    return failTechnically(runtime, {
      stepId: step.id,
      parentLoopId: getParentLoopId(scope),
      message,
      cause,
      stepPatch: {
        exit_code: result.exitCode,
        output: result.output,
      },
    });
  }

  return persistShellResult(
    runtime,
    step.id,
    normalizeShellResult(result),
    scope,
  );
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
          command: interpolateTemplate(step.run as string, context),
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
      command: interpolateTemplate(command.run, context),
    })),
    multiCommand: true,
  };
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
  shellRunner: ShellRunner;
  stepId: string;
}): Promise<{
  commands: CommandExecution[];
  runtimeFailure?: RuntimeFailure;
}> {
  const commands: CommandExecution[] = [];
  let runtimeFailure: RuntimeFailure | undefined;

  for (const command of params.commands) {
    const name = command.name ?? "command";
    let result: ShellCommandResult;

    try {
      result = normalizeShellResult(
        await params.shellRunner({
          command: command.command,
          cwd: params.cwd,
          timeout: params.timeout,
        }),
      );
    } catch (cause) {
      const detail = getErrorMessage(cause);
      result = makeRuntimeFailureResult(cause);
      runtimeFailure ??= {
        cause,
        message:
          `step "${params.stepId}" command "${name}" shell execution ` +
          `failed: ${detail}`,
      };
    }

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
  return result.success ? "completed" : "failed";
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
