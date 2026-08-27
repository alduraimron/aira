import { spawn } from "node:child_process";

import type {
  RunShellCommandParams,
  ShellCommandResult,
} from "./types";

export const DEFAULT_SHELL_TIMEOUT_SECONDS = 300;
export const SHELL_TIMEOUT_EXIT_CODE = 124;
export const SHELL_ABORT_EXIT_CODE = 130;

export type ShellCommandErrorKind =
  | "spawn"
  | "timeout"
  | "signal"
  | "aborted";

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

  if (params.signal?.aborted === true) {
    throw makePreSpawnAbortError();
  }

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
    let termination: "timeout" | "aborted" | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationFallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimersAndListener = () => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }

      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }

      if (terminationFallbackTimer !== undefined) {
        clearTimeout(terminationFallbackTimer);
      }

      params.signal?.removeEventListener("abort", requestAbort);
    };

    const settleWithResult = (result: ShellCommandResult) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimersAndListener();
      resolve(result);
    };

    const settleWithError = (error: ShellCommandError) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimersAndListener();
      reject(error);
    };

    const makeTerminationError = (cause?: unknown): ShellCommandError => {
      if (termination === "aborted") {
        return new ShellCommandError("shell command aborted by external signal", {
          kind: "aborted",
          stdout,
          stderr,
          exitCode: SHELL_ABORT_EXIT_CODE,
          cause,
        });
      }

      return new ShellCommandError(
        `shell command timed out after ${timeout} seconds`,
        {
          kind: "timeout",
          stdout,
          stderr,
          exitCode: SHELL_TIMEOUT_EXIT_CODE,
          cause,
        },
      );
    };

    const requestTermination = (reason: "timeout" | "aborted") => {
      if (settled || termination !== undefined) {
        return;
      }

      termination = reason;

      // Aira supervises only the spawned shell. Process-tree supervision is
      // intentionally outside this runner's scope.
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may have exited while this callback was queued.
      }

      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may already be gone.
        }

        terminationFallbackTimer = setTimeout(() => {
          settleWithError(makeTerminationError());
        }, 250);
      }, 250);
    };

    function requestAbort(): void {
      requestTermination("aborted");
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (cause) => {
      if (termination !== undefined) {
        settleWithError(makeTerminationError(cause));
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
      if (termination !== undefined) {
        settleWithError(makeTerminationError());
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

    timeoutTimer = setTimeout(
      () => requestTermination("timeout"),
      timeoutMilliseconds,
    );

    if (params.signal !== undefined) {
      params.signal.addEventListener("abort", requestAbort, { once: true });

      if (params.signal.aborted) {
        requestAbort();
      }
    }
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

function makePreSpawnAbortError(): ShellCommandError {
  return new ShellCommandError("shell command aborted by external signal", {
    kind: "aborted",
    exitCode: SHELL_ABORT_EXIT_CODE,
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
