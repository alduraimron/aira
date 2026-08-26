export const COMPLETE_STEP_TOOL_NAME = "complete_step";

export interface AgentArtifactCompletion {
  name: string;
  content: string;
}

export interface AgentCompletion {
  status: "completed";
  summary: string;
  artifacts: AgentArtifactCompletion[];
}

export interface AgentCompletionSpec {
  expectedArtifacts: string[];
}

export type AgentCompletionValidationResult =
  | { success: true; completion: AgentCompletion }
  | { success: false; error: string };

const completionKeys = new Set(["status", "summary", "artifacts"]);
const artifactKeys = new Set(["name", "content"]);

export function validateAgentCompletion(
  value: unknown,
  spec: AgentCompletionSpec,
): AgentCompletionValidationResult {
  const specError = getAgentCompletionSpecError(spec);

  if (specError !== undefined) {
    return { success: false, error: `invalid completion spec: ${specError}` };
  }

  if (!isRecord(value)) {
    return { success: false, error: "completion payload must be an object" };
  }

  const unexpectedCompletionKey = findUnexpectedKey(value, completionKeys);

  if (unexpectedCompletionKey !== undefined) {
    return {
      success: false,
      error: `completion payload contains unexpected property "${unexpectedCompletionKey}"`,
    };
  }

  if (value.status !== "completed") {
    return {
      success: false,
      error: 'completion status must be exactly "completed"',
    };
  }

  if (typeof value.summary !== "string") {
    return { success: false, error: "completion summary must be a string" };
  }

  if (value.summary.trim().length === 0) {
    return {
      success: false,
      error: "completion summary must contain non-whitespace text",
    };
  }

  if (!Array.isArray(value.artifacts)) {
    return { success: false, error: "completion artifacts must be an array" };
  }

  const artifacts: AgentArtifactCompletion[] = [];
  const firstArtifactIndexes = new Map<string, number>();

  for (const [index, artifact] of value.artifacts.entries()) {
    if (!isRecord(artifact)) {
      return {
        success: false,
        error: `completion artifact at index ${index} must be an object`,
      };
    }

    const unexpectedArtifactKey = findUnexpectedKey(artifact, artifactKeys);

    if (unexpectedArtifactKey !== undefined) {
      return {
        success: false,
        error:
          `completion artifact at index ${index} contains unexpected ` +
          `property "${unexpectedArtifactKey}"`,
      };
    }

    if (typeof artifact.name !== "string" || artifact.name.length === 0) {
      return {
        success: false,
        error: `completion artifact at index ${index} must have a non-empty name`,
      };
    }

    if (typeof artifact.content !== "string") {
      return {
        success: false,
        error: `completion artifact "${artifact.name}" content must be a string`,
      };
    }

    if (artifact.content.trim().length === 0) {
      return {
        success: false,
        error:
          `completion artifact "${artifact.name}" content must contain ` +
          "non-whitespace text",
      };
    }

    const firstIndex = firstArtifactIndexes.get(artifact.name);

    if (firstIndex !== undefined) {
      return {
        success: false,
        error:
          `duplicate completion artifact "${artifact.name}" at index ${index}; ` +
          `first used at index ${firstIndex}`,
      };
    }

    firstArtifactIndexes.set(artifact.name, index);
    artifacts.push({
      name: artifact.name,
      content: artifact.content,
    });
  }

  const expectedNames = new Set(spec.expectedArtifacts);

  for (const expectedName of spec.expectedArtifacts) {
    if (!firstArtifactIndexes.has(expectedName)) {
      return {
        success: false,
        error: `missing expected completion artifact "${expectedName}"`,
      };
    }
  }

  for (const artifact of artifacts) {
    if (!expectedNames.has(artifact.name)) {
      return {
        success: false,
        error: `unexpected completion artifact "${artifact.name}"`,
      };
    }
  }

  return {
    success: true,
    completion: {
      status: "completed",
      summary: value.summary,
      artifacts,
    },
  };
}

export function getAgentCompletionSpecError(
  value: unknown,
): string | undefined {
  if (!isRecord(value)) {
    return "completion spec must be an object";
  }

  if (!Array.isArray(value.expectedArtifacts)) {
    return "expectedArtifacts must be an array";
  }

  const firstIndexes = new Map<string, number>();

  for (const [index, name] of value.expectedArtifacts.entries()) {
    if (typeof name !== "string" || name.trim().length === 0) {
      return `expected artifact at index ${index} must be a non-empty string`;
    }

    const firstIndex = firstIndexes.get(name);

    if (firstIndex !== undefined) {
      return (
        `duplicate expected artifact "${name}" at index ${index}; ` +
        `first used at index ${firstIndex}`
      );
    }

    firstIndexes.set(name, index);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findUnexpectedKey(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): string | undefined {
  return Object.keys(value).find((key) => !allowedKeys.has(key));
}
