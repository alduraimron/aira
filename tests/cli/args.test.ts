import { describe, expect, test } from "bun:test";

import {
  CliUsageError,
  parseCliArgs,
  ROOT_USAGE,
  runCli,
} from "../../src/cli";
import { TestCliIO } from "./helpers";

describe("CLI argument parsing", () => {
  test("parses every supported command", () => {
    expect(parseCliArgs(["init"])).toEqual({ command: "init" });
    expect(parseCliArgs(["list"])).toEqual({ command: "list" });
    expect(parseCliArgs(["status"])).toEqual({ command: "status" });
    expect(parseCliArgs(["status", "20260827-070301-a1b2c3d4"])).toEqual({
      command: "status",
      runId: "20260827-070301-a1b2c3d4",
    });
    expect(parseCliArgs(["resume", "20260827-070301-a1b2c3d4"])).toEqual({
      command: "resume",
      runId: "20260827-070301-a1b2c3d4",
    });
    expect(
      parseCliArgs([
        "run",
        "feature",
        "Implement JWT",
        "--dry-run",
        "--allow-dirty",
      ]),
    ).toEqual({
      command: "run",
      workflow: "feature",
      task: "Implement JWT",
      dryRun: true,
      allowDirty: true,
    });
  });

  test("supports root and command help", async () => {
    const rootIO = new TestCliIO();
    const commandIO = new TestCliIO();

    expect(await runCli(["--help"], { io: rootIO })).toBe(0);
    expect(rootIO.out).toBe(ROOT_USAGE);
    expect(await runCli(["run", "--help"], { io: commandIO })).toBe(0);
    expect(commandIO.out).toContain("Usage: aira run");
  });

  test.each([
    { args: [] },
    { args: ["unknown"] },
    { args: ["--unknown"] },
    { args: ["run", "feature"] },
    { args: ["run", "feature", "task", "--unknown"] },
    { args: ["run", "feature", "task", "--dry-run", "--dry-run"] },
    { args: ["status", "one", "two"] },
    { args: ["resume"] },
    { args: ["init", "extra"] },
  ])("rejects invalid arguments $args", ({ args }) => {
    expect(() => parseCliArgs(args)).toThrow(CliUsageError);
  });

  test("prints a useful error and nonzero exit for unknown commands", async () => {
    const io = new TestCliIO();

    expect(await runCli(["doctor"], { io })).toBe(1);
    expect(io.error).toContain('unknown command "doctor"');
    expect(io.error).toContain("Usage:");
  });
});
