export interface ArtifactErrorOptions extends ErrorOptions {
  runId?: string;
  artifactName?: string;
  filePath?: string;
}

export class ArtifactError extends Error {
  readonly runId?: string;
  readonly artifactName?: string;
  readonly filePath?: string;

  constructor(message: string, options: ArtifactErrorOptions = {}) {
    const context: string[] = [];

    if (options.runId !== undefined) {
      context.push(`run "${options.runId}"`);
    }

    if (options.artifactName !== undefined) {
      context.push(`artifact "${options.artifactName}"`);
    }

    if (options.filePath !== undefined) {
      context.push(`path "${options.filePath}"`);
    }

    super(
      context.length > 0 ? `${message} (${context.join(", ")})` : message,
      { cause: options.cause },
    );
    this.name = "ArtifactError";
    this.runId = options.runId;
    this.artifactName = options.artifactName;
    this.filePath = options.filePath;
  }
}

export class ArtifactNotFoundError extends ArtifactError {
  constructor(runId: string, artifactName: string) {
    super("Artifact is not present in run state", { runId, artifactName });
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactVersionNotFoundError extends ArtifactError {
  constructor(runId: string, artifactName: string, filePath: string) {
    super("Artifact version is not present in run state", {
      runId,
      artifactName,
      filePath,
    });
    this.name = "ArtifactVersionNotFoundError";
  }
}
