import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { runCli } from "../../src/cli";
import type { GitCommandRunner } from "../../src/git";
import {
  createCliProject,
  createTemporaryDirectory,
  removeTemporaryDirectory,
  TestCliIO,
  writeCommandFixture,
  writeWorkflowFixture,
} from "./helpers";

let directory: string;
let paths: Awaited<ReturnType<typeof createCliProject>>;

beforeEach(async () => {
  directory = await createTemporaryDirectory("aira-cli-list-dry-");
  paths = await createCliProject(directory);
});

afterEach(async () => {
  await removeTemporaryDirectory(directory);
});

describe("aira list", () => {
  test("lists workflows by declared name with deterministic descriptions", async () => {
    await writeWorkflowFixture(
      paths,
      "z-file.yaml",
      `
name: alpha
description: First workflow
steps:
  - id: one
    uses: shell
    run: one
`,
    );
    await writeWorkflowFixture(
      paths,
      "a-file.yml",
      `
name: zulu
description: Last workflow
steps:
  - id: two
    uses: shell
    run: two
`,
    );
    await writeWorkflowFixture(
      paths,
      "middle.yaml",
      `
name: middle
steps:
  - id: three
    uses: approval
`,
    );
    const io = new TestCliIO();

    expect(await runCli(["list"], { cwd: directory, io })).toBe(0);
    expect(io.out.split("\n").filter(Boolean).map((line) => line.trimStart()))
      .toEqual([
        "alpha   First workflow",
        "middle",
        "zulu    Last workflow",
      ]);
  });

  test("reports an empty workflow directory", async () => {
    const io = new TestCliIO();

    expect(await runCli(["list"], { cwd: directory, io })).toBe(0);
    expect(io.out).toBe("No workflows found.\n");
  });

  test("fails instead of hiding an invalid workflow", async () => {
    await writeWorkflowFixture(
      paths,
      "broken.yaml",
      "name: broken\nsteps:\n  - id: bad\n    uses: agent\n",
    );
    const io = new TestCliIO();

    expect(await runCli(["list"], { cwd: directory, io })).toBe(1);
    expect(io.error).toContain("Workflow validation failed");
    expect(io.error).toContain("workflow.steps[0].command");
  });
});

describe("aira run --dry-run", () => {
  async function writeDryRunProject(): Promise<void> {
    await writeFile(
      paths.configFile,
      `defaults:
  model: coding
  agent_timeout: 45
  shell_timeout: 20
  technical_retries: 2
models:
  coding: provider/coding
commands: {}
`,
      "utf8",
    );
    await Promise.all([
      writeCommandFixture(paths, "discover", "Inspect {{ input.task }}."),
      writeCommandFixture(
        paths,
        "repair",
        "---\nretry: 0\n---\nRepair the failure.",
      ),
    ]);
    await writeWorkflowFixture(
      paths,
      "plan.yaml",
      `
name: feature
description: Feature plan
steps:
  - id: discover
    uses: agent
    command: discover
  - id: approve-plan
    uses: approval
    message: Approve?
  - id: verify-cycle
    uses: loop
    max_attempts: 3
    until: "steps.verify.success == true"
    steps:
      - id: verify
        uses: shell
        run: "bun test"
      - id: repair
        uses: agent
        command: repair
`,
    );
  }

  test("validates and prints nested execution without creating or executing", async () => {
    await writeDryRunProject();
    const io = new TestCliIO();
    let executorCalls = 0;
    let runtimeFactoryCalls = 0;
    let gitCalls = 0;
    const gitCommandRunner: GitCommandRunner = async () => {
      gitCalls += 1;
      return { exitCode: 0, stdout: "true\n", stderr: "" };
    };

    const exitCode = await runCli(
      ["run", "feature", "JWT auth", "--dry-run"],
      {
        cwd: directory,
        io,
        gitCommandRunner,
        executor: async () => {
          executorCalls += 1;
          throw new Error("executor must not run");
        },
        agentRuntimeFactory: () => {
          runtimeFactoryCalls += 1;
          throw new Error("AgentRuntime must not be created");
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(io.out).toContain("Workflow: feature");
    expect(io.out).toContain("Task: JWT auth");
    expect(io.out).toContain("discover  agent  command=discover");
    expect(io.out).toContain("verify-cycle  loop  max_attempts=3");
    expect(io.out).toContain("- verify  shell");
    expect(io.out).toContain("- repair  agent  command=repair");
    expect(executorCalls).toBe(0);
    expect(runtimeFactoryCalls).toBe(0);
    expect(gitCalls).toBe(0);
    expect(await readdir(paths.runsDir)).toEqual([]);
  });

  test("dirty Git does not block dry-run", async () => {
    await writeDryRunProject();
    const io = new TestCliIO();
    let gitCalls = 0;

    expect(
      await runCli(["run", "feature", "task", "--dry-run"], {
        cwd: directory,
        io,
        gitCommandRunner: async () => {
          gitCalls += 1;
          return { exitCode: 0, stdout: " M dirty\n", stderr: "" };
        },
      }),
    ).toBe(0);
    expect(gitCalls).toBe(0);
  });

  test("still rejects an invalid config", async () => {
    await writeDryRunProject();
    await writeFile(
      paths.configFile,
      "defaults:\n  agent_timeout: 0\n",
      "utf8",
    );
    const io = new TestCliIO();

    expect(
      await runCli(["run", "feature", "task", "--dry-run"], {
        cwd: directory,
        io,
      }),
    ).toBe(1);
    expect(io.error).toContain("Config validation failed");
    expect(await readdir(paths.runsDir)).toEqual([]);
  });

  test("still rejects an invalid workflow", async () => {
    await writeWorkflowFixture(
      paths,
      "broken.yaml",
      "name: feature\nsteps:\n  - id: broken\n    uses: agent\n",
    );
    const io = new TestCliIO();

    expect(
      await runCli(["run", "feature", "task", "--dry-run"], {
        cwd: directory,
        io,
      }),
    ).toBe(1);
    expect(io.error).toContain("Workflow validation failed");
    expect(await readdir(paths.runsDir)).toEqual([]);
  });

  test("still rejects a missing command before creating a run", async () => {
    await writeWorkflowFixture(
      paths,
      "missing.yaml",
      `
name: missing-command
steps:
  - id: agent
    uses: agent
    command: absent
`,
    );
    const io = new TestCliIO();

    expect(
      await runCli(["run", "missing-command", "task", "--dry-run"], {
        cwd: directory,
        io,
      }),
    ).toBe(1);
    expect(io.error).toContain("could not read command file");
    expect(await readdir(paths.runsDir)).toEqual([]);
  });
});
