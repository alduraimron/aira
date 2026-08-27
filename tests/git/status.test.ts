import { describe, expect, test } from "bun:test";

import {
  GitStatusError,
  inspectGitWorkingTree,
  type GitCommandResult,
  type GitCommandRunner,
} from "../../src/git";

function sequenceRunner(
  results: Array<GitCommandResult | Error>,
  calls: string[][] = [],
): GitCommandRunner {
  return async (args) => {
    calls.push([...args]);
    const result = results.shift();

    if (result instanceof Error) {
      throw result;
    }

    if (result === undefined) {
      throw new Error("unexpected git command");
    }

    return result;
  };
}

const insideGit: GitCommandResult = {
  exitCode: 0,
  stdout: "true\n",
  stderr: "",
};

describe("Git working tree inspection", () => {
  test("allows a clean repository", async () => {
    const calls: string[][] = [];
    const status = await inspectGitWorkingTree(
      "/project",
      sequenceRunner(
        [insideGit, { exitCode: 0, stdout: "", stderr: "" }],
        calls,
      ),
    );

    expect(status).toEqual({ isGitRepository: true, dirty: false });
    expect(calls).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["status", "--porcelain"],
    ]);
  });

  test("reports a dirty repository", async () => {
    const status = await inspectGitWorkingTree(
      "/project",
      sequenceRunner([
        insideGit,
        { exitCode: 0, stdout: " M src/file.ts\n?? new.txt\n", stderr: "" },
      ]),
    );

    expect(status).toEqual({ isGitRepository: true, dirty: true });
  });

  test("allows a non-Git directory without running status", async () => {
    const calls: string[][] = [];
    const status = await inspectGitWorkingTree(
      "/project",
      sequenceRunner(
        [
          {
            exitCode: 128,
            stdout: "",
            stderr: "fatal: not a git repository",
          },
        ],
        calls,
      ),
    );

    expect(status).toEqual({ isGitRepository: false, dirty: false });
    expect(calls).toHaveLength(1);
  });

  test("reports unexpected rev-parse failures", async () => {
    await expect(
      inspectGitWorkingTree(
        "/project",
        sequenceRunner([
          { exitCode: 128, stdout: "", stderr: "fatal: unsafe repository" },
        ]),
      ),
    ).rejects.toThrow("git rev-parse failed: fatal: unsafe repository");
  });

  test("reports Git executable failures separately from non-Git", async () => {
    await expect(
      inspectGitWorkingTree(
        "/project",
        sequenceRunner([new Error("spawn git ENOENT")]),
      ),
    ).rejects.toBeInstanceOf(GitStatusError);

    await expect(
      inspectGitWorkingTree(
        "/project",
        sequenceRunner([insideGit, new Error("status spawn failed")]),
      ),
    ).rejects.toThrow("could not execute git status");
  });
});
