export interface RunShellCommandParams {
  command: string;
  cwd: string;
  /** Timeout in seconds. */
  timeout?: number;
  /** Cancels the spawned shell without classifying it as a timeout. */
  signal?: AbortSignal;
}

export interface ShellCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
  success: boolean;
}
