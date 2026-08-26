import { spawn } from "node:child_process";

import type {
  RunShellCommandParams,
  ShellCommandResult,
} from "./types";

export const DEFAULT_SHELL_TIMEOUT_SECONDS = 300;
export const SHELL_TIMEOUT_EXIT_CODE = 124;

export type ShellCommandErrorKind = "spawn" | "timeout" | "signal";

interface ShellCommandErrorOptions extends ErrorOptions {
  kind: ShellCommandErrorKind;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: NodeJS.Signals | null;
}

export class ShellCommandError extends Error {
  readonly kind: ShellCommandErrorKind;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly exitCode: number;
  readonly signal?: NodeJS.Signals | null;

  constructor(message: string, options: ShellCommandErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "ShellCommandError";
    this.kind = options.kind;
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
    this.output = combineShellOutput(this.stdout, this.stderr);
    this.exitCode = options.exitCode ?? 1;
    this.signal = options.signal;
  }
}

export async function runShellCommand(
  params: RunShellCommandParams,
): Promise<ShellCommandResult> {
  assertShellCommandParams(params);

  const timeout = params.timeout ?? DEFAULT_SHELL_TIMEOUT_SECONDS;
  const timeoutMilliseconds = Math.ceil(timeout * 1_000);

  return await new Promise<ShellCommandResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;

    try {
      child = spawn(params.command, {
        cwd: params.cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (cause) {
      reject(
        new ShellCommandError(
          `could not start shell command: ${getErrorMessage(cause)}`,
          { kind: "spawn", cause },
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutFallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = () => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }

      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }

      if (timeoutFallbackTimer !== undefined) {
        clearTimeout(timeoutFallbackTimer);
      }
    };

    const settleWithResult = (result: ShellCommandResult) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      resolve(result);
    };

    const settleWithError = (error: ShellCommandError) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      reject(error);
    };

    const makeTimeoutError = (cause?: unknown) =>
      new ShellCommandError(
        `shell command timed out after ${timeout} seconds`,
        {
          kind: "timeout",
          stdout,
          stderr,
          exitCode: SHELL_TIMEOUT_EXIT_CODE,
          cause,
        },
      );

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (cause) => {
      if (timedOut) {
        settleWithError(makeTimeoutError(cause));
        return;
      }

      settleWithError(
        new ShellCommandError(
          `could not start shell command: ${getErrorMessage(cause)}`,
          {
            kind: "spawn",
            stdout,
            stderr,
            cause,
          },
        ),
      );
    });

    child.once("close", (exitCode, signal) => {
      if (timedOut) {
        settleWithError(makeTimeoutError());
        return;
      }

      if (exitCode === null) {
        settleWithError(
          new ShellCommandError(
            `shell command terminated by signal "${signal ?? "unknown"}"`,
            {
              kind: "signal",
              stdout,
              stderr,
              signal,
            },
          ),
        );
        return;
      }

      settleWithResult({
        exitCode,
        stdout,
        stderr,
        output: combineShellOutput(stdout, stderr),
        success: exitCode === 0,
      });
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;

      // Phase 5 terminates only the spawned shell. Process-tree supervision is
      // intentionally outside this runner's scope.
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may have exited while the timeout callback was queued.
      }

      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may already be gone.
        }

        timeoutFallbackTimer = setTimeout(() => {
          settleWithError(makeTimeoutError());
        }, 250);
      }, 250);
    }, timeoutMilliseconds);
  });
}

export function combineShellOutput(stdout: string, stderr: string): string {
  return `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
}

function assertShellCommandParams(params: RunShellCommandParams): void {
  if (typeof params.command !== "string" || params.command.trim().length === 0) {
    throw new TypeError("shell command must be a non-empty string");
  }

  if (typeof params.cwd !== "string" || params.cwd.length === 0) {
    throw new TypeError("shell command cwd must be a non-empty string");
  }

  const timeout = params.timeout ?? DEFAULT_SHELL_TIMEOUT_SECONDS;

  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError("shell command timeout must be a positive number");
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
