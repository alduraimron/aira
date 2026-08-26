import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  generateRunId,
  getRunPaths,
  RUN_ID_PATTERN,
  RunStateError,
} from "../../src/run";

const fixedDate = new Date("2026-08-26T10:55:01.987Z");

describe("run IDs", () => {
  test("generates a filesystem-safe ID in the documented format", () => {
    expect(generateRunId(fixedDate)).toMatch(RUN_ID_PATTERN);
  });

  test("uses a deterministic UTC timestamp prefix", () => {
    expect(generateRunId(fixedDate)).toStartWith("20260826-105501-");
  });

  test("uses a collision-resistant random suffix", () => {
    const first = generateRunId(fixedDate);
    const second = generateRunId(fixedDate);

    expect(first.slice(0, 16)).toBe(second.slice(0, 16));
    expect(first).not.toBe(second);
  });

  test("rejects an invalid date", () => {
    expect(() => generateRunId(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("run paths", () => {
  test("derives every run path below the runs root", () => {
    const runsRoot = "/tmp/aira-project/.aira/runs";
    const runId = "20260826-105501-a1b2c3d4";

    expect(getRunPaths(runsRoot, runId)).toEqual({
      root: path.join(runsRoot, runId),
      stateFile: path.join(runsRoot, runId, "run.json"),
      artifactsDir: path.join(runsRoot, runId, "artifacts"),
      sessionsDir: path.join(runsRoot, runId, "sessions"),
      logsDir: path.join(runsRoot, runId, "logs"),
    });
  });

  test.each([
    "../20260826-105501-a1b2c3d4",
    "20260826-105501-a1b2c3d4/child",
    "20260826-105501-a1b2c3d4\\child",
    "/20260826-105501-a1b2c3d4",
    "C:\\runs\\20260826-105501-a1b2c3d4",
    "run-id",
    "20260826_105501_a1b2c3d4",
    "20260826-105501-A1B2C3D4",
  ])("rejects unsafe or invalid run ID %p", (runId) => {
    expect(() => getRunPaths("/tmp/aira-runs", runId)).toThrow(
      RunStateError,
    );
  });
});
