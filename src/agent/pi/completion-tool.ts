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

export interface CompleteStepRejectedAttempt {
  toolCallId: string;
  error: string;
}

export interface CompleteStepCaptureState {
  callCount: number;
  rejectedAttempts: CompleteStepRejectedAttempt[];
  completion?: AgentCompletion;
  completionError?: string;
}

export interface CompleteStepToolCapture {
  tool: ToolDefinition<typeof completeStepParameters, CompleteStepToolDetails>;
  recordInvocationStart(toolCallId: string): void;
  recordInvocationError(toolCallId: string): void;
  getState(): CompleteStepCaptureState;
}

type CompleteStepAcceptanceState =
  | { status: "pending" }
  | {
      status: "accepted";
      toolCallId: string;
      completion: AgentCompletion;
    };

const COMPLETION_ALREADY_ACCEPTED =
  "Completion has already been accepted for this step. " +
  "Do not call complete_step again.";

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
  let acceptanceState: CompleteStepAcceptanceState = { status: "pending" };
  const observedCallIds = new Set<string>();
  const rejectedCallIds = new Set<string>();
  const rejectedAttempts: CompleteStepRejectedAttempt[] = [];

  const recordAttempt = (toolCallId: string) => {
    if (observedCallIds.has(toolCallId)) {
      return;
    }

    observedCallIds.add(toolCallId);
    callCount += 1;
  };

  const recordRejection = (toolCallId: string, error: string) => {
    recordAttempt(toolCallId);

    if (
      (acceptanceState.status === "accepted" &&
        toolCallId === acceptanceState.toolCallId) ||
      rejectedCallIds.has(toolCallId)
    ) {
      return;
    }

    rejectedCallIds.add(toolCallId);
    rejectedAttempts.push({ toolCallId, error });
  };

  const tool = defineTool({
    name: COMPLETE_STEP_TOOL_NAME,
    label: "Complete Aira Step",
    description:
      "Record semantic completion of the current Aira workflow step. If a " +
      "call is rejected, correct the payload and try again. Stop after a " +
      "completion is accepted.",
    promptSnippet:
      "Record completion of the current Aira step; retry rejected payloads",
    executionMode: "sequential",
    parameters: completeStepParameters,

    async execute(toolCallId, params) {
      recordAttempt(toolCallId);

      if (acceptanceState.status === "accepted") {
        recordRejection(toolCallId, COMPLETION_ALREADY_ACCEPTED);
        return rejectedToolResult(COMPLETION_ALREADY_ACCEPTED, false);
      }

      const validation = validateAgentCompletion(params, completionSpec);

      if (!validation.success) {
        const error = `invalid complete_step call: ${validation.error}`;
        recordRejection(toolCallId, error);
        return rejectedToolResult(error, true);
      }

      acceptanceState = {
        status: "accepted",
        toolCallId,
        completion: validation.completion,
      };
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
      recordAttempt(toolCallId);
    },
    recordInvocationError(toolCallId) {
      recordAttempt(toolCallId);

      if (
        acceptanceState.status === "accepted" &&
        toolCallId === acceptanceState.toolCallId
      ) {
        return;
      }

      recordRejection(
        toolCallId,
        acceptanceState.status === "pending"
          ? `Pi reported complete_step call "${toolCallId}" as an error`
          : COMPLETION_ALREADY_ACCEPTED,
      );
    },
    getState() {
      const rejectionDiagnostics = rejectedAttempts.map((attempt) => ({
        ...attempt,
      }));

      return {
        callCount,
        rejectedAttempts: rejectionDiagnostics,
        completion:
          acceptanceState.status === "accepted"
            ? cloneCompletion(acceptanceState.completion)
            : undefined,
        completionError:
          acceptanceState.status === "pending"
            ? rejectionDiagnostics.at(-1)?.error
            : undefined,
      };
    },
  };
}

function rejectedToolResult(error: string, retryable: boolean) {
  return {
    content: [
      {
        type: "text" as const,
        text: retryable
          ? `Completion rejected: ${error}\n` +
            "Correct the completion payload and call complete_step again."
          : error,
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
