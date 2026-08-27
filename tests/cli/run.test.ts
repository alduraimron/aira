import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import type { AgentRuntime } from "../../src/agent";
import { runCli } from "../../src/cli";
import type { WorkflowExecutor } from "../../src/cli";
import type { GitCommandRunner } from "../../src/git";
import { listRunIds, loadRun } from "../../src/run";
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
  directory = await createTemporaryDirectory("aira-cli-run-");
  paths = await createCliProject(directory);
});

afterEach(async () => {
  await removeTemporaryDirectory(directory);
});

const nonGitRunner: GitCommandRunner = async () => ({
  exitCode: 128,
  stdout: "",
  stderr: "fatal: not a git repository",
});

function gitRunner(statusOutput: string): GitCommandRunner {
  return async (args) =>
    args[0] === "rev-parse"
      ? { exitCode: 0, stdout: "true\n", stderr: "" }
      : { exitCode: 0, stdout: statusOutput, stderr: "" };
}

async function writeShellWorkflow(name = "feature"): Promise<void> {
  await writeWorkflowFixture(
    paths,
    `${name}.yaml`,
    `
name: ${name}
steps:
  - id: work
    uses: shell
    run: "echo work"
`,
  );
}

describe("aira run preparation and Git protection", () => {
  test("creates RunState with task, workflow identity, and flattened IDs", async () => {
    await writeCommandFixture(paths, "repair");
    await writeWorkflowFixture(
      paths,
      "feature.yaml",
      `
name: feature
steps:
  - id: before
    uses: shell
    run: before
  - id: cycle
    uses: loop
    max_attempts: 2
    until: "steps.verify.success == true"
    steps:
      - id: verify
        uses: shell
        run: verify
      - id: repair
        uses: agent
        command: repair
`,
    );
    const io = new TestCliIO();
    const fakeRuntime: AgentRuntime = {
      async runStep() {
        throw new Error("fake executor should own execution");
      },
    };
    let executorCalls = 0;
    let receivedRuntime: AgentRuntime | undefined;

    const exitCode = await runCli(["run", "feature", "Implement JWT"], {
      cwd: directory,
      io,
      gitCommandRunner: nonGitRunner,
      agentRuntimeFactory: () => fakeRuntime,
      executor: async (params) => {
        executorCalls += 1;
        receivedRuntime = params.agentRuntime;
        return { ...params.state, status: "completed" };
      },
    });

    expect(exitCode).toBe(0);
    expect(executorCalls).toBe(1);
    expect(receivedRuntime).toBe(fakeRuntime);
    const runIds = await listRunIds(paths.runsDir);
    expect(runIds).toHaveLength(1);
    const state = await loadRun(paths.runsDir, runIds[0] ?? "");
    expect(state.workflow).toBe("feature");
    expect(state.input).toEqual({ task: "Implement JWT" });
    expect(Object.keys(state.steps)).toEqual([
      "before",
      "cycle",
      "verify",
      "repair",
    ]);
    expect(io.out).toContain(`Run completed: ${state.id}`);
  });

  test("allows a clean Git repository", async () => {
    await writeShellWorkflow();
    let calls = 0;

    expect(
      await runCli(["run", "feature", "task"], {
        cwd: directory,
        io: new TestCliIO(),
        gitCommandRunner: gitRunner(""),
        executor: async (params) => {
          calls += 1;
          return { ...params.state, status: "completed" };
        },
      }),
    ).toBe(0);
    expect(calls).toBe(1);
  });

  test("blocks a dirty repository before run creation", async () => {
    await writeShellWorkflow();
    const io = new TestCliIO();
    let calls = 0;

    expect(
      await runCli(["run", "feature", "task"], {
        cwd: directory,
        io,
        gitCommandRunner: gitRunner(" M src/file.ts\n"),
        executor: async (params) => {
          calls += 1;
          return params.state;
        },
      }),
    ).toBe(1);
    expect(io.error).toContain(
      "working tree is dirty; commit/stash changes or use --allow-dirty",
    );
    expect(calls).toBe(0);
    expect(await readdir(paths.runsDir)).toEqual([]);
  });

  test("--allow-dirty bypasses the Git check", async () => {
    await writeShellWorkflow();
    let gitCalls = 0;
    let executorCalls = 0;

    expect(
      await runCli(["run", "feature", "task", "--allow-dirty"], {
        cwd: directory,
        io: new TestCliIO(),
        gitCommandRunner: async () => {
          gitCalls += 1;
          throw new Error("Git must not run");
        },
        executor: async (params) => {
          executorCalls += 1;
          return { ...params.state, status: "completed" };
        },
      }),
    ).toBe(0);
    expect(gitCalls).toBe(0);
    expect(executorCalls).toBe(1);
  });

  test("allows non-Git projects", async () => {
    await writeShellWorkflow();

    expect(
      await runCli(["run", "feature", "task"], {
        cwd: directory,
        io: new TestCliIO(),
        gitCommandRunner: nonGitRunner,
        executor: async (params) => ({
          ...params.state,
          status: "completed",
        }),
      }),
    ).toBe(0);
  });

  test("reports an unexpected Git failure before creating a run", async () => {
    await writeShellWorkflow();
    const io = new TestCliIO();

    expect(
      await runCli(["run", "feature", "task"], {
        cwd: directory,
        io,
        gitCommandRunner: async () => ({
          exitCode: 128,
          stdout: "",
          stderr: "fatal: unsafe repository",
        }),
      }),
    ).toBe(1);
    expect(io.error).toContain("git rev-parse failed");
    expect(await readdir(paths.runsDir)).toEqual([]);
  });
});

describe("aira run result mapping", () => {
  test.each([
    ["completed", 0, "Run completed:"],
    ["failed", 1, "Run failed:"],
    ["cancelled", 2, "Run cancelled."],
    ["interrupted", 130, "Run interrupted:"],
  ] as const)("maps %s runs to exit %i", async (status, expected, message) => {
    await writeShellWorkflow(status);
    const io = new TestCliIO();

    const exitCode = await runCli(["run", status, "task"], {
      cwd: directory,
      io,
      gitCommandRunner: nonGitRunner,
      executor: async (params) => ({ ...params.state, status }),
    });

    expect(exitCode).toBe(expected);
    expect(`${io.out}${io.error}`).toContain(message);
  });
});

describe("CLI AbortController wiring", () => {
  test("passes the signal, maps graceful interruption, and removes the handler", async () => {
    await writeShellWorkflow();
    const io = new TestCliIO();
    const signals = new TestSigintSource();
    let receivedSignal: AbortSignal | undefined;

    const executor: WorkflowExecutor = async (params) => {
      receivedSignal = params.signal;
      expect(receivedSignal?.aborted).toBe(false);
      signals.emit();
      expect(receivedSignal?.aborted).toBe(true);
      return { ...params.state, status: "interrupted" };
    };

    expect(
      await runCli(["run", "feature", "task"], {
        cwd: directory,
        io,
        gitCommandRunner: nonGitRunner,
        executor,
        sigintSource: signals,
      }),
    ).toBe(130);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(io.error).toContain("Interrupting current step...");
    expect(signals.addCalls).toBe(1);
    expect(signals.removeCalls).toBe(1);
    expect(signals.handlers.size).toBe(0);
  });

  test("a completed command leaves no signal handler installed", async () => {
    await writeShellWorkflow();
    const signals = new TestSigintSource();

    expect(
      await runCli(["run", "feature", "task"], {
        cwd: directory,
        io: new TestCliIO(),
        gitCommandRunner: nonGitRunner,
        sigintSource: signals,
        executor: async (params) => ({
          ...params.state,
          status: "completed",
        }),
      }),
    ).toBe(0);
    expect(signals.addCalls).toBe(1);
    expect(signals.removeCalls).toBe(1);
    expect(signals.handlers.size).toBe(0);
  });
});
