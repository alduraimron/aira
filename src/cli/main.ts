#!/usr/bin/env bun

import { getCommandUsage, parseCliArgs, ROOT_USAGE, CliUsageError } from "./args";
import {
  executeCliCommand,
  type CliCommandDependencies,
} from "./commands";
import { CLI_EXIT_FAILURE } from "./exit-codes";
import {
  createProcessCliIO,
  type CliIO,
  type ClosableCliIO,
} from "./io";

export interface RunCliOptions
  extends Partial<Omit<CliCommandDependencies, "io" | "cwd">> {
  io?: CliIO;
  cwd?: string;
  debug?: boolean;
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const ownedIO: ClosableCliIO | undefined =
    options.io === undefined ? createProcessCliIO() : undefined;
  const io = options.io ?? ownedIO;

  if (io === undefined) {
    throw new Error("CLI I/O could not be initialized");
  }

  try {
    const parsed = parseCliArgs(argv);

    if (parsed.command === "help") {
      io.writeOut(
        parsed.target === undefined
          ? ROOT_USAGE
          : getCommandUsage(parsed.target),
      );
      return 0;
    }

    return await executeCliCommand(parsed, {
      io,
      cwd: options.cwd ?? process.cwd(),
      agentRuntimeFactory: options.agentRuntimeFactory,
      executor: options.executor,
      approvalDecisionApplier: options.approvalDecisionApplier,
      approvalArtifactReader: options.approvalArtifactReader,
      gitCommandRunner: options.gitCommandRunner,
      sigintSource: options.sigintSource,
    });
  } catch (error) {
    io.writeError(`error: ${getErrorMessage(error)}\n`);

    if (error instanceof CliUsageError) {
      io.writeError(error.usage);
    } else if (
      (options.debug ?? process.env.AIRA_DEBUG === "1") &&
      error instanceof Error &&
      error.stack !== undefined
    ) {
      io.writeError(`${error.stack}\n`);
    }

    return CLI_EXIT_FAILURE;
  } finally {
    ownedIO?.close();
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
