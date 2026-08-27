import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AgentRuntime } from "../../src/agent";
import { applyApprovalDecision } from "../../src/approval";
import { runCli, type WorkflowExecutor } from "../../src/cli";
import { writeArtifact } from "../../src/artifacts";
import { executeWorkflow } from "../../src/executor";
import type { GitCommandRunner } from "../../src/git";
import {
  listRunIds,
  loadRun,
  patchStepState,
  saveRun,
  type RunState,
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

const nonGitRunner: GitCommandRunner = async () => ({
  exitCode: 128,
  stdout: "",
  stderr: "fatal: not a git repository",
});
const fakeAgentRuntime: AgentRuntime = {
  async runStep() {
    throw new Error("agent execution must be handled by the fake executor");
  },
};

beforeEach(async () => {
  directory = await createTemporaryDirectory("aira-cli-approval-");
  paths = await createCliProject(directory);
  await writeCommandFixture(paths, "plan", "Create a plan for {{ input.task }}.");
  await writeWorkflowFixture(
    paths,
    "feature.yaml",
    `
name: feature
steps:
  - id: plan
    uses: agent
    command: plan
    artifact:
      name: plan
      filename: plan.md
      versioned: true
  - id: approve-plan
    uses: approval
    artifact: plan
    message: Approve this implementation plan?
    revise: plan
  - id: implement
    uses: shell
    run: implement
`,
  );
});

afterEach(async () => {
  await removeTemporaryDirectory(directory);
});

async function persistWaitingApproval(state: RunState): Promise<RunState> {
  let waiting = (
    await writeArtifact({
      runsRoot: paths.runsDir,
      state,
      name: "plan",
      filename: "plan.md",
      versioned: true,
      content: "# Implementation plan\n\nUse signed JWTs.\n",
    })
  ).state;
  waiting = patchStepState(waiting, "plan", {
    status: "completed",
    attempt: 1,
    success: true,
    completed_at: new Date().toISOString(),
    artifact: "artifacts/plan-v1.md",
  });
  waiting = patchStepState(waiting, "approve-plan", {
    status: "waiting",
  });
  waiting = {
    ...waiting,
    status: "waiting",
    current_step: "approve-plan",
  };
  await saveRun(paths.runsDir, waiting);
  return waiting;
}

function baseOptions(io: TestCliIO) {
  return {
    cwd: directory,
    io,
    gitCommandRunner: nonGitRunner,
    agentRuntimeFactory: () => fakeAgentRuntime,
  };
}

describe("top-level approval interaction", () => {
  test("displays the message and current artifact, approves, and continues", async () => {
    const io = new TestCliIO(["approve"]);
    const modes: string[] = [];
    let calls = 0;
    let continuedState: RunState | undefined;
    const executor: WorkflowExecutor = async (params) => {
      calls += 1;
      modes.push(params.mode ?? "fresh");

      if (calls === 1) {
        return await persistWaitingApproval(params.state);
      }

      continuedState = params.state;
      return { ...params.state, status: "completed" };
    };

    expect(
      await runCli(["run", "feature", "JWT auth"], {
        ...baseOptions(io),
        executor,
      }),
    ).toBe(0);
    expect(modes).toEqual(["fresh", "continue"]);
    expect(io.out).toContain("[approve-plan] waiting for approval");
    expect(io.out).toContain("Artifact: plan");
    expect(io.out).toContain("# Implementation plan");
    expect(io.out).toContain("Use signed JWTs.");
    expect(io.out).toContain("Approve this implementation plan?");
    expect(continuedState?.status).toBe("running");
    expect(continuedState?.steps["approve-plan"]).toMatchObject({
      status: "completed",
      attempt: 0,
      result: "approved",
    });

    const runId = (await listRunIds(paths.runsDir))[0];
    const persisted = await loadRun(paths.runsDir, runId ?? "");
    expect(persisted.steps["approve-plan"]?.attempt).toBe(0);
  });

  test("applies bare revise through the existing API and continues", async () => {
    const io = new TestCliIO(["R"]);
    const states: RunState[] = [];
    const modes: string[] = [];
    let calls = 0;
    const executor: WorkflowExecutor = async (params) => {
      calls += 1;
      modes.push(params.mode ?? "fresh");

      if (calls === 1) {
        return await persistWaitingApproval(params.state);
      }

      states.push(params.state);
      return { ...params.state, status: "completed" };
    };

    expect(
      await runCli(["run", "feature", "JWT auth"], {
        ...baseOptions(io),
        executor,
      }),
    ).toBe(0);
    expect(modes).toEqual(["fresh", "continue"]);
    expect(states[0]?.current_step).toBe("plan");
    expect(states[0]?.steps.plan).toEqual({ status: "pending", attempt: 1 });
    expect(states[0]?.steps["approve-plan"]).toEqual({
      status: "pending",
      attempt: 0,
    });
    expect(io.prompts).toHaveLength(1);
    expect(io.out).not.toContain("Revision feedback:");
  });

  test("cancel persists cancellation and never calls the executor again", async () => {
    const io = new TestCliIO(["cancel"]);
    let calls = 0;
    const executor: WorkflowExecutor = async (params) => {
      calls += 1;
      return await persistWaitingApproval(params.state);
    };

    expect(
      await runCli(["run", "feature", "JWT auth"], {
        ...baseOptions(io),
        executor,
      }),
    ).toBe(2);
    expect(calls).toBe(1);
    expect(io.out).toContain("Run cancelled.");
    const runId = (await listRunIds(paths.runsDir))[0];
    const persisted = await loadRun(paths.runsDir, runId ?? "");
    expect(persisted.status).toBe("cancelled");
    expect(persisted.steps["approve-plan"]?.result).toBe("cancelled");
  });

  test("reprompts after invalid input", async () => {
    const io = new TestCliIO(["maybe", "a"]);
    let calls = 0;
    const executor: WorkflowExecutor = async (params) => {
      calls += 1;
      return calls === 1
        ? await persistWaitingApproval(params.state)
        : { ...params.state, status: "completed" };
    };

    expect(
      await runCli(["run", "feature", "JWT auth"], {
        ...baseOptions(io),
        executor,
      }),
    ).toBe(0);
    expect(io.prompts).toHaveLength(2);
    expect(io.out).toContain("Please enter approve, revise, or cancel.");
  });

  test("EOF leaves the run waiting and never applies a decision", async () => {
    const io = new TestCliIO([null]);
    let decisions = 0;
    const executor: WorkflowExecutor = async (params) =>
      await persistWaitingApproval(params.state);

    expect(
      await runCli(["run", "feature", "JWT auth"], {
        ...baseOptions(io),
        executor,
        approvalDecisionApplier: async (params) => {
          decisions += 1;
          return params.state;
        },
      }),
    ).toBe(1);
    expect(decisions).toBe(0);
    expect(io.error).toContain(
      "approval input closed; run remains waiting",
    );
    const runId = (await listRunIds(paths.runsDir))[0];
    expect((await loadRun(paths.runsDir, runId ?? "")).status).toBe(
      "waiting",
    );
  });

  test("SIGINT at approval preserves waiting state and later resume uses a fresh signal", async () => {
    await writeWorkflowFixture(
      paths,
      "interrupt-approval.yaml",
      `
name: interrupt-approval
steps:
  - id: approve
    uses: approval
    message: Continue after review?
  - id: finish
    uses: shell
    run: "printf resumed"
`,
    );
    const sigint = new TestSigintSource();
    const io = new TestCliIO();
    let approvalSignal: AbortSignal | undefined;
    io.readLine = async (prompt, signal) => {
      io.prompts.push(prompt);
      io.out += prompt;
      approvalSignal = signal;
      sigint.emit();
      return null;
    };
    let decisions = 0;
    let executorCalls = 0;
    let initialExecutorSignal: AbortSignal | undefined;
    let waitingState: RunState | undefined;

    const interruptedExit = await runCli(
      ["run", "interrupt-approval", "review task"],
      {
        cwd: directory,
        io,
        gitCommandRunner: nonGitRunner,
        sigintSource: sigint,
        executor: async (params) => {
          executorCalls += 1;
          initialExecutorSignal = params.signal;
          expect(params.signal?.aborted).toBe(false);
          waitingState = await executeWorkflow(params);
          return waitingState;
        },
        approvalDecisionApplier: async (params) => {
          decisions += 1;
          return await applyApprovalDecision(params);
        },
      },
    );

    expect(interruptedExit).toBe(130);
    expect(decisions).toBe(0);
    expect(executorCalls).toBe(1);
    expect(approvalSignal?.aborted).toBe(true);
    expect(initialExecutorSignal?.aborted).toBe(false);
    expect(io.error).toContain(
      "approval interrupted; run remains waiting",
    );
    expect(sigint.handlers.size).toBe(0);

    const runId = (await listRunIds(paths.runsDir))[0] ?? "";
    const persistedWaiting = await loadRun(paths.runsDir, runId);

    if (waitingState === undefined) {
      throw new Error("executor did not return waiting state");
    }

    expect(persistedWaiting).toEqual(waitingState);
    expect(persistedWaiting.status).toBe("waiting");
    expect(persistedWaiting.current_step).toBe("approve");
    expect(persistedWaiting.steps.approve).toEqual({
      status: "waiting",
      attempt: 0,
    });
    expect(persistedWaiting.steps.finish).toEqual({
      status: "pending",
      attempt: 0,
    });

    const resumeIO = new TestCliIO(["approve"]);
    const resumeSigint = new TestSigintSource();
    let continuationCalls = 0;
    let continuationSignal: AbortSignal | undefined;
    const resumedExit = await runCli(["resume", runId], {
      cwd: directory,
      io: resumeIO,
      sigintSource: resumeSigint,
      executor: async (params) => {
        continuationCalls += 1;
        continuationSignal = params.signal;
        expect(params.signal?.aborted).toBe(false);
        return await executeWorkflow(params);
      },
    });

    expect(resumedExit).toBe(0);
    expect(continuationCalls).toBe(1);
    expect(continuationSignal?.aborted).toBe(false);
    expect(continuationSignal).not.toBe(initialExecutorSignal);
    expect(resumeSigint.handlers.size).toBe(0);
    const completed = await loadRun(paths.runsDir, runId);
    expect(completed.status).toBe("completed");
    expect(completed.steps.approve).toMatchObject({
      status: "completed",
      attempt: 0,
      result: "approved",
    });
    expect(completed.steps.finish).toMatchObject({
      status: "completed",
      attempt: 1,
    });
  });

  test("uses a fresh non-aborted signal after each approval", async () => {
    await writeWorkflowFixture(
      paths,
      "two-approvals.yaml",
      `
name: two-approvals
steps:
  - id: approval-a
    uses: approval
    message: Approve A?
  - id: approval-b
    uses: approval
    message: Approve B?
  - id: finish
    uses: shell
    run: "printf complete"
`,
    );
    const io = new TestCliIO(["approve", "approve"]);
    const sigint = new TestSigintSource();
    const executionSignals: AbortSignal[] = [];

    expect(
      await runCli(["run", "two-approvals", "task"], {
        cwd: directory,
        io,
        gitCommandRunner: nonGitRunner,
        sigintSource: sigint,
        executor: async (params) => {
          if (params.signal === undefined) {
            throw new Error("executor signal is required");
          }

          expect(params.signal.aborted).toBe(false);
          executionSignals.push(params.signal);
          return await executeWorkflow(params);
        },
      }),
    ).toBe(0);

    expect(executionSignals).toHaveLength(3);
    expect(new Set(executionSignals).size).toBe(3);
    expect(executionSignals.every((signal) => !signal.aborted)).toBe(true);
    expect(sigint.handlers.size).toBe(0);
  });
});
