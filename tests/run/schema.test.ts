import { describe, expect, test } from "bun:test";

import {
  artifactStateSchema,
  RUN_STATUSES,
  runStateSchema,
  STEP_STATUSES,
} from "../../src/run";
import type { RunState } from "../../src/run";

const timestamp = "2026-08-26T10:55:01.000Z";

function makeState(): RunState {
  return {
    version: 1,
    id: "20260826-105501-a1b2c3d4",
    workflow: "feature",
    status: "running",
    input: { task: "Add authentication" },
    started_at: timestamp,
    updated_at: timestamp,
    steps: {
      implement: {
        status: "pending",
        attempt: 0,
      },
    },
    artifacts: {},
  };
}

describe("run state schema", () => {
  test.each([...RUN_STATUSES])("accepts run status %p", (status) => {
    expect(runStateSchema.safeParse({ ...makeState(), status }).success).toBe(
      true,
    );
  });

  test.each([...STEP_STATUSES])("accepts step status %p", (status) => {
    const state = makeState();
    state.steps.implement = { status, attempt: 1 };

    expect(runStateSchema.safeParse(state).success).toBe(true);
  });

  test("accepts all generic optional step fields", () => {
    const state = makeState();
    state.steps.implement = {
      status: "completed",
      attempt: 2,
      started_at: "2026-08-26T10:56:00Z",
      completed_at: "2026-08-26T10:57:00.12Z",
      success: true,
      exit_code: 0,
      summary: "Implementation complete",
      result: "approved",
      artifact: "implementation",
      output: "All checks passed",
    };

    expect(runStateSchema.parse(state)).toEqual(state);
  });

  test("accepts non-versioned and versioned artifact state", () => {
    const state = makeState();
    state.artifacts = {
      discovery: { current: "artifacts/discovery.md" },
      plan: {
        current: "artifacts/plan-v2.md",
        versions: ["artifacts/plan-v1.md", "artifacts/plan-v2.md"],
      },
    };

    expect(runStateSchema.parse(state)).toEqual(state);
  });

  test("rejects a wrong version", () => {
    expect(
      runStateSchema.safeParse({ ...makeState(), version: 2 }).success,
    ).toBe(false);
  });

  test("rejects an unknown top-level field", () => {
    expect(
      runStateSchema.safeParse({ ...makeState(), unexpected: true }).success,
    ).toBe(false);
  });

  test("rejects an unknown step field", () => {
    const state = makeState() as RunState & {
      steps: Record<string, Record<string, unknown>>;
    };
    state.steps.implement = {
      status: "pending",
      attempt: 0,
      unexpected: true,
    };

    expect(runStateSchema.safeParse(state).success).toBe(false);
  });

  test("rejects an invalid run status", () => {
    expect(
      runStateSchema.safeParse({ ...makeState(), status: "paused" }).success,
    ).toBe(false);
  });

  test("rejects an invalid step status", () => {
    const state = makeState();
    const document = {
      ...state,
      steps: { implement: { status: "queued", attempt: 0 } },
    };

    expect(runStateSchema.safeParse(document).success).toBe(false);
  });

  test.each([-1, 1.5])("rejects attempt value %p", (attempt) => {
    const state = makeState();
    const document = {
      ...state,
      steps: { implement: { status: "pending", attempt } },
    };

    expect(runStateSchema.safeParse(document).success).toBe(false);
  });

  test.each([
    "not a date",
    "2026-02-30T10:55:01.000Z",
    "2026-08-26T10:55:01+02:00",
  ])("rejects invalid or non-UTC timestamp %p", (started_at) => {
    expect(
      runStateSchema.safeParse({ ...makeState(), started_at }).success,
    ).toBe(false);
  });

  test("rejects an empty artifact versions array", () => {
    expect(
      artifactStateSchema.safeParse({
        current: "artifacts/plan-v1.md",
        versions: [],
      }).success,
    ).toBe(false);
  });

  test("rejects an artifact current path that is not the last version", () => {
    expect(
      artifactStateSchema.safeParse({
        current: "artifacts/plan-v1.md",
        versions: ["artifacts/plan-v1.md", "artifacts/plan-v2.md"],
      }).success,
    ).toBe(false);
  });

  test.each([
    "/tmp/plan.md",
    "../plan.md",
    "artifacts/../../plan.md",
    "artifacts\\..\\plan.md",
    "logs/plan.md",
  ])("rejects unsafe stored artifact path %p", (current) => {
    expect(artifactStateSchema.safeParse({ current }).success).toBe(false);
  });

  test("rejects duplicate version paths", () => {
    expect(
      artifactStateSchema.safeParse({
        current: "artifacts/plan-v1.md",
        versions: ["artifacts/plan-v1.md", "artifacts/plan-v1.md"],
      }).success,
    ).toBe(false);
  });
});
