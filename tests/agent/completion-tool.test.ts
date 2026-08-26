import { describe, expect, test } from "bun:test";

import {
  createCompleteStepTool,
  type CompleteStepToolCapture,
} from "../../src/agent";

async function invoke(
  capture: CompleteStepToolCapture,
  payload: unknown,
  callId = "call-1",
) {
  return capture.tool.execute(
    callId,
    payload as never,
    undefined,
    undefined,
    {} as never,
  );
}

describe("complete_step tool", () => {
  test("accepts a valid completion without artifacts", async () => {
    const capture = createCompleteStepTool({ expectedArtifacts: [] });
    const result = await invoke(capture, {
      status: "completed",
      summary: "  Work finished exactly as requested.  ",
      artifacts: [],
    });

    expect(result.content[0]).toEqual({
      type: "text",
      text: "Completion recorded. Do not call complete_step again.",
    });
    expect(capture.getState()).toEqual({
      callCount: 1,
      completion: {
        status: "completed",
        summary: "  Work finished exactly as requested.  ",
        artifacts: [],
      },
      completionError: undefined,
    });
  });

  test("accepts one expected artifact and preserves its content", async () => {
    const content = "# Plan\n\nKeep this trailing newline.\n";
    const capture = createCompleteStepTool({
      expectedArtifacts: ["plan"],
    });

    await invoke(capture, {
      status: "completed",
      summary: "Created the plan.",
      artifacts: [{ name: "plan", content }],
    });

    expect(capture.getState().completion).toEqual({
      status: "completed",
      summary: "Created the plan.",
      artifacts: [{ name: "plan", content }],
    });
  });

  test.each([
    [
      "whitespace summary",
      { status: "completed", summary: " \n\t ", artifacts: [] },
      "summary must contain non-whitespace text",
    ],
    [
      "wrong status",
      { status: "done", summary: "Done", artifacts: [] },
      'status must be exactly "completed"',
    ],
    [
      "whitespace artifact content",
      {
        status: "completed",
        summary: "Done",
        artifacts: [{ name: "plan", content: " \n " }],
      },
      "content must contain non-whitespace text",
    ],
    [
      "wrong artifact name",
      {
        status: "completed",
        summary: "Done",
        artifacts: [{ name: "other", content: "content" }],
      },
      'missing expected completion artifact "plan"',
    ],
    [
      "missing artifact",
      { status: "completed", summary: "Done", artifacts: [] },
      'missing expected completion artifact "plan"',
    ],
    [
      "unexpected artifact",
      {
        status: "completed",
        summary: "Done",
        artifacts: [{ name: "extra", content: "content" }],
      },
      'unexpected completion artifact "extra"',
    ],
    [
      "duplicate artifact",
      {
        status: "completed",
        summary: "Done",
        artifacts: [
          { name: "plan", content: "one" },
          { name: "plan", content: "two" },
        ],
      },
      'duplicate completion artifact "plan"',
    ],
  ] as const)("rejects %s", async (_name, payload, expectedError) => {
    const expectedArtifacts =
      _name === "unexpected artifact" ? [] : ["plan"];
    const capture = createCompleteStepTool({ expectedArtifacts });
    const result = await invoke(capture, payload);
    const state = capture.getState();

    expect(result.content[0]?.type).toBe("text");
    expect(
      result.content[0]?.type === "text" ? result.content[0].text : "",
    ).toContain("Completion rejected");
    expect(state.callCount).toBe(1);
    expect(state.completion).toBeUndefined();
    expect(state.completionError).toContain(expectedError);
  });

  test("a second invocation makes the protocol invalid", async () => {
    const capture = createCompleteStepTool({ expectedArtifacts: [] });
    const payload = {
      status: "completed",
      summary: "Done",
      artifacts: [],
    };

    await invoke(capture, payload, "call-1");
    const second = await invoke(capture, payload, "call-2");
    const state = capture.getState();

    expect(state.callCount).toBe(2);
    expect(state.completion?.summary).toBe("Done");
    expect(state.completionError).toContain("exactly once");
    expect(state.completionError).toContain("2 calls");
    expect(
      second.content[0]?.type === "text" ? second.content[0].text : "",
    ).toContain("Completion rejected");
  });

  test("capture state is isolated between tool instances", async () => {
    const first = createCompleteStepTool({ expectedArtifacts: [] });
    const second = createCompleteStepTool({ expectedArtifacts: [] });

    await invoke(first, {
      status: "completed",
      summary: "First",
      artifacts: [],
    });

    expect(first.getState().completion?.summary).toBe("First");
    expect(second.getState()).toEqual({
      callCount: 0,
      completion: undefined,
      completionError: undefined,
    });
  });
});
