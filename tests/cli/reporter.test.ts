import { describe, expect, test } from "bun:test";

import {
  createCliExecutionReporter,
  formatDuration,
} from "../../src/cli";
import { TestCliIO } from "./helpers";

describe("CLI execution reporter", () => {
  test("renders concise agent progress without completion noise", () => {
    const io = new TestCliIO();
    const reporter = createCliExecutionReporter(io);

    reporter.emit({
      type: "step.started",
      stepId: "implement",
      stepType: "agent",
      model: "openai/example-model",
    });
    reporter.emit({
      type: "agent.started",
      stepId: "implement",
      model: "openai/example-model",
      sessionId: "session-1",
    });
    reporter.emit({
      type: "agent.tool.started",
      stepId: "implement",
      tool: "read",
      summary: "read src/auth/service.ts",
    });
    reporter.emit({
      type: "agent.tool.completed",
      stepId: "implement",
      tool: "read",
      success: true,
    });
    reporter.emit({
      type: "step.completed",
      stepId: "implement",
      success: true,
      durationMs: 4_200,
    });

    expect(io.out).toContain("● implement");
    expect(io.out).toContain("model openai/example-model");
    expect(io.out).toContain("→ read src/auth/service.ts");
    expect(io.out).toContain("✓ implement 4.2s");
    expect(io.out.match(/model openai\/example-model/g)).toHaveLength(1);
    expect(io.out).not.toContain("session-1");
  });

  test("renders shell failure and approval waiting states", () => {
    const io = new TestCliIO();
    const reporter = createCliExecutionReporter(io);

    reporter.emit({
      type: "step.started",
      stepId: "verify",
      stepType: "shell",
    });
    reporter.emit({
      type: "shell.started",
      stepId: "verify",
      command: "bun test",
    });
    reporter.emit({
      type: "shell.completed",
      stepId: "verify",
      success: false,
      exitCode: 7,
    });
    reporter.emit({
      type: "step.failed",
      stepId: "verify",
      durationMs: 842,
    });
    reporter.emit({
      type: "approval.waiting",
      stepId: "approve-plan",
      message: "Approve the plan?",
    });
    reporter.emit({
      type: "approval.waiting",
      stepId: "approve-plan",
    });

    expect(io.out).toContain("$ bun test");
    expect(io.out).toContain("command failed (exit 7)");
    expect(io.out).toContain("✗ verify 842ms");
    expect(io.out).toContain("◆ approve-plan");
    expect(io.out.match(/waiting for approval/g)).toHaveLength(1);
  });

  test("renders approval waiting again after a revision replay", () => {
    const io = new TestCliIO();
    const reporter = createCliExecutionReporter(io);

    reporter.emit({
      type: "approval.waiting",
      stepId: "approve-plan",
    });
    reporter.emit({
      type: "step.started",
      stepId: "plan",
      stepType: "agent",
    });
    reporter.emit({
      type: "step.completed",
      stepId: "plan",
      success: true,
    });
    reporter.emit({
      type: "approval.waiting",
      stepId: "approve-plan",
    });

    expect(io.out.match(/◆ approve-plan/g)).toHaveLength(2);
    expect(io.out.match(/waiting for approval/g)).toHaveLength(2);
  });

  test("caps multiline detail supplied by another runtime", () => {
    const io = new TestCliIO();
    const reporter = createCliExecutionReporter(io);

    reporter.emit({
      type: "agent.tool.started",
      stepId: "work",
      tool: "custom",
      summary: `custom\n${"x".repeat(10_000)}`,
    });

    expect(io.out).not.toContain("\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(io.out.length).toBeLessThan(230);
    expect(io.out).toContain("…");
  });

  test.each([
    [842, "842ms"],
    [4_200, "4.2s"],
    [14_000, "14s"],
    [72_000, "1m 12s"],
  ] as const)("formats %i milliseconds as %s", (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });
});
