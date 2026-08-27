export const CLI_EXIT_SUCCESS = 0;
export const CLI_EXIT_FAILURE = 1;
export const CLI_EXIT_CANCELLED = 2;
export const CLI_EXIT_INTERRUPTED = 130;

export type CliExitCode =
  | typeof CLI_EXIT_SUCCESS
  | typeof CLI_EXIT_FAILURE
  | typeof CLI_EXIT_CANCELLED
  | typeof CLI_EXIT_INTERRUPTED;
