import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "../..");
const cliEntrypoint = path.join(projectRoot, "src", "cli", "main.ts");
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-cli-process-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function runProcess(args: string[]) {
  const processHandle = Bun.spawn([process.execPath, cliEntrypoint, ...args], {
    cwd: directory,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("CLI process integration", () => {
  test("package exposes an executable Bun entrypoint", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8"),
    ) as { bin?: Record<string, string> };
    const mode = (await stat(cliEntrypoint)).mode;

    expect(packageJson.bin?.aira).toBe("./src/cli/main.ts");
    expect(mode & 0o111).not.toBe(0);
    expect((await runProcess(["--help"])).stdout).toContain("aira run");
  });

  test("runs init, list, dry-run, execution, and status end to end", async () => {
    const initialized = await runProcess(["init"]);
    expect(initialized.exitCode).toBe(0);
    expect(initialized.stdout).toContain("Initialized Aira");

    const listed = await runProcess(["list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stderr).toBe("");
    expect(
      listed.stdout
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/)[0]),
    ).toEqual(["bugfix", "feature", "investigate"]);

    const dryRun = await runProcess([
      "run",
      "feature",
      "process task",
      "--dry-run",
    ]);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toContain("Workflow: feature");
    expect(dryRun.stdout).toContain("approve-plan  approval");
    expect(await readdir(path.join(directory, ".aira", "runs"))).toEqual([]);

    await writeFile(
      path.join(directory, ".aira", "workflows", "smoke.yaml"),
      `name: smoke
description: Process smoke test
steps:
  - id: hello
    uses: shell
    run: "printf cli-ok"
`,
      "utf8",
    );

    const run = await runProcess(["run", "smoke", "process task"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("Run completed:");

    const status = await runProcess(["status"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Workflow:  smoke");
    expect(status.stdout).toContain("Status:    completed");
    expect(status.stdout).toContain("hello  completed");
  });
});
