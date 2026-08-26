import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runShellCommand,
  ShellCommandError,
} from "../../src/shell";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aira-shell-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function writeScript(name: string, source: string): Promise<string> {
  const filePath = path.join(directory, name);
  await writeFile(filePath, source, "utf8");
  return filePath;
}

function bunCommand(filePath: string): string {
  return `${quoteForShell(process.execPath)} ${quoteForShell(filePath)}`;
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function getShellError(
  operation: () => Promise<unknown>,
): Promise<ShellCommandError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ShellCommandError);
    return error as ShellCommandError;
  }

  throw new Error("expected shell command to fail at runtime");
}

describe("shell runner", () => {
  test("returns a successful result for exit code zero", async () => {
    const script = await writeScript(
      "success.ts",
      'process.stdout.write("done");\n',
    );
    const result = await runShellCommand({
      command: bunCommand(script),
      cwd: directory,
      timeout: 5,
    });

    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("done");
    expect(result.stderr).toBe("");
  });

  test("returns a failed result with the actual exit code", async () => {
    const script = await writeScript(
      "failure.ts",
      'process.stderr.write("failed");\nprocess.exit(7);\n',
    );
    const result = await runShellCommand({
      command: bunCommand(script),
      cwd: directory,
      timeout: 5,
    });

    expect(result.exitCode).toBe(7);
    expect(result.success).toBe(false);
    expect(result.stderr).toBe("failed");
  });

  test("captures stdout and stderr separately", async () => {
    const script = await writeScript(
      "streams.ts",
      'process.stdout.write("standard output");\n' +
        'process.stderr.write("standard error");\n',
    );
    const result = await runShellCommand({
      command: bunCommand(script),
      cwd: directory,
    });

    expect(result.stdout).toBe("standard output");
    expect(result.stderr).toBe("standard error");
  });

  test("builds deterministic labeled combined output", async () => {
    const script = await writeScript(
      "combined.ts",
      'process.stdout.write("out");\nprocess.stderr.write("err");\n',
    );
    const result = await runShellCommand({
      command: bunCommand(script),
      cwd: directory,
    });

    expect(result.output).toBe("STDOUT:\nout\n\nSTDERR:\nerr");
  });

  test("runs the command in the requested cwd", async () => {
    const workDirectory = path.join(directory, "project");
    await mkdir(workDirectory);
    const script = await writeScript(
      "cwd.ts",
      "process.stdout.write(process.cwd());\n",
    );
    const result = await runShellCommand({
      command: bunCommand(script),
      cwd: workDirectory,
    });

    expect(path.resolve(result.stdout)).toBe(path.resolve(workDirectory));
  });

  test("terminates a command that exceeds its timeout", async () => {
    const script = await writeScript(
      "timeout.ts",
      'process.stdout.write("started");\nawait Bun.sleep(5_000);\n',
    );
    const started = performance.now();
    const error = await getShellError(() =>
      runShellCommand({
        command: bunCommand(script),
        cwd: directory,
        timeout: 0.05,
      }),
    );

    expect(error.kind).toBe("timeout");
    expect(error.exitCode).toBe(124);
    expect(error.message).toContain("timed out after 0.05 seconds");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("reports a non-existent command as a shell failure", async () => {
    const result = await runShellCommand({
      command: "aira-command-that-does-not-exist-5f77b3",
      cwd: directory,
      timeout: 5,
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.output).toContain("STDERR:");
  });

  test("reports a process spawn failure such as an invalid cwd", async () => {
    const error = await getShellError(() =>
      runShellCommand({
        command: `${process.execPath} --version`,
        cwd: path.join(directory, "missing"),
        timeout: 5,
      }),
    );

    expect(error.kind).toBe("spawn");
    expect(error.message).toContain("could not start shell command");
  });

  test("preserves multiline UTF-8 output", async () => {
    const script = await writeScript(
      "multiline.ts",
      'process.stdout.write("first\\nsecond λ\\nthird\\n");\n' +
        'process.stderr.write("warning one\\nwarning two\\n");\n',
    );
    const result = await runShellCommand({
      command: bunCommand(script),
      cwd: directory,
    });

    expect(result.stdout).toBe("first\nsecond λ\nthird\n");
    expect(result.stderr).toBe("warning one\nwarning two\n");
    expect(result.output).toContain("first\nsecond λ\nthird");
    expect(result.output).toContain("warning one\nwarning two");
  });
});
