export const ROOT_USAGE = `Usage:
  aira init
  aira list
  aira run <workflow> <task> [--dry-run] [--allow-dirty]
  aira status [run-id]
  aira resume <run-id>
`;

const COMMAND_USAGE = {
  init: "Usage: aira init\n",
  list: "Usage: aira list\n",
  run: "Usage: aira run <workflow> <task> [--dry-run] [--allow-dirty]\n",
  status: "Usage: aira status [run-id]\n",
  resume: "Usage: aira resume <run-id>\n",
} as const;

export type CliCommandName = keyof typeof COMMAND_USAGE;

export type ParsedCliCommand =
  | { command: "help"; target?: CliCommandName }
  | { command: "init" }
  | { command: "list" }
  | {
      command: "run";
      workflow: string;
      task: string;
      dryRun: boolean;
      allowDirty: boolean;
    }
  | { command: "status"; runId?: string }
  | { command: "resume"; runId: string };

export class CliUsageError extends Error {
  readonly usage: string;

  constructor(message: string, usage = ROOT_USAGE) {
    super(message);
    this.name = "CliUsageError";
    this.usage = usage;
  }
}

export function getCommandUsage(command: CliCommandName): string {
  return COMMAND_USAGE[command];
}

export function parseCliArgs(argv: readonly string[]): ParsedCliCommand {
  const command = argv[0];

  if (command === undefined) {
    throw new CliUsageError("missing command");
  }

  if (command === "--help") {
    if (argv.length !== 1) {
      throw new CliUsageError('"--help" does not accept arguments');
    }

    return { command: "help" };
  }

  if (!isCommandName(command)) {
    if (command.startsWith("-")) {
      throw new CliUsageError(`unknown option "${command}"`);
    }

    throw new CliUsageError(`unknown command "${command}"`);
  }

  const args = argv.slice(1);

  if (args.includes("--help")) {
    if (args.length !== 1) {
      throw new CliUsageError(
        `"aira ${command} --help" does not accept other arguments`,
        getCommandUsage(command),
      );
    }

    return { command: "help", target: command };
  }

  switch (command) {
    case "init":
    case "list":
      assertNoArguments(command, args);
      return { command };
    case "run":
      return parseRunArgs(args);
    case "status":
      return parseStatusArgs(args);
    case "resume":
      return parseResumeArgs(args);
  }
}

function parseRunArgs(args: readonly string[]): ParsedCliCommand {
  const positionals: string[] = [];
  let dryRun = false;
  let allowDirty = false;

  for (const argument of args) {
    if (argument === "--dry-run") {
      if (dryRun) {
        throw new CliUsageError(
          'option "--dry-run" was provided more than once',
          getCommandUsage("run"),
        );
      }

      dryRun = true;
      continue;
    }

    if (argument === "--allow-dirty") {
      if (allowDirty) {
        throw new CliUsageError(
          'option "--allow-dirty" was provided more than once',
          getCommandUsage("run"),
        );
      }

      allowDirty = true;
      continue;
    }

    if (argument.startsWith("-")) {
      throw new CliUsageError(
        `unknown run option "${argument}"`,
        getCommandUsage("run"),
      );
    }

    positionals.push(argument);
  }

  if (positionals.length !== 2) {
    throw new CliUsageError(
      "run requires a workflow and task",
      getCommandUsage("run"),
    );
  }

  const workflow = positionals[0];
  const task = positionals[1];

  if (workflow === undefined || task === undefined) {
    throw new CliUsageError(
      "run requires a workflow and task",
      getCommandUsage("run"),
    );
  }

  if (task.trim().length === 0) {
    throw new CliUsageError(
      "run task must not be empty",
      getCommandUsage("run"),
    );
  }

  return { command: "run", workflow, task, dryRun, allowDirty };
}

function parseStatusArgs(args: readonly string[]): ParsedCliCommand {
  assertNoOptions("status", args);

  if (args.length > 1) {
    throw new CliUsageError(
      "status accepts at most one run ID",
      getCommandUsage("status"),
    );
  }

  const runId = args[0];
  return runId === undefined
    ? { command: "status" }
    : { command: "status", runId };
}

function parseResumeArgs(args: readonly string[]): ParsedCliCommand {
  assertNoOptions("resume", args);

  if (args.length !== 1 || args[0] === undefined) {
    throw new CliUsageError(
      "resume requires one run ID",
      getCommandUsage("resume"),
    );
  }

  return { command: "resume", runId: args[0] };
}

function assertNoArguments(
  command: "init" | "list",
  args: readonly string[],
): void {
  if (args.length === 0) {
    return;
  }

  const option = args.find((argument) => argument.startsWith("-"));
  const message =
    option === undefined
      ? `${command} does not accept arguments`
      : `unknown ${command} option "${option}"`;
  throw new CliUsageError(message, getCommandUsage(command));
}

function assertNoOptions(
  command: "status" | "resume",
  args: readonly string[],
): void {
  const option = args.find((argument) => argument.startsWith("-"));

  if (option !== undefined) {
    throw new CliUsageError(
      `unknown ${command} option "${option}"`,
      getCommandUsage(command),
    );
  }
}

function isCommandName(value: string): value is CliCommandName {
  return Object.prototype.hasOwnProperty.call(COMMAND_USAGE, value);
}
