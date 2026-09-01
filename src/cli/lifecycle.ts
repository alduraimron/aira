import type { AgentRuntime } from "../agent";
import type { readArtifact } from "../artifacts";
import type { AiraConfig } from "../config";
import {
  executeWorkflow,
  type ExecuteWorkflowParams,
  type ExecutionMode,
} from "../executor";
import type { AiraProjectPaths } from "../project";
import type { RunState } from "../run";
import { findWorkflowStep, type Workflow } from "../workflow";
import {
  interactWithApproval,
  type ApprovalDecisionApplier,
} from "./approval";
import {
  CLI_EXIT_CANCELLED,
  CLI_EXIT_FAILURE,
  CLI_EXIT_INTERRUPTED,
  CLI_EXIT_SUCCESS,
  type CliExitCode,
} from "./exit-codes";
import type { CliIO } from "./io";
import {
  createCliExecutionReporter,
  type ExecutionReporter,
} from "./reporter";
import {
  processSigintSource,
  type SigintSource,
  withSigintAbort,
} from "./signals";

export type WorkflowExecutor = (
  params: ExecuteWorkflowParams,
) => Promise<RunState>;

export interface RunLifecycleParams {
  workflow: Workflow;
  config: AiraConfig;
  paths: AiraProjectPaths;
  state: RunState;
  cwd: string;
  io: CliIO;
  sigintSource?: SigintSource;
  initialMode: Extract<ExecutionMode, "fresh" | "resume">;
  executeFirst: boolean;
  agentRuntime?: AgentRuntime;
  executor?: WorkflowExecutor;
  approvalDecisionApplier?: ApprovalDecisionApplier;
  approvalArtifactReader?: typeof readArtifact;
  reporter?: ExecutionReporter;
}

export async function runLifecycle(
  params: RunLifecycleParams,
): Promise<CliExitCode> {
  let state = params.state;
  let shouldExecute = params.executeFirst;
  let mode: ExecutionMode = params.initialMode;
  const executor = params.executor ?? executeWorkflow;
  const reporter = params.reporter ?? createCliExecutionReporter(params.io);

  while (true) {
    if (shouldExecute) {
      state = await withSigintAbort({
        io: params.io,
        source: params.sigintSource ?? processSigintSource,
        execute: async (signal) =>
          await executor({
            workflow: params.workflow,
            runsRoot: params.paths.runsDir,
            state,
            context: { config: params.config },
            cwd: params.cwd,
            commandsDir: params.paths.commandsDir,
            shellTimeout: params.config.defaults?.shell_timeout,
            agentRuntime: params.agentRuntime,
            signal,
            mode,
            onEvent: (event) => reporter.emit(event),
          }),
      });
    }

    shouldExecute = false;

    switch (state.status) {
      case "completed":
        params.io.writeOut(`✓ Run completed: ${state.id}\n`);
        return CLI_EXIT_SUCCESS;
      case "failed":
        params.io.writeError(`✗ Run failed: ${state.id}\n`);
        return CLI_EXIT_FAILURE;
      case "cancelled":
        params.io.writeOut("Run cancelled.\n");
        return CLI_EXIT_CANCELLED;
      case "interrupted":
        params.io.writeError(`Run interrupted: ${state.id}\n`);
        return CLI_EXIT_INTERRUPTED;
      case "running":
        throw new Error(
          `executor returned run "${state.id}" with non-terminal status "running"`,
        );
      case "waiting": {
        const stepId = state.current_step;

        if (stepId === undefined) {
          throw new Error(`waiting run "${state.id}" has no current step`);
        }

        const step = findWorkflowStep(params.workflow, stepId);

        if (step === undefined) {
          throw new Error(
            `waiting run "${state.id}" references unknown step "${stepId}"`,
          );
        }

        if (step.uses === "loop") {
          params.io.writeError(
            `Run is waiting after loop "${step.id}" exhausted its ` +
              `${step.max_attempts} attempts.\n` +
              "Manual loop intervention is not supported yet.\n" +
              `Run ID: ${state.id}\n`,
          );
          return CLI_EXIT_FAILURE;
        }

        if (step.uses !== "approval") {
          throw new Error(
            `run "${state.id}" is waiting at unsupported step "${step.id}"`,
          );
        }

        reporter.emit({
          type: "step.started",
          stepId: step.id,
          stepType: "approval",
        });
        reporter.emit({
          type: "approval.waiting",
          stepId: step.id,
          ...(step.message === undefined ? {} : { message: step.message }),
        });

        const interaction = await interactWithApproval({
          workflow: params.workflow,
          runsRoot: params.paths.runsDir,
          state,
          io: params.io,
          sigintSource: params.sigintSource,
          applyDecision: params.approvalDecisionApplier,
          artifactReader: params.approvalArtifactReader,
          showWaitingHeader: false,
        });

        if (interaction.kind === "interrupted") {
          params.io.writeError(
            "approval interrupted; run remains waiting\n",
          );
          return CLI_EXIT_INTERRUPTED;
        }

        if (interaction.kind === "closed") {
          params.io.writeError(
            "approval input closed; run remains waiting\n",
          );
          return CLI_EXIT_FAILURE;
        }

        if (interaction.kind === "cancelled") {
          params.io.writeOut("Run cancelled.\n");
          return CLI_EXIT_CANCELLED;
        }

        state = interaction.state;
        mode = "continue";
        shouldExecute = true;
        break;
      }
    }
  }
}
