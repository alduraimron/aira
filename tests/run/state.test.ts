import { describe, expect, test } from "bun:test";

import {
  initializeStepStates,
  patchStepState,
  RunStateError,
  setRunStatus,
} from "../../src/run";
import type { RunState } from "../../src/run";

function makeState(): RunState {
  return {
    version: 1,
    id: "20260826-105501-a1b2c3d4",
    workflow: "feature",
    status: "running",
    input: {},
    started_at: "2026-08-26T10:55:01.000Z",
    updated_at: "2026-08-26T10:55:01.000Z",
    steps: initializeStepStates(["discover", "implement"]),
    artifacts: {},
  };
}

describe("run state helpers", () => {
  test("initializes steps as pending with attempt zero", () => {
    expect(initializeStepStates(["discover", "plan"])).toEqual({
      discover: { status: "pending", attempt: 0 },
      plan: { status: "pending", attempt: 0 },
    });
  });

  test("rejects duplicate initial step IDs", () => {
    expect(() => initializeStepStates(["plan", "plan"])).toThrow(
      RunStateError,
    );
  });

  test("sets run status without mutating the original state or its ID", () => {
    const original = makeState();
    const updated = setRunStatus(original, "waiting");

    expect(updated.status).toBe("waiting");
    expect(updated.id).toBe(original.id);
    expect(original.status).toBe("running");
  });

  test("patches a known step without mutating the original state", () => {
    const original = makeState();
    const updated = patchStepState(original, "discover", {
      status: "completed",
      attempt: 1,
      started_at: "2026-08-26T10:56:00.000Z",
      completed_at: "2026-08-26T10:57:00.000Z",
      success: true,
      exit_code: 0,
      summary: "Discovery complete",
      result: "approved",
      artifact: "discovery",
      output: "Done",
    });

    expect(updated.steps.discover).toEqual({
      status: "completed",
      attempt: 1,
      started_at: "2026-08-26T10:56:00.000Z",
      completed_at: "2026-08-26T10:57:00.000Z",
      success: true,
      exit_code: 0,
      summary: "Discovery complete",
      result: "approved",
      artifact: "discovery",
      output: "Done",
    });
    expect(updated.id).toBe(original.id);
    expect(original.steps.discover).toEqual({
      status: "pending",
      attempt: 0,
    });
  });

  test("rejects an unknown step", () => {
    expect(() =>
      patchStepState(makeState(), "missing", { status: "running" }),
    ).toThrow(RunStateError);
  });

  test("rejects a negative attempt", () => {
    expect(() =>
      patchStepState(makeState(), "discover", { attempt: -1 }),
    ).toThrow(RunStateError);
  });

  test("rejects an unknown patch field at runtime", () => {
    expect(() =>
      patchStepState(makeState(), "discover", {
        unexpected: true,
      } as never),
    ).toThrow(RunStateError);
  });
});
