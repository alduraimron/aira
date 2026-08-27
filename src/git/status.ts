import { spawn } from "node:child_process";

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<GitCommandResult>;

export interface GitWorkingTreeStatus {
  isGitRepository: boolean;
  dirty: boolean;
}

export class GitStatusError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitStatusError";
  }
}

export async function inspectGitWorkingTree(
  cwd: string,
  commandRunner: GitCommandRunner = runGitCommand,
): Promise<GitWorkingTreeStatus> {
  let probe: GitCommandResult;

  try {
    probe = await commandRunner(
      ["rev-parse", "--is-inside-work-tree"],
      cwd,
    );
  } catch (cause) {
    throw new GitStatusError(
      `could not execute git: ${getErrorMessage(cause)}`,
      { cause },
    );
  }

  if (probe.exitCode !== 0) {
    if (isNotGitRepositoryResult(probe)) {
      return { isGitRepository: false, dirty: false };
    }

    throw new GitStatusError(
      `git rev-parse failed: ${formatFailure(probe)}`,
    );
  }

  const insideWorkTree = probe.stdout.trim();

  if (insideWorkTree === "false") {
    return { isGitRepository: false, dirty: false };
  }

  if (insideWorkTree !== "true") {
    throw new GitStatusError(
      `git rev-parse returned unexpected output: ${JSON.stringify(insideWorkTree)}`,
    );
  }

  let status: GitCommandResult;

  try {
    status = await commandRunner(["status", "--porcelain"], cwd);
  } catch (cause) {
    throw new GitStatusError(
      `could not execute git status: ${getErrorMessage(cause)}`,
      { cause },
    );
  }

  if (status.exitCode !== 0) {
    throw new GitStatusError(
      `git status failed: ${formatFailure(status)}`,
    );
  }

  return {
    isGitRepository: true,
    dirty: status.stdout.length > 0,
  };
}

export async function runGitCommand(
  args: readonly string[],
  cwd: string,
): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;

    try {
      child = spawn("git", [...args], {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (cause) {
      reject(cause);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (cause) => {
      if (!settled) {
        settled = true;
        reject(cause);
      }
    });
    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;

      if (exitCode === null) {
        reject(new Error(`git terminated by signal "${signal ?? "unknown"}"`));
        return;
      }

      resolve({ exitCode, stdout, stderr });
    });
  });
}

function isNotGitRepositoryResult(result: GitCommandResult): boolean {
  return /not a git repository/i.test(`${result.stderr}\n${result.stdout}`);
}

function formatFailure(result: GitCommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail.length > 0 ? detail : `exit code ${result.exitCode}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
