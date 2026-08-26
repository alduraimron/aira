import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { RunStateError } from "./errors";
import { generateRunId } from "./id";
import { getRunPaths, type RunPaths } from "./paths";
import { runStateSchema } from "./schema";
import { initializeStepStates } from "./state";
import type { RunState } from "./types";

export interface CreateRunParams {
  runsRoot: string;
  workflow: string;
  input: Record<string, unknown>;
  stepIds: readonly string[];
  now?: Date;
}

export async function createRun(params: CreateRunParams): Promise<RunState> {
  const now = params.now ?? new Date();
  const timestamp = getIsoTimestamp(now);
  const id = generateRunId(now);
  const paths = getRunPaths(params.runsRoot, id);
  const state: RunState = {
    version: 1,
    id,
    workflow: params.workflow,
    status: "running",
    input: { ...params.input },
    started_at: timestamp,
    updated_at: timestamp,
    steps: initializeStepStates(params.stepIds),
    artifacts: {},
  };

  const validatedState = validateRunState(state, paths);

  try {
    await mkdir(path.dirname(paths.root), { recursive: true });
    await mkdir(paths.root);
    await Promise.all([
      mkdir(paths.artifactsDir, { recursive: true }),
      mkdir(paths.sessionsDir, { recursive: true }),
      mkdir(paths.logsDir, { recursive: true }),
    ]);
  } catch (error) {
    throw new RunStateError("Could not create run directory layout", {
      runId: id,
      filePath: paths.root,
      cause: error,
    });
  }

  await writeStateAtomically(paths, validatedState);
  return state;
}

export async function loadRun(
  runsRoot: string,
  runId: string,
): Promise<RunState> {
  const paths = getRunPaths(runsRoot, runId);
  let source: string;

  try {
    source = await readFile(paths.stateFile, "utf8");
  } catch (error) {
    throw new RunStateError("Could not read run state", {
      runId,
      filePath: paths.stateFile,
      cause: error,
    });
  }

  let document: unknown;

  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new RunStateError("Run state contains invalid JSON", {
      runId,
      filePath: paths.stateFile,
      cause: error,
    });
  }

  const state = validateRunState(document, paths);

  if (state.id !== runId) {
    throw new RunStateError(
      `Run state ID "${state.id}" does not match its directory`,
      {
        runId,
        filePath: paths.stateFile,
      },
    );
  }

  return state;
}

/**
 * Saves state through a temporary file and updates state.updated_at after the
 * rename succeeds. No other input fields are mutated.
 */
export async function saveRun(
  runsRoot: string,
  state: RunState,
  now: Date = new Date(),
): Promise<void> {
  const paths = getRunPaths(runsRoot, state.id);
  const updatedAt = getIsoTimestamp(now);
  const candidate: RunState = {
    ...state,
    updated_at: updatedAt,
  };
  const validatedState = validateRunState(candidate, paths);

  await writeStateAtomically(paths, validatedState);
  state.updated_at = updatedAt;
}

function validateRunState(document: unknown, paths: RunPaths): RunState {
  const result = runStateSchema.safeParse(document);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const issuePath = formatIssuePath(issue.path);
        return issuePath.length > 0
          ? `${issuePath}: ${issue.message}`
          : issue.message;
      })
      .join("; ");

    throw new RunStateError(`Run state failed validation: ${details}`, {
      runId: getDocumentRunId(document),
      filePath: paths.stateFile,
      cause: result.error,
    });
  }

  return result.data;
}

async function writeStateAtomically(
  paths: RunPaths,
  state: RunState,
): Promise<void> {
  const temporaryFile = `${paths.stateFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;

  try {
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(temporaryFile, serialized, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryFile, paths.stateFile);
  } catch (error) {
    try {
      await unlink(temporaryFile);
    } catch {
      // The temporary file may not exist or may already have been renamed.
    }

    throw new RunStateError("Could not save run state", {
      runId: state.id,
      filePath: paths.stateFile,
      cause: error,
    });
  }
}

function getIsoTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    throw new RunStateError("Run timestamp must be a valid date");
  }

  return date.toISOString();
}

function getDocumentRunId(document: unknown): string | undefined {
  if (
    typeof document === "object" &&
    document !== null &&
    "id" in document &&
    typeof document.id === "string"
  ) {
    return document.id;
  }

  return undefined;
}

function formatIssuePath(parts: readonly PropertyKey[]): string {
  let result = "run";

  for (const part of parts) {
    if (typeof part === "number") {
      result += `[${part}]`;
      continue;
    }

    const key = String(part);

    if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)) {
      result += `.${key}`;
    } else {
      result += `[${JSON.stringify(key)}]`;
    }
  }

  return result;
}
