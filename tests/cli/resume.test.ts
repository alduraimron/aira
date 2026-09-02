import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCli } from "../../src/cli";
import {
  createRun,
  loadRun,
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
  TestSigintSource,
  writeCommandFixture,
  writeWorkflowFixture,
} from "./helpers";

let directory: string;
let paths: Awaited<ReturnType<typeof createCliProject>>;

beforeEach(async () => {
  directory = await createTemporaryDirectory("aira-cli-resume-");
  paths = await createCliProject(directory);
});

afterEach(async () => {
  await removeTemporaryDirectory(directory);
});

async function createState(params: {
  workflow?: string;
  stepIds?: string[];
  status?: RunStatus;
  currentStep?: string;
} = {}): Promise<RunState> {
  const state = await createRun({
    runsRoot: paths.runsDir,
    workflow: params.workflow ?? "feature",
    input: { task: "resume task" },
    stepIds: params.stepIds ?? ["work"],
    now: new Date("2026-08-27T07:03:01.000Z"),
  });
  const updated: RunState = {
    ...state,
    status: params.status ?? "interrupted",
    ...(params.currentStep === undefined
      ? {}
      : { current_step: params.currentStep }),
  };
  await saveRun(paths.runsDir, updated);
  return updated;
}

describe("aira resume", () => {
  test("resumes an interrupted run with executor mode resume", async () => {
    await writeWorkflowFixture(
      paths,
      "feature.yaml",
      `
name: feature
steps:
  - id: work
    uses: shell
    run: work
`,
    );
    const state = await createState({ currentStep: "work" });
    const io = new TestCliIO();
    const signals = new TestSigintSource();
    let mode: string | undefined;
    let receivedSignal: AbortSignal | undefined;

    expect(
      await runCli(["resume", state.id], {
        cwd: directory,
        io,
        sigintSource: signals,
        executor: async (params) => {
          mode = params.mode;
          receivedSignal = params.signal;
          return { ...params.state, status: "completed" };
        },
      }),
    ).toBe(0);
    expect(mode).toBe("resume");
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(signals.addCalls).toBe(1);
    expect(signals.removeCalls).toBe(1);
    expect(signals.handlers.size).toBe(0);
  });

  test("reopens a waiting approval before invoking continue mode", async () => {
    await writeWorkflowFixture(
      paths,
      "feature.yaml",
      `
name: feature
steps:
  - id: approve
    uses: approval
    message: Resume approval?
`,
    );
    let state = await createState({
      status: "waiting",
      currentStep: "approve",
      stepIds: ["approve"],
    });
    state = patchStepState(state, "approve", { status: "waiting" });
    await saveRun(paths.runsDir, state);
    const io = new TestCliIO(["a"]);
    let calls = 0;
    let receivedState: RunState | undefined;
    let mode: string | undefined;

    expect(
      await runCli(["resume", state.id], {
        cwd: directory,
        io,
        executor: async (params) => {
          calls += 1;
          mode = params.mode;
          receivedState = params.state;
          return { ...params.state, status: "completed" };
        },
      }),
    ).toBe(0);
    expect(io.out).toContain("Resume approval?");
    expect(calls).toBe(1);
    expect(mode).toBe("continue");
    expect(receivedState?.steps.approve).toMatchObject({
      status: "completed",
      attempt: 0,
      result: "approved",
    });
  });

  test("resumes a running checkpoint persisted after revision feedback", async () => {
    await writeCommandFixture(paths, "plan", "Create the plan.");
    await writeWorkflowFixture(
      paths,
      "feature.yaml",
      `
name: feature
steps:
  - id: plan
    uses: agent
    command: plan
  - id: approve
    uses: approval
    revise: plan
`,
    );
    let state = await createState({
      status: "running",
      currentStep: "plan",
      stepIds: ["plan", "approve"],
    });
    state = {
      ...state,
      revisions: [
        {
          approval_step: "approve",
          target_step: "plan",
          feedback: "Add rollback coverage",
          requested_at: "2026-08-27T07:04:00.000Z",
          status: "pending",
        },
      ],
    };
    await saveRun(paths.runsDir, state);
    const io = new TestCliIO();
    let mode: string | undefined;
    let received: RunState | undefined;

    expect(
      await runCli(["resume", state.id], {
        cwd: directory,
        io,
        executor: async (params) => {
          mode = params.mode;
          received = params.state;
          return { ...params.state, status: "completed" };
        },
      }),
    ).toBe(0);
    expect(mode).toBe("resume");
    expect(received?.current_step).toBe("plan");
    expect(received?.revisions?.[0]).toMatchObject({
      status: "pending",
      feedback: "Add rollback coverage",
    });
  });

  test("reports waiting loop intervention as unsupported without mutation", async () => {
    await writeWorkflowFixture(
      paths,
      "verify.yaml",
      `
name: verify
steps:
  - id: verify-cycle
    uses: loop
    max_attempts: 3
    until: "steps.verify.success == true"
    steps:
      - id: verify
        uses: shell
        run: verify
`,
    );
    let state = await createState({
      workflow: "verify",
      status: "waiting",
      currentStep: "verify-cycle",
      stepIds: ["verify-cycle", "verify"],
    });
    state = patchStepState(state, "verify-cycle", {
      status: "waiting",
      attempt: 3,
      success: false,
    });
    state = patchStepState(state, "verify", {
      status: "failed",
      attempt: 3,
      success: false,
    });
    await saveRun(paths.runsDir, state);
    const original = await loadRun(paths.runsDir, state.id);
    const io = new TestCliIO();
    const signals = new TestSigintSource();
    let calls = 0;

    expect(
      await runCli(["resume", state.id], {
        cwd: directory,
        io,
        sigintSource: signals,
        executor: async (params) => {
          calls += 1;
          return params.state;
        },
      }),
    ).toBe(1);
    expect(calls).toBe(0);
    expect(signals.addCalls).toBe(0);
    expect(io.error).toContain(
      'loop "verify-cycle" exhausted its 3 attempts',
    );
    expect(io.error).toContain(
      "Manual loop intervention is not supported yet.",
    );
    expect(await loadRun(paths.runsDir, state.id)).toEqual(original);
  });

  test.each(["completed", "failed", "cancelled", "running"] as const)(
    "rejects a %s run without installing a signal handler",
    async (status) => {
      const state = await createState({ status });
      const io = new TestCliIO();
      const signals = new TestSigintSource();
      let calls = 0;

      expect(
        await runCli(["resume", state.id], {
          cwd: directory,
          io,
          sigintSource: signals,
          executor: async (params) => {
            calls += 1;
            return params.state;
          },
        }),
      ).toBe(1);
      expect(calls).toBe(0);
      expect(signals.addCalls).toBe(0);
      expect(io.error).toContain(`run "${state.id}" is "${status}"`);

      if (status === "running") {
        expect(io.error).toContain(
          "automatic crash recovery is not implemented",
        );
      }
    },
  );

  test("rejects a workflow identity mismatch", async () => {
    await writeWorkflowFixture(
      paths,
      "feature.yaml",
      `
name: changed
steps:
  - id: work
    uses: shell
    run: work
`,
    );
    const state = await createState({ currentStep: "work" });
    const io = new TestCliIO();

    expect(await runCli(["resume", state.id], { cwd: directory, io })).toBe(1);
    expect(io.error).toContain('declares name "changed", expected "feature"');
  });
});
