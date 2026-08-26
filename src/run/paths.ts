import path from "node:path";

import { RunStateError } from "./errors";
import { RUN_ID_PATTERN } from "./id";

export interface RunPaths {
  root: string;
  stateFile: string;
  artifactsDir: string;
  sessionsDir: string;
  logsDir: string;
}

/** Derives absolute paths for a validated run ID. */
export function getRunPaths(runsRoot: string, runId: string): RunPaths {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new RunStateError(
      `Invalid run ID. Expected ${RUN_ID_PATTERN.source}`,
      { runId: typeof runId === "string" ? runId : String(runId) },
    );
  }

  let resolvedRunsRoot: string;

  try {
    resolvedRunsRoot = path.resolve(runsRoot);
  } catch (error) {
    throw new RunStateError("Could not resolve the runs root", {
      runId,
      filePath: String(runsRoot),
      cause: error,
    });
  }

  const root = path.resolve(resolvedRunsRoot, runId);

  if (!isPathInside(resolvedRunsRoot, root)) {
    throw new RunStateError("Run path escapes the runs root", {
      runId,
      filePath: root,
    });
  }

  return {
    root,
    stateFile: path.join(root, "run.json"),
    artifactsDir: path.join(root, "artifacts"),
    sessionsDir: path.join(root, "sessions"),
    logsDir: path.join(root, "logs"),
  };
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);

  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
