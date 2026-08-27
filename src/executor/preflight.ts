import { loadCommand } from "../commands/loader";
import type { AgentCommand } from "../commands/types";
import type { AiraConfig } from "../config/types";
import { flattenWorkflowSteps } from "../workflow/steps";
import type { AgentStep, Workflow } from "../workflow/types";
import {
  resolveAgentCommandPath,
  resolveAgentStepConfiguration,
  type ResolvedAgentStepConfiguration,
} from "./agent-step";
import { ExecutionError } from "./errors";

export interface PreflightAgentStep {
  step: AgentStep;
  command: AgentCommand;
  configuration: ResolvedAgentStepConfiguration;
}

export interface WorkflowPreflightResult {
  agentSteps: ReadonlyMap<string, PreflightAgentStep>;
}

export interface PreflightWorkflowParams {
  workflow: Workflow;
  config: AiraConfig;
  commandsDir: string;
}

/** Loads every referenced command and validates deterministic agent settings. */
export async function preflightWorkflow(
  params: PreflightWorkflowParams,
): Promise<WorkflowPreflightResult> {
  const commandCache = new Map<string, AgentCommand>();
  const agentSteps = new Map<string, PreflightAgentStep>();

  for (const step of flattenWorkflowSteps(params.workflow)) {
    if (step.uses !== "agent") {
      continue;
    }

    let command = commandCache.get(step.command);

    if (command === undefined) {
      const commandPath = resolveAgentCommandPath(
        params.commandsDir,
        step.command,
        step.id,
      );
      command = await loadCommand(commandPath);
      commandCache.set(step.command, command);
    }

    assertModelAliasExists(
      step.model,
      params.config,
      `agent step "${step.id}" workflow model`,
      step.id,
    );
    assertModelAliasExists(
      command.metadata.model,
      params.config,
      `agent step "${step.id}" command "${command.name}" model`,
      step.id,
    );

    const configuration = resolveAgentStepConfiguration(
      step,
      command,
      params.config,
    );
    agentSteps.set(step.id, { step, command, configuration });
  }

  return { agentSteps };
}

function assertModelAliasExists(
  alias: string | undefined,
  config: AiraConfig,
  source: string,
  stepId: string,
): void {
  if (alias === undefined) {
    return;
  }

  const models = config.models;
  const model =
    models !== undefined && Object.prototype.hasOwnProperty.call(models, alias)
      ? models[alias]
      : undefined;

  if (typeof model !== "string" || model.trim().length === 0) {
    throw new ExecutionError(`${source} alias "${alias}" is not defined in config.models`, {
      stepId,
    });
  }
}
