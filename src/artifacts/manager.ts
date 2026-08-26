import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getRunPaths } from "../run/paths";
import { saveRun } from "../run/persistence";
import { artifactStateSchema } from "../run/schema";
import type { ArtifactState, RunState } from "../run/types";
import { ArtifactError } from "./errors";
import {
  assertArtifactName,
  getVersionedArtifactFilename,
  resolveArtifactWritePath,
  resolveStoredArtifactAbsolutePath,
} from "./paths";

export interface WriteArtifactParams {
  runsRoot: string;
  state: RunState;
  name: string;
  filename: string;
  versioned: boolean;
  content: string;
}

export interface WriteArtifactResult {
  state: RunState;
  /** Path relative to the run directory. */
  path: string;
}

export interface ReadArtifactParams {
  runsRoot: string;
  state: RunState;
  name: string;
}

export async function writeArtifact(
  params: WriteArtifactParams,
): Promise<WriteArtifactResult> {
  const { runsRoot, state, name, filename, versioned, content } = params;
  assertArtifactName(name, state.id);

  if (typeof content !== "string") {
    throw new ArtifactError("Artifact content must be a string", {
      runId: state.id,
      artifactName: name,
    });
  }

  const paths = getRunPaths(runsRoot, state.id);
  const context = { runId: state.id, artifactName: name };
  const basePath = resolveArtifactWritePath(paths, filename, context);
  const existing = getExistingArtifactState(state, name);
  let artifactState: ArtifactState;
  let targetPath = basePath;

  if (versioned) {
    const previousVersions = getVersionHistory(
      existing,
      basePath.normalizedFilename,
      state.id,
      name,
    );
    const version = previousVersions.length + 1;
    const versionedFilename = getVersionedArtifactFilename(
      basePath.normalizedFilename,
      version,
    );
    targetPath = resolveArtifactWritePath(paths, versionedFilename, context);
    artifactState = {
      current: targetPath.runRelativePath,
      versions: [...previousVersions, targetPath.runRelativePath],
    };
  } else {
    validateNonVersionedState(
      existing,
      basePath.runRelativePath,
      state.id,
      name,
    );
    artifactState = {
      current: basePath.runRelativePath,
    };
  }

  try {
    await mkdir(path.dirname(targetPath.absolutePath), { recursive: true });
    await writeFile(targetPath.absolutePath, content, "utf8");
  } catch (error) {
    throw new ArtifactError("Could not write artifact", {
      runId: state.id,
      artifactName: name,
      filePath: targetPath.absolutePath,
      cause: error,
    });
  }

  const updatedState: RunState = {
    ...state,
    artifacts: {
      ...state.artifacts,
      [name]: artifactState,
    },
  };

  // If this save fails, the artifact file may remain unreferenced. A later
  // write can safely overwrite that path because run.json selects the version.
  await saveRun(runsRoot, updatedState);

  return {
    state: updatedState,
    path: targetPath.runRelativePath,
  };
}

export async function readArtifact(
  params: ReadArtifactParams,
): Promise<string> {
  const absolutePath = getArtifactAbsolutePath(params);

  try {
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new ArtifactError("Could not read artifact", {
      runId: params.state.id,
      artifactName: params.name,
      filePath: absolutePath,
      cause: error,
    });
  }
}

export function getArtifactAbsolutePath(
  params: ReadArtifactParams,
): string {
  const { runsRoot, state, name } = params;
  assertArtifactName(name, state.id);
  const artifact = getExistingArtifactState(state, name);

  if (artifact === undefined) {
    throw new ArtifactError("Artifact is not present in run state", {
      runId: state.id,
      artifactName: name,
    });
  }

  const paths = getRunPaths(runsRoot, state.id);
  return resolveStoredArtifactAbsolutePath(paths, artifact.current, {
    runId: state.id,
    artifactName: name,
  });
}

function getExistingArtifactState(
  state: RunState,
  name: string,
): ArtifactState | undefined {
  if (!Object.prototype.hasOwnProperty.call(state.artifacts, name)) {
    return undefined;
  }

  const result = artifactStateSchema.safeParse(state.artifacts[name]);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => issue.message)
      .join("; ");
    throw new ArtifactError(`Artifact state is invalid: ${details}`, {
      runId: state.id,
      artifactName: name,
      cause: result.error,
    });
  }

  return result.data;
}

function getVersionHistory(
  existing: ArtifactState | undefined,
  baseFilename: string,
  runId: string,
  artifactName: string,
): readonly string[] {
  if (existing === undefined) {
    return [];
  }

  if (existing.versions === undefined) {
    throw new ArtifactError(
      "Artifact was previously written as non-versioned",
      { runId, artifactName },
    );
  }

  for (const [index, storedPath] of existing.versions.entries()) {
    const expectedFilename = getVersionedArtifactFilename(
      baseFilename,
      index + 1,
    );
    const expectedPath = path.posix.join("artifacts", expectedFilename);

    if (storedPath !== expectedPath) {
      throw new ArtifactError(
        `Artifact version history is inconsistent at version ${index + 1}; ` +
          `expected "${expectedPath}" but found "${storedPath}"`,
        { runId, artifactName, filePath: storedPath },
      );
    }
  }

  return existing.versions;
}

function validateNonVersionedState(
  existing: ArtifactState | undefined,
  expectedPath: string,
  runId: string,
  artifactName: string,
): void {
  if (existing === undefined) {
    return;
  }

  if (existing.versions !== undefined) {
    throw new ArtifactError("Artifact was previously written as versioned", {
      runId,
      artifactName,
    });
  }

  if (existing.current !== expectedPath) {
    throw new ArtifactError(
      `Non-versioned artifact path changed; expected "${existing.current}" ` +
        `but received "${expectedPath}"`,
      { runId, artifactName, filePath: expectedPath },
    );
  }
}
