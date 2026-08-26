import path from "node:path";

import type { RunPaths } from "../run/paths";
import { ArtifactError } from "./errors";

export const ARTIFACT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface ResolvedArtifactWritePath {
  normalizedFilename: string;
  runRelativePath: string;
  absolutePath: string;
}

interface ArtifactPathContext {
  runId: string;
  artifactName: string;
}

export function assertArtifactName(name: string, runId?: string): void {
  if (typeof name !== "string" || !ARTIFACT_NAME_PATTERN.test(name)) {
    throw new ArtifactError(
      `Invalid artifact name. Expected ${ARTIFACT_NAME_PATTERN.source}`,
      {
        runId,
        artifactName: typeof name === "string" ? name : String(name),
      },
    );
  }
}

export function resolveArtifactWritePath(
  paths: RunPaths,
  filename: string,
  context: ArtifactPathContext,
): ResolvedArtifactWritePath {
  const problem = getArtifactFilenameProblem(filename);

  if (problem !== undefined) {
    throw new ArtifactError(`Invalid artifact filename: ${problem}`, {
      runId: context.runId,
      artifactName: context.artifactName,
      filePath: typeof filename === "string" ? filename : String(filename),
    });
  }

  const normalizedFilename = normalizePortablePath(filename);
  const runRelativePath = path.posix.join("artifacts", normalizedFilename);
  const absolutePath = path.resolve(
    paths.artifactsDir,
    ...normalizedFilename.split("/"),
  );

  if (!isPathInside(paths.artifactsDir, absolutePath)) {
    throw new ArtifactError("Artifact filename escapes the artifacts directory", {
      runId: context.runId,
      artifactName: context.artifactName,
      filePath: filename,
    });
  }

  return {
    normalizedFilename,
    runRelativePath,
    absolutePath,
  };
}

export function resolveStoredArtifactAbsolutePath(
  paths: RunPaths,
  storedPath: string,
  context: ArtifactPathContext,
): string {
  const problem = getStoredArtifactPathProblem(storedPath);

  if (problem !== undefined) {
    throw new ArtifactError(`Invalid stored artifact path: ${problem}`, {
      runId: context.runId,
      artifactName: context.artifactName,
      filePath:
        typeof storedPath === "string" ? storedPath : String(storedPath),
    });
  }

  const absolutePath = path.resolve(paths.root, ...storedPath.split("/"));

  if (!isPathInside(paths.artifactsDir, absolutePath)) {
    throw new ArtifactError("Stored artifact path escapes the artifacts directory", {
      runId: context.runId,
      artifactName: context.artifactName,
      filePath: storedPath,
    });
  }

  return absolutePath;
}

export function getVersionedArtifactFilename(
  filename: string,
  version: number,
): string {
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError("artifact version must be a positive integer");
  }

  const extension = path.posix.extname(filename);

  if (extension.length === 0) {
    return `${filename}-v${version}`;
  }

  return `${filename.slice(0, -extension.length)}-v${version}${extension}`;
}

export function isSafeStoredArtifactPath(value: string): boolean {
  return getStoredArtifactPathProblem(value) === undefined;
}

function getArtifactFilenameProblem(filename: string): string | undefined {
  if (typeof filename !== "string" || filename.length === 0) {
    return "must not be empty";
  }

  if (filename.includes("\0")) {
    return "must not contain a null byte";
  }

  const portableFilename = filename.replaceAll("\\", "/");
  const windowsRoot = path.win32.parse(filename).root;

  if (
    path.posix.isAbsolute(portableFilename) ||
    path.win32.isAbsolute(filename) ||
    windowsRoot.length > 0
  ) {
    return "must be relative to the artifacts directory";
  }

  if (portableFilename.split("/").some((segment) => segment === "..")) {
    return 'must not contain ".." path segments';
  }

  const normalized = path.posix.normalize(portableFilename);

  if (
    normalized === "." ||
    normalized.length === 0 ||
    portableFilename.endsWith("/")
  ) {
    return "must name a file";
  }

  return undefined;
}

function getStoredArtifactPathProblem(
  storedPath: string,
): string | undefined {
  if (typeof storedPath !== "string" || storedPath.length === 0) {
    return "must not be empty";
  }

  if (storedPath.includes("\0")) {
    return "must not contain a null byte";
  }

  if (storedPath.includes("\\")) {
    return "must use forward slash separators";
  }

  const windowsRoot = path.win32.parse(storedPath).root;

  if (
    path.posix.isAbsolute(storedPath) ||
    path.win32.isAbsolute(storedPath) ||
    windowsRoot.length > 0
  ) {
    return "must be relative to the run directory";
  }

  if (storedPath.split("/").some((segment) => segment === "..")) {
    return 'must not contain ".." path segments';
  }

  const normalized = path.posix.normalize(storedPath);

  if (normalized !== storedPath) {
    return "must use a normalized relative path";
  }

  if (normalized.endsWith("/")) {
    return "must name a file";
  }

  if (!normalized.startsWith("artifacts/")) {
    return 'must be inside the run "artifacts/" directory';
  }

  return undefined;
}

function normalizePortablePath(filename: string): string {
  return path.posix.normalize(filename.replaceAll("\\", "/"));
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
