import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createRun,
  generateRunId,
  getRunPaths,
  loadRun,
  patchStepState,
  RunStateError,
  saveRun,
  setRunStatus,
} from "../../src/run";
import type { RunState } from "../../src/run";

let directory: string;
let runsRoot: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-run-"));
  runsRoot = path.join(directory, ".aira", "runs");
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function createTestRun(): Promise<RunState> {
  return createRun({
    runsRoot,
    workflow: "feature",
    input: {
      task: "Implement authentication",
      options: { strict: true },
    },
    stepIds: ["discover", "plan", "implement"],
    now: new Date("2026-08-26T10:55:01.000Z"),
  });
}

async function expectLoadError(runId: string): Promise<RunStateError> {
  try {
    await loadRun(runsRoot, runId);
  } catch (error) {
    expect(error).toBeInstanceOf(RunStateError);
    return error as RunStateError;
  }

  throw new Error("expected run loading to fail");
}

async function overwriteRunState(
  runId: string,
  document: unknown,
): Promise<void> {
  const { stateFile } = getRunPaths(runsRoot, runId);
  await writeFile(stateFile, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

describe("run persistence", () => {
  test("creates the complete run directory layout and initial state", async () => {
    const state = await createTestRun();
    const paths = getRunPaths(runsRoot, state.id);

    expect(state.id).toStartWith("20260826-105501-");
    expect(state).toMatchObject({
      version: 1,
      workflow: "feature",
      status: "running",
      input: {
        task: "Implement authentication",
        options: { strict: true },
      },
      started_at: "2026-08-26T10:55:01.000Z",
      updated_at: "2026-08-26T10:55:01.000Z",
      steps: {
        discover: { status: "pending", attempt: 0 },
        plan: { status: "pending", attempt: 0 },
        implement: { status: "pending", attempt: 0 },
      },
      artifacts: {},
    });

    for (const directoryPath of [
      paths.root,
      paths.artifactsDir,
      paths.sessionsDir,
      paths.logsDir,
    ]) {
      expect((await stat(directoryPath)).isDirectory()).toBe(true);
    }

    expect((await stat(paths.stateFile)).isFile()).toBe(true);
  });

  test("writes pretty JSON with a newline and loads it", async () => {
    const created = await createTestRun();
    const paths = getRunPaths(runsRoot, created.id);
    const source = await readFile(paths.stateFile, "utf8");

    expect(source).toStartWith("{\n  \"version\": 1,");
    expect(source.endsWith("\n")).toBe(true);
    expect(await loadRun(runsRoot, created.id)).toEqual(created);
  });

  test("saves state atomically and reloads the changes", async () => {
    const created = await createTestRun();
    const waiting = setRunStatus(created, "waiting");
    const updated = patchStepState(waiting, "discover", {
      status: "completed",
      attempt: 1,
      success: true,
      output: "Repository inspected",
    });

    await saveRun(
      runsRoot,
      updated,
      new Date("2026-08-26T11:00:00.000Z"),
    );

    expect(updated.updated_at).toBe("2026-08-26T11:00:00.000Z");
    expect(await loadRun(runsRoot, updated.id)).toEqual(updated);
  });

  test("does not leave a temporary state file after a successful save", async () => {
    const state = await createTestRun();
    await saveRun(
      runsRoot,
      state,
      new Date("2026-08-26T11:00:00.000Z"),
    );

    const files = await readdir(getRunPaths(runsRoot, state.id).root);
    expect(files.sort()).toEqual(["artifacts", "logs", "run.json", "sessions"]);
  });

  test("rejects corrupt JSON", async () => {
    const state = await createTestRun();
    const { stateFile } = getRunPaths(runsRoot, state.id);
    await writeFile(stateFile, "{not-json\n", "utf8");

    const error = await expectLoadError(state.id);
    expect(error.message).toContain("invalid JSON");
    expect(error.message).toContain(state.id);
    expect(error.message).toContain(stateFile);
  });

  test.each([
    ["wrong version", (state: RunState) => ({ ...state, version: 2 })],
    [
      "unknown top-level field",
      (state: RunState) => ({ ...state, unexpected: true }),
    ],
    [
      "invalid run status",
      (state: RunState) => ({ ...state, status: "paused" }),
    ],
    [
      "invalid step status",
      (state: RunState) => ({
        ...state,
        steps: {
          ...state.steps,
          discover: { status: "queued", attempt: 0 },
        },
      }),
    ],
    [
      "negative attempt",
      (state: RunState) => ({
        ...state,
        steps: {
          ...state.steps,
          discover: { status: "pending", attempt: -1 },
        },
      }),
    ],
    [
      "invalid artifact state",
      (state: RunState) => ({
        ...state,
        artifacts: {
          plan: {
            current: "artifacts/plan-v1.md",
            versions: [
              "artifacts/plan-v1.md",
              "artifacts/plan-v2.md",
            ],
          },
        },
      }),
    ],
  ] as const)("rejects persisted state with %s", async (_label, corrupt) => {
    const state = await createTestRun();
    await overwriteRunState(state.id, corrupt(state));

    const error = await expectLoadError(state.id);
    expect(error.message).toContain("failed validation");
  });

  test("rejects a run state ID that differs from the directory ID", async () => {
    const state = await createTestRun();
    const otherId = generateRunId(new Date("2026-08-26T10:55:02.000Z"));
    await overwriteRunState(state.id, { ...state, id: otherId });

    const error = await expectLoadError(state.id);
    expect(error.message).toContain("does not match its directory");
  });

  test("reports a missing run.json with its run ID and path", async () => {
    const runId = generateRunId(new Date("2026-08-26T10:55:01.000Z"));
    const paths = getRunPaths(runsRoot, runId);
    await mkdir(paths.root, { recursive: true });

    const error = await expectLoadError(runId);
    expect(error.message).toContain("Could not read run state");
    expect(error.message).toContain(runId);
    expect(error.message).toContain(paths.stateFile);
  });

  test("validates state before saving", async () => {
    const state = await createTestRun();
    const invalid = { ...state, status: "queued" } as unknown as RunState;

    await expect(saveRun(runsRoot, invalid)).rejects.toThrow(RunStateError);

    expect(await loadRun(runsRoot, state.id)).toEqual(state);
  });
});
