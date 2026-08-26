import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  COMPLETE_STEP_TOOL_NAME,
  getAgentCompletionSpecError,
  validateAgentCompletion,
  type AgentCompletion,
  type AgentCompletionSpec,
} from "../completion";

const completeStepParameters = Type.Object(
  {
    status: Type.Literal("completed"),
    summary: Type.String(),
    artifacts: Type.Array(
      Type.Object(
        {
          name: Type.String(),
          content: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

interface CompleteStepToolDetails {
  accepted: boolean;
  error?: string;
}

export interface CompleteStepCaptureState {
  callCount: number;
  completion?: AgentCompletion;
  completionError?: string;
}

export interface CompleteStepToolCapture {
  tool: ToolDefinition<typeof completeStepParameters, CompleteStepToolDetails>;
  recordInvocationStart(toolCallId: string): void;
  recordInvocationError(toolCallId: string): void;
  getState(): CompleteStepCaptureState;
}

export function createCompleteStepTool(
  spec: AgentCompletionSpec,
): CompleteStepToolCapture {
  const specError = getAgentCompletionSpecError(spec);

  if (specError !== undefined) {
    throw new TypeError(`invalid complete_step specification: ${specError}`);
  }

  const completionSpec: AgentCompletionSpec = {
    expectedArtifacts: [...spec.expectedArtifacts],
  };
  let callCount = 0;
  let completion: AgentCompletion | undefined;
  let completionError: string | undefined;
  const startedCallIds = new Set<string>();
  const executedCallIds = new Set<string>();

  const recordRepeatedCall = () => {
    if (callCount > 1) {
      completionError =
        `complete_step must be called exactly once; received ${callCount} calls`;
    }
  };

  const tool = defineTool({
    name: COMPLETE_STEP_TOOL_NAME,
    label: "Complete Aira Step",
    description:
      "Record semantic completion of the current Aira workflow step. Call " +
      "this exactly once after all requested work is complete.",
    promptSnippet: "Record completion of the current Aira step exactly once",
    executionMode: "sequential",
    parameters: completeStepParameters,

    async execute(toolCallId, params) {
      const hasUnexecutedStart =
        startedCallIds.has(toolCallId) && !executedCallIds.has(toolCallId);

      if (!hasUnexecutedStart) {
        callCount += 1;
      }

      executedCallIds.add(toolCallId);
      recordRepeatedCall();

      if (completionError !== undefined) {
        return rejectedToolResult(completionError);
      }

      const validation = validateAgentCompletion(params, completionSpec);

      if (!validation.success) {
        completionError = `invalid complete_step call: ${validation.error}`;
        return rejectedToolResult(completionError);
      }

      completion = validation.completion;
      return {
        content: [
          {
            type: "text",
            text: "Completion recorded. Do not call complete_step again.",
          },
        ],
        details: { accepted: true },
      };
    },
  });

  return {
    tool,
    recordInvocationStart(toolCallId) {
      callCount += 1;
      startedCallIds.add(toolCallId);
      recordRepeatedCall();
    },
    recordInvocationError(toolCallId) {
      completionError ??=
        `Pi reported complete_step call "${toolCallId}" as an error`;
    },
    getState() {
      return {
        callCount,
        completion: cloneCompletion(completion),
        completionError,
      };
    },
  };
}

function rejectedToolResult(error: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Completion rejected: ${error}`,
      },
    ],
    details: { accepted: false, error },
  };
}

function cloneCompletion(
  completion: AgentCompletion | undefined,
): AgentCompletion | undefined {
  if (completion === undefined) {
    return undefined;
  }

  return {
    status: "completed",
    summary: completion.summary,
    artifacts: completion.artifacts.map((artifact) => ({ ...artifact })),
  };
}
