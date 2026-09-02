import path from "node:path";

import {
  COMPLETE_STEP_TOOL_NAME,
  type AgentCompletionSpec,
} from "../agent/completion";
import { COMMAND_IDENTIFIER_PATTERN } from "../commands/schema";
import type { AgentCommand } from "../commands/types";
import type { AiraConfig } from "../config/types";
import type { TemplateContext } from "../context/types";
import { interpolateTemplate } from "../template/interpolate";
import type { AgentStep } from "../workflow/types";
import { ExecutionError } from "./errors";
import { resolveTechnicalRetryCount } from "./retry";

export const DEFAULT_AIRA_AGENT_TIMEOUT_SECONDS = 900;
export const DEFAULT_AIRA_AGENT_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
] as const;

export interface ResolvedAgentStepConfiguration {
  model?: string;
  thinking?: string;
  timeoutSeconds: number;
  technicalRetries: number;
  tools: string[];
}

export function resolveAgentCommandPath(
  commandsDir: string,
  commandName: string,
  stepId: string,
): string {
  if (typeof commandsDir !== "string" || commandsDir.trim().length === 0) {
    throw new ExecutionError(
      `agent step "${stepId}" requires a commands directory`,
      { stepId },
    );
  }

  if (!COMMAND_IDENTIFIER_PATTERN.test(commandName)) {
    throw new ExecutionError(
      `agent step "${stepId}" command "${commandName}" must match ` +
        COMMAND_IDENTIFIER_PATTERN.source,
      { stepId },
    );
  }

  return path.join(path.resolve(commandsDir), `${commandName}.md`);
}

export function resolveAgentStepConfiguration(
  step: AgentStep,
  command: AgentCommand,
  config: AiraConfig,
): ResolvedAgentStepConfiguration {
  assertProtocolToolIsNotConfigured(step.id, "workflow step", step.tools);
  assertProtocolToolIsNotConfigured(
    step.id,
    `command "${command.name}"`,
    command.metadata.tools,
  );

  const selectedModelAlias =
    step.model ?? command.metadata.model ?? config.defaults?.model;
  let model: string | undefined;

  if (selectedModelAlias !== undefined) {
    model = getOwnString(config.models, selectedModelAlias);

    if (model === undefined) {
      throw new ExecutionError(
        `agent step "${step.id}" selects unknown model alias ` +
          `"${selectedModelAlias}"`,
        { stepId: step.id },
      );
    }
  }

  const timeoutSeconds =
    step.timeout ??
    command.metadata.timeout ??
    config.defaults?.agent_timeout ??
    DEFAULT_AIRA_AGENT_TIMEOUT_SECONDS;

  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    throw new ExecutionError(
      `agent step "${step.id}" timeout must be a positive number of seconds`,
      { stepId: step.id },
    );
  }

  const ordinaryTools =
    step.tools ?? command.metadata.tools ?? [...DEFAULT_AIRA_AGENT_TOOLS];
  const thinking = step.thinking ?? command.metadata.thinking;
  const technicalRetries = resolveTechnicalRetryCount({
    step: step.retry,
    command: command.metadata.retry,
    config: config.defaults?.technical_retries,
  });
  assertValidToolNames(step.id, ordinaryTools);

  return {
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    timeoutSeconds,
    technicalRetries,
    tools: [...ordinaryTools, COMPLETE_STEP_TOOL_NAME],
  };
}

export function createAgentCompletionSpec(
  step: AgentStep,
): AgentCompletionSpec {
  return {
    expectedArtifacts:
      step.artifact === undefined ? [] : [step.artifact.name],
  };
}

export function composeAgentPrompt(
  commandPrompt: string,
  context: TemplateContext,
  completion: AgentCompletionSpec,
): string {
  const prompt = interpolateTemplate(commandPrompt, context);
  const artifactInstruction =
    completion.expectedArtifacts.length === 0
      ? "Return an empty array through complete_step.artifacts."
      : `Return artifact "${completion.expectedArtifacts[0]}" through ` +
        "complete_step.artifacts.";

  return (
    `${prompt}\n\n[Aira completion protocol]\n\n` +
    "When the requested work is complete, call `complete_step`.\n" +
    "If the call is rejected, correct the payload and call it again.\n" +
    "After a completion is accepted, do not call it again.\n" +
    "Do not claim completion only in your final text.\n" +
    artifactInstruction
  );
}

function assertProtocolToolIsNotConfigured(
  stepId: string,
  source: string,
  tools: readonly string[] | undefined,
): void {
  if (tools?.includes(COMPLETE_STEP_TOOL_NAME) !== true) {
    return;
  }

  throw new ExecutionError(
    `agent step "${stepId}" ${source} tools contain reserved Aira tool ` +
      `"${COMPLETE_STEP_TOOL_NAME}"`,
    { stepId },
  );
}

function assertValidToolNames(
  stepId: string,
  tools: readonly string[],
): void {
  for (const [index, tool] of tools.entries()) {
    if (typeof tool !== "string" || tool.trim().length === 0) {
      throw new ExecutionError(
        `agent step "${stepId}" tool at index ${index} must be a ` +
          "non-empty string",
        { stepId },
      );
    }
  }
}

function getOwnString(
  values: Record<string, string> | undefined,
  key: string,
): string | undefined {
  if (
    values === undefined ||
    !Object.prototype.hasOwnProperty.call(values, key)
  ) {
    return undefined;
  }

  const value = values[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
