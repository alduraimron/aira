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

function validPayload(summary = "Done") {
  return {
    status: "completed" as const,
    summary,
    artifacts: [],
  };
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
    expect(result.details).toEqual({ accepted: true });
    expect(capture.getState()).toEqual({
      callCount: 1,
      rejectedAttempts: [],
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

    expect(result.details.accepted).toBe(false);
    expect(
      result.content[0]?.type === "text" ? result.content[0].text : "",
    ).toContain(
      "Correct the completion payload and call complete_step again.",
    );
    expect(state.callCount).toBe(1);
    expect(state.rejectedAttempts).toHaveLength(1);
    expect(state.rejectedAttempts[0]?.error).toContain(expectedError);
    expect(state.completion).toBeUndefined();
    expect(state.completionError).toContain(expectedError);
  });

  test("accepts a valid call after an invalid call", async () => {
    const capture = createCompleteStepTool({ expectedArtifacts: [] });

    const rejected = await invoke(
      capture,
      { status: "completed", summary: "  ", artifacts: [] },
      "invalid-call",
    );
    const accepted = await invoke(
      capture,
      validPayload("Corrected completion"),
      "valid-call",
    );
    const state = capture.getState();

    expect(rejected.details.accepted).toBe(false);
    expect(accepted.details.accepted).toBe(true);
    expect(state.callCount).toBe(2);
    expect(state.rejectedAttempts).toHaveLength(1);
    expect(state.completion?.summary).toBe("Corrected completion");
    expect(state.completionError).toBeUndefined();
  });

  test("accepts a valid call after multiple rejected calls", async () => {
    const capture = createCompleteStepTool({ expectedArtifacts: ["plan"] });

    await invoke(
      capture,
      { status: "completed", summary: " ", artifacts: [] },
      "invalid-call-1",
    );
    await invoke(
      capture,
      { status: "completed", summary: "Done", artifacts: [] },
      "invalid-call-2",
    );
    await invoke(
      capture,
      {
        status: "completed",
        summary: "Created the plan",
        artifacts: [{ name: "plan", content: "# Plan\n" }],
      },
      "valid-call",
    );
    const state = capture.getState();

    expect(state.callCount).toBe(3);
    expect(state.rejectedAttempts).toHaveLength(2);
    expect(state.completion).toEqual({
      status: "completed",
      summary: "Created the plan",
      artifacts: [{ name: "plan", content: "# Plan\n" }],
    });
    expect(state.completionError).toBeUndefined();
  });

  test("rejects a call after acceptance and preserves the first completion", async () => {
    const capture = createCompleteStepTool({ expectedArtifacts: [] });

    await invoke(capture, validPayload("Original completion"), "call-1");
    const second = await invoke(
      capture,
      validPayload("Replacement completion"),
      "call-2",
    );
    const state = capture.getState();

    expect(second.details).toEqual({
      accepted: false,
      error:
        "Completion has already been accepted for this step. " +
        "Do not call complete_step again.",
    });
    expect(second.content[0]).toEqual({
      type: "text",
      text:
        "Completion has already been accepted for this step. " +
        "Do not call complete_step again.",
    });
    expect(state.callCount).toBe(2);
    expect(state.rejectedAttempts).toHaveLength(1);
    expect(state.completion?.summary).toBe("Original completion");
    expect(state.completionError).toBeUndefined();
  });

  test("keeps rejection diagnostics when no completion is accepted", async () => {
    const capture = createCompleteStepTool({ expectedArtifacts: [] });

    capture.recordInvocationStart("pi-error");
    capture.recordInvocationError("pi-error");
    const state = capture.getState();

    expect(state.callCount).toBe(1);
    expect(state.rejectedAttempts).toEqual([
      {
        toolCallId: "pi-error",
        error: 'Pi reported complete_step call "pi-error" as an error',
      },
    ]);
    expect(state.completion).toBeUndefined();
    expect(state.completionError).toContain("Pi reported complete_step");
  });

  test("capture state is isolated between tool instances", async () => {
    const first = createCompleteStepTool({ expectedArtifacts: [] });
    const second = createCompleteStepTool({ expectedArtifacts: [] });

    await invoke(first, validPayload("First"));

    expect(first.getState().completion?.summary).toBe("First");
    expect(second.getState()).toEqual({
      callCount: 0,
      rejectedAttempts: [],
      completion: undefined,
      completionError: undefined,
    });
  });
});
