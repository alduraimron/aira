import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCli } from "../../src/cli";
import {
  createRun,
  patchStepState,
  saveRun,
  type RunState,
  type RunStatus,
} from "../../src/run";
import {
  createCliProject,
  createTemporaryDirectory,
  removeTemporaryDirectory,
  TestCliIO,
} from "./helpers";

let directory: string;
let paths: Awaited<ReturnType<typeof createCliProject>>;

beforeEach(async () => {
  directory = await createTemporaryDirectory("aira-cli-status-");
  paths = await createCliProject(directory);
});

afterEach(async () => {
  await removeTemporaryDirectory(directory);
});

async function createStatusRun(
  now: Date,
  workflow = "feature",
): Promise<RunState> {
  return await createRun({
    runsRoot: paths.runsDir,
    workflow,
    input: { task: "status task" },
    stepIds: ["discover", "approve-plan", "implement"],
    now,
  });
}

describe("aira status", () => {
  test("shows an explicit run with step attempts", async () => {
    let state = await createStatusRun(new Date("2026-08-27T07:03:01.000Z"));
    state = patchStepState(state, "discover", {
      status: "completed",
      attempt: 2,
      success: true,
      completed_at: "2026-08-27T07:04:00.000Z",
    });
    state = patchStepState(state, "approve-plan", {
      status: "waiting",
      attempt: 0,
    });
    state = {
      ...state,
      status: "waiting",
      current_step: "approve-plan",
    };
    await saveRun(paths.runsDir, state, new Date("2026-08-27T07:05:00.000Z"));
    const io = new TestCliIO();

    expect(await runCli(["status", state.id], { cwd: directory, io })).toBe(0);
    expect(io.out).toContain(`Run:       ${state.id}`);
    expect(io.out).toContain("Workflow:  feature");
    expect(io.out).toContain("Status:    waiting");
    expect(io.out).toContain("Current:   approve-plan");
    expect(io.out).toContain("discover      completed   attempt 2");
    expect(io.out).toContain("approve-plan  waiting     attempt 0");
    expect(io.out).toContain("implement     pending     attempt 0");
  });

  test("selects the newest timestamp-sortable run when omitted", async () => {
    const older = await createStatusRun(
      new Date("2026-08-27T07:03:01.000Z"),
      "older",
    );
    const newer = await createStatusRun(
      new Date("2026-08-27T07:03:02.000Z"),
      "newer",
    );
    const io = new TestCliIO();

    expect(await runCli(["status"], { cwd: directory, io })).toBe(0);
    expect(io.out).toContain(`Run:       ${newer.id}`);
    expect(io.out).not.toContain(`Run:       ${older.id}`);
  });

  test.each([
    ["completed", undefined],
    ["waiting", "approve-plan"],
    ["interrupted", "implement"],
  ] as const)("displays %s status", async (status, currentStep) => {
    let state = await createStatusRun(new Date("2026-08-27T07:03:01.000Z"));
    state = {
      ...state,
      status: status as RunStatus,
      ...(currentStep === undefined ? {} : { current_step: currentStep }),
    };
    await saveRun(paths.runsDir, state);
    const io = new TestCliIO();

    expect(await runCli(["status", state.id], { cwd: directory, io })).toBe(0);
    expect(io.out).toContain(`Status:    ${status}`);
    expect(io.out).toContain(`Current:   ${currentStep ?? "-"}`);
  });

  test("reports no runs", async () => {
    const io = new TestCliIO();

    expect(await runCli(["status"], { cwd: directory, io })).toBe(0);
    expect(io.out).toBe("No Aira runs found.\n");
  });

  test("rejects an invalid run ID", async () => {
    const io = new TestCliIO();

    expect(await runCli(["status", "../run"], { cwd: directory, io })).toBe(1);
    expect(io.error).toContain("Invalid run ID");
  });
});
