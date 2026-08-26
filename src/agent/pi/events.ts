import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

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
