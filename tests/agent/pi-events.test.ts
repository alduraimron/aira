import { describe, expect, test } from "bun:test";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import {
  summarizePiToolCall,
  toAgentRuntimeEvent,
  toAiraSessionEventRecord,
} from "../../src/agent/pi/events";

describe("Pi live event translation", () => {
  test("translates tool start and completion events", () => {
    const started = toAgentRuntimeEvent(
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "grep",
        args: { pattern: "refreshToken", path: "src/auth" },
      } as AgentSessionEvent,
      "discover",
    );
    const completed = toAgentRuntimeEvent(
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "grep",
        result: { arbitrary: "provider result is not exposed" },
        isError: false,
      } as AgentSessionEvent,
      "discover",
    );

    expect(started).toEqual({
      type: "agent.tool.started",
      stepId: "discover",
      tool: "grep",
      summary: 'grep "refreshToken" src/auth',
    });
    expect(completed).toEqual({
      type: "agent.tool.completed",
      stepId: "discover",
      tool: "grep",
      success: true,
    });
  });

  test("translates a Pi internal retry to agent.retry", () => {
    const retry = toAgentRuntimeEvent(
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 500,
        errorMessage: "provider temporarily unavailable",
      } as AgentSessionEvent,
      "discover",
    );

    expect(retry).toEqual({
      type: "agent.retry",
      stepId: "discover",
      attempt: 1,
      maxAttempts: 2,
      reason: "provider temporarily unavailable",
    });
  });

  test("does not expose Aira's completion protocol tool", () => {
    expect(
      toAgentRuntimeEvent(
        {
          type: "tool_execution_start",
          toolCallId: "complete-1",
          toolName: "complete_step",
          args: { summary: "large completion payload" },
        } as AgentSessionEvent,
        "plan",
      ),
    ).toBeUndefined();
    expect(
      toAgentRuntimeEvent(
        {
          type: "tool_execution_end",
          toolCallId: "complete-1",
          toolName: "complete_step",
          result: { details: { accepted: false } },
          isError: false,
        } as AgentSessionEvent,
        "plan",
      ),
    ).toBeUndefined();
  });

  test("records Pi tool status without labeling it completion acceptance", () => {
    const record = toAiraSessionEventRecord(
      {
        type: "tool_execution_end",
        toolCallId: "complete-1",
        toolName: "complete_step",
        result: { details: { accepted: false } },
        isError: false,
      } as AgentSessionEvent,
      "2026-01-01T00:00:00.000Z",
    );

    expect(record).toEqual({
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "tool_execution_end",
      toolCallId: "complete-1",
      toolName: "complete_step",
      isError: false,
    });
    expect(record).not.toHaveProperty("accepted");
  });
});

describe("Pi tool summaries", () => {
  test.each([
    ["read", { path: "src/auth/service.ts", offset: 100 }, "read src/auth/service.ts"],
    ["grep", { pattern: "refreshToken", path: "src/" }, 'grep "refreshToken" src/'],
    ["find", { pattern: "src/**/*.ts" }, "find src/**/*.ts"],
    ["edit", { path: "src/auth/service.ts", edits: [] }, "edit src/auth/service.ts"],
    ["write", { path: "src/auth/token.ts", content: "ignored" }, "write src/auth/token.ts"],
    ["ls", {}, "ls ."],
    ["bash", { command: "bun run typecheck" }, "bash bun run typecheck"],
  ] as const)("summarizes %s from allowlisted fields", (tool, args, expected) => {
    expect(summarizePiToolCall(tool, args)).toBe(expected);
  });

  test("ignores unknown tool arguments", () => {
    const secret = "unknown-tool-secret-value";
    const summary = summarizePiToolCall("custom-tool", {
      token: secret,
      payload: "x".repeat(20_000),
    });

    const event = toAgentRuntimeEvent(
      {
        type: "tool_execution_start",
        toolCallId: "custom-1",
        toolName: "custom-tool",
        args: { token: secret, payload: "x".repeat(20_000) },
      } as AgentSessionEvent,
      "work",
    );

    expect(summary).toBeUndefined();
    expect(event).toEqual({
      type: "agent.tool.started",
      stepId: "work",
      tool: "custom-tool",
    });
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  test("redacts secrets and caps large command payloads", () => {
    const secret = "sk-abcdefghijklmnop";
    const summary = summarizePiToolCall("bash", {
      command:
        `API_TOKEN=${secret} bun test --api-key ${secret} ` +
        `--filter ${"x".repeat(20_000)}`,
      env: { API_TOKEN: secret },
      arbitrary: { nested: secret },
    });

    expect(summary).toStartWith("bash API_TOKEN=[redacted] bun test");
    expect(summary).not.toContain(secret);
    expect(summary?.length).toBeLessThanOrEqual(185);
    expect(summary).toEndWith("…");
  });

  test("redacts compound sensitive flags in Pi bash summaries", () => {
    const secret = "pi-client-secret-value";
    const summary = summarizePiToolCall("bash", {
      command: `./deploy --client-secret ${secret}`,
    });

    expect(summary).toBe("bash ./deploy --client-secret [redacted]");
    expect(summary).not.toContain(secret);
  });

  test("never includes write content or unrelated object fields", () => {
    const secret = "file-content-secret";
    const summary = summarizePiToolCall("write", {
      path: "src/generated.ts",
      content: secret.repeat(5_000),
      environment: { PASSWORD: secret },
    });

    expect(summary).toBe("write src/generated.ts");
    expect(summary).not.toContain(secret);
  });
});
