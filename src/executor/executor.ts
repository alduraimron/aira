import { evaluateCondition } from "../conditions/evaluator";
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
import type { ShellStep, Workflow } from "../workflow/types";
import {
  createExecutionTemplateContext,
  type ExecutionContextInput,
} from "./context";
import { ExecutionError } from "./errors";

export type ShellRunner = (
  params: RunShellCommandParams,
) => Promise<ShellCommandResult>;

export interface ExecuteWorkflowParams {
  workflow: Workflow;
  runsRoot: string;
  state: RunState;
  context: ExecutionContextInput;
  cwd: string;
  /** Caller-resolved default timeout in seconds. */
  shellTimeout?: number;
  now?: () => Date;
  shellRunner?: ShellRunner;
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

const systemClock = () => new Date();

export async function executeWorkflow(
  params: ExecuteWorkflowParams,
): Promise<RunState> {
  const clock = params.now ?? systemClock;
  const shellRunner = params.shellRunner ?? runShellCommand;
  let state = params.state;

  if (state.status !== "running") {
    throw new ExecutionError(
      `run "${state.id}" must have status "running" before execution; ` +
        `found "${state.status}"`,
      { runId: state.id },
    );
  }

  if (state.workflow !== params.workflow.name) {
    throw new ExecutionError(
      `run "${state.id}" was created for workflow "${state.workflow}" but ` +
        `executor received "${params.workflow.name}"`,
      { runId: state.id },
    );
  }

  for (const step of params.workflow.steps) {
    const stepState = getStepState(state, step.id);

    state = {
      ...state,
      current_step: step.id,
    };

    if (stepState === undefined) {
      const message = `step "${step.id}" is missing from run state`;
      state = setRunStatus(state, "failed");
      const failedAt = readClock(clock, state.id, step.id);
      await persistState(params.runsRoot, state, failedAt, step.id);
      throw new ExecutionError(message, {
        runId: state.id,
        stepId: step.id,
      });
    }

    if (stepState.status !== "pending") {
      const message =
        `step "${step.id}" must have status "pending" before execution; ` +
        `found "${stepState.status}"`;
      state = await persistStepFailure({
        runsRoot: params.runsRoot,
        state,
        stepId: step.id,
        message,
        clock,
      });
      throw new ExecutionError(message, {
        runId: state.id,
        stepId: step.id,
      });
    }

    if (step.uses !== "shell") {
      const message =
        `step "${step.id}" uses unsupported Phase 5 step type ` +
        `"${step.uses}"`;
      state = await persistStepFailure({
        runsRoot: params.runsRoot,
        state,
        stepId: step.id,
        message,
        clock,
      });
      throw new ExecutionError(message, {
        runId: state.id,
        stepId: step.id,
      });
    }

    if (step.when !== undefined) {
      let shouldExecute: boolean;

      try {
        shouldExecute = evaluateCondition(
          step.when,
          createExecutionTemplateContext(state, params.context),
        );
      } catch (cause) {
        const message =
          `step "${step.id}" when condition failed: ` +
          getErrorMessage(cause);
        state = await persistStepFailure({
          runsRoot: params.runsRoot,
          state,
          stepId: step.id,
          message,
          clock,
        });
        throw new ExecutionError(message, {
          runId: state.id,
          stepId: step.id,
          cause,
        });
      }

      if (!shouldExecute) {
        state = patchStepState(state, step.id, { status: "skipped" });
        const skippedAt = readClock(clock, state.id, step.id);
        await persistState(params.runsRoot, state, skippedAt, step.id);
        continue;
      }
    }

    let prepared: PreparedShellStep;

    try {
      prepared = prepareShellStep(
        step,
        createExecutionTemplateContext(state, params.context),
      );
    } catch (cause) {
      const message =
        cause instanceof ExecutionError
          ? cause.message
          : `step "${step.id}" shell command interpolation failed: ` +
            getErrorMessage(cause);
      state = await persistStepFailure({
        runsRoot: params.runsRoot,
        state,
        stepId: step.id,
        message,
        clock,
      });
      throw new ExecutionError(message, {
        runId: state.id,
        stepId: step.id,
        cause,
      });
    }

    let timeout: number;

    try {
      timeout = resolveShellTimeout(step.timeout, params.shellTimeout);
    } catch (cause) {
      const message =
        `step "${step.id}" shell timeout is invalid: ` +
        getErrorMessage(cause);
      state = await persistStepFailure({
        runsRoot: params.runsRoot,
        state,
        stepId: step.id,
        message,
        clock,
      });
      throw new ExecutionError(message, {
        runId: state.id,
        stepId: step.id,
        cause,
      });
    }

    const startedAt = readClock(clock, state.id, step.id);
    state = patchStepState(state, step.id, {
      status: "running",
      attempt: stepState.attempt + 1,
      started_at: startedAt.toISOString(),
      completed_at: undefined,
      success: undefined,
      exit_code: undefined,
      output: undefined,
    });
    await persistState(params.runsRoot, state, startedAt, step.id);

    if (prepared.multiCommand) {
      const execution = await executeMultipleCommands({
        commands: prepared.commands,
        cwd: params.cwd,
        timeout,
        shellRunner,
        stepId: step.id,
      });
      const aggregate = aggregateCommandResults(execution.commands);
      state = await persistShellResult({
        runsRoot: params.runsRoot,
        state,
        stepId: step.id,
        result: aggregate,
        clock,
      });

      if (execution.runtimeFailure !== undefined) {
        throw new ExecutionError(execution.runtimeFailure.message, {
          runId: state.id,
          stepId: step.id,
          cause: execution.runtimeFailure.cause,
        });
      }

      if (!aggregate.success) {
        return state;
      }

      continue;
    }

    const command = prepared.commands[0];

    if (command === undefined) {
      const message = `step "${step.id}" has no shell command to execute`;
      state = await persistStepFailure({
        runsRoot: params.runsRoot,
        state,
        stepId: step.id,
        message,
        clock,
      });
      throw new ExecutionError(message, {
        runId: state.id,
        stepId: step.id,
      });
    }

    let result: ShellCommandResult;

    try {
      result = await shellRunner({
        command: command.command,
        cwd: params.cwd,
        timeout,
      });
    } catch (cause) {
      const detail = getErrorMessage(cause);
      const message = `step "${step.id}" shell execution failed: ${detail}`;
      result = makeRuntimeFailureResult(cause);
      state = await persistShellResult({
        runsRoot: params.runsRoot,
        state,
        stepId: step.id,
        result,
        clock,
      });
      throw new ExecutionError(message, {
        runId: state.id,
        stepId: step.id,
        cause,
      });
    }

    result = normalizeShellResult(result);
    state = await persistShellResult({
      runsRoot: params.runsRoot,
      state,
      stepId: step.id,
      result,
      clock,
    });

    if (!result.success) {
      return state;
    }
  }

  state = setRunStatus(state, "completed");
  delete state.current_step;
  const completedAt = readClock(clock, state.id);
  await persistState(params.runsRoot, state, completedAt);
  return state;
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

async function persistShellResult(params: {
  runsRoot: string;
  state: RunState;
  stepId: string;
  result: ShellCommandResult;
  clock: () => Date;
}): Promise<RunState> {
  const completedAt = readClock(params.clock, params.state.id, params.stepId);
  let state = patchStepState(params.state, params.stepId, {
    status: params.result.success ? "completed" : "failed",
    completed_at: completedAt.toISOString(),
    success: params.result.success,
    exit_code: params.result.exitCode,
    output: params.result.output,
  });

  if (!params.result.success) {
    state = setRunStatus(state, "failed");
  }

  await persistState(params.runsRoot, state, completedAt, params.stepId);
  return state;
}

async function persistStepFailure(params: {
  runsRoot: string;
  state: RunState;
  stepId: string;
  message: string;
  clock: () => Date;
}): Promise<RunState> {
  const completedAt = readClock(params.clock, params.state.id, params.stepId);
  let state = patchStepState(params.state, params.stepId, {
    status: "failed",
    completed_at: completedAt.toISOString(),
    success: false,
    exit_code: undefined,
    output: `ERROR:\n${params.message}`,
  });
  state = setRunStatus(state, "failed");
  await persistState(params.runsRoot, state, completedAt, params.stepId);
  return state;
}

async function persistState(
  runsRoot: string,
  state: RunState,
  now: Date,
  stepId?: string,
): Promise<void> {
  try {
    await saveRun(runsRoot, state, now);
  } catch (cause) {
    throw new ExecutionError(
      `could not persist run "${state.id}": ${getErrorMessage(cause)}`,
      { runId: state.id, stepId, cause },
    );
  }
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
