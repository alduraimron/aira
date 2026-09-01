import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { sanitizeDisplayText } from "../../observability/display";
import { COMPLETE_STEP_TOOL_NAME } from "../completion";
import type { AgentRuntimeEvent } from "../types";

export interface PiAssistantSnapshot {
  text: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface AiraSessionEventRecord {
  timestamp: string;
  type: string;
  [key: string]: string | number | boolean | undefined;
}

const MAX_TOOL_NAME_LENGTH = 64;
const MAX_TARGET_LENGTH = 160;
const MAX_PATTERN_LENGTH = 80;
const MAX_COMMAND_LENGTH = 180;
const MAX_REASON_LENGTH = 160;

export function updateAssistantSnapshot(
  current: PiAssistantSnapshot | undefined,
  event: AgentSessionEvent,
): PiAssistantSnapshot | undefined {
  if (event.type === "message_end" || event.type === "turn_end") {
    return extractAssistantSnapshot(event.message) ?? current;
  }

  if (event.type === "agent_end") {
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const snapshot = extractAssistantSnapshot(event.messages[index]);
      if (snapshot !== undefined) {
        return snapshot;
      }
    }
  }

  return current;
}

/** Converts an observable Pi event into Aira's provider-neutral event model. */
export function toAgentRuntimeEvent(
  event: AgentSessionEvent,
  stepId: string,
): AgentRuntimeEvent | undefined {
  switch (event.type) {
    case "tool_execution_start": {
      if (event.toolName === COMPLETE_STEP_TOOL_NAME) {
        return undefined;
      }

      const tool = sanitizeToolName(event.toolName);
      const summary = summarizePiToolCall(tool, event.args);
      return {
        type: "agent.tool.started",
        stepId,
        tool,
        ...(summary === undefined ? {} : { summary }),
      };
    }
    case "tool_execution_end":
      if (event.toolName === COMPLETE_STEP_TOOL_NAME) {
        return undefined;
      }

      return {
        type: "agent.tool.completed",
        stepId,
        tool: sanitizeToolName(event.toolName),
        success: !event.isError,
      };
    case "auto_retry_start":
      return {
        type: "agent.retry",
        stepId,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        reason: sanitizeDisplayText(
          event.errorMessage,
          MAX_REASON_LENGTH,
        ),
      };
    default:
      return undefined;
  }
}

/**
 * Builds a short summary from allowlisted fields only. Unknown tools never
 * expose their argument object.
 */
export function summarizePiToolCall(
  toolName: string,
  args: unknown,
): string | undefined {
  const tool = sanitizeToolName(toolName);

  switch (tool) {
    case "read":
    case "edit":
    case "write": {
      const target = readSafeField(args, "path", MAX_TARGET_LENGTH);
      return target === undefined ? tool : `${tool} ${target}`;
    }
    case "ls": {
      const target = readSafeField(args, "path", MAX_TARGET_LENGTH);
      return `${tool} ${target ?? "."}`;
    }
    case "grep": {
      const pattern = readSafeField(args, "pattern", MAX_PATTERN_LENGTH);
      const target =
        readSafeField(args, "path", MAX_TARGET_LENGTH) ??
        readSafeField(args, "glob", MAX_TARGET_LENGTH);
      const parts = [
        tool,
        ...(pattern === undefined ? [] : [JSON.stringify(pattern)]),
        ...(target === undefined ? [] : [target]),
      ];
      return parts.join(" ");
    }
    case "find": {
      const pattern = readSafeField(args, "pattern", MAX_TARGET_LENGTH);
      const target = readSafeField(args, "path", MAX_TARGET_LENGTH);
      const parts = [
        tool,
        ...(pattern === undefined ? [] : [pattern]),
        ...(target === undefined || target === "." ? [] : [target]),
      ];
      return parts.join(" ");
    }
    case "bash": {
      const command = readSafeField(args, "command", MAX_COMMAND_LENGTH);
      return command === undefined ? tool : `${tool} ${command}`;
    }
    default:
      return undefined;
  }
}

export function toAiraSessionEventRecord(
  event: AgentSessionEvent,
  timestamp: string,
): AiraSessionEventRecord {
  const base = { timestamp, type: event.type };

  switch (event.type) {
    case "agent_end":
      return { ...base, willRetry: event.willRetry };
    case "message_start":
      return { ...base, role: readMessageRole(event.message) };
    case "message_update":
      return {
        ...base,
        role: readMessageRole(event.message),
        updateType: event.assistantMessageEvent.type,
      };
    case "message_end": {
      const assistant = extractAssistantSnapshot(event.message);
      if (assistant === undefined) {
        return { ...base, role: readMessageRole(event.message) };
      }

      return {
        ...base,
        role: "assistant",
        text: assistant.text,
        stopReason: assistant.stopReason,
        failed:
          assistant.stopReason === "error" ||
          assistant.stopReason === "aborted",
      };
    }
    case "turn_end": {
      const assistant = extractAssistantSnapshot(event.message);
      return {
        ...base,
        stopReason: assistant?.stopReason,
        toolResultCount: event.toolResults.length,
      };
    }
    case "tool_execution_start":
    case "tool_execution_update":
      return {
        ...base,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      };
    case "tool_execution_end":
      return {
        ...base,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };
    case "queue_update":
      return {
        ...base,
        steeringCount: event.steering.length,
        followUpCount: event.followUp.length,
      };
    case "compaction_start":
      return { ...base, reason: event.reason };
    case "compaction_end":
      return {
        ...base,
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
      };
    case "auto_retry_start":
      return {
        ...base,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
      };
    case "auto_retry_end":
      return {
        ...base,
        attempt: event.attempt,
        success: event.success,
      };
    case "summarization_retry_scheduled":
      return {
        ...base,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
      };
    case "summarization_retry_attempt_start":
      return {
        ...base,
        source: event.source,
        reason: "reason" in event ? event.reason : undefined,
      };
    case "entry_appended":
      return { ...base, entryType: event.entry.type };
    case "thinking_level_changed":
      return { ...base, level: event.level };
    default:
      return base;
  }
}

function readSafeField(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  let candidate: unknown;

  try {
    candidate = value[field];
  } catch {
    return undefined;
  }

  if (typeof candidate !== "string") {
    return undefined;
  }

  const sanitized = sanitizeDisplayText(candidate, maxLength);
  return sanitized.length === 0 ? undefined : sanitized;
}

function sanitizeToolName(value: unknown): string {
  if (typeof value !== "string") {
    return "tool";
  }

  const sanitized = sanitizeDisplayText(value, MAX_TOOL_NAME_LENGTH);
  return sanitized.length === 0 ? "tool" : sanitized;
}

function extractAssistantSnapshot(
  message: unknown,
): PiAssistantSnapshot | undefined {
  if (!isRecord(message) || message.role !== "assistant") {
    return undefined;
  }

  const text = Array.isArray(message.content)
    ? message.content
        .filter(
          (part): part is { type: "text"; text: string } =>
            isRecord(part) &&
            part.type === "text" &&
            typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("")
    : "";

  return {
    text,
    stopReason:
      typeof message.stopReason === "string" ? message.stopReason : undefined,
    errorMessage:
      typeof message.errorMessage === "string"
        ? message.errorMessage
        : undefined,
  };
}

function readMessageRole(message: unknown): string {
  return isRecord(message) && typeof message.role === "string"
    ? message.role
    : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
