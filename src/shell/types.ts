export interface RunShellCommandParams {
  command: string;
  cwd: string;
  /** Timeout in seconds. */
  timeout?: number;
}

export interface ShellCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
  success: boolean;
}
