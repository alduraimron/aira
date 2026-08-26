import type { AiraConfig } from "./types";

export interface ConfigValidationIssue {
  message: string;
  path?: string;
}

export class ConfigValidationError extends Error {
  readonly filePath?: string;
  readonly issues: readonly ConfigValidationIssue[];

  constructor(
    issues: readonly ConfigValidationIssue[],
    filePath?: string,
    options?: ErrorOptions,
  ) {
    const heading = filePath
      ? `Config validation failed for "${filePath}"`
      : "Config validation failed";
    const details = issues.map(formatIssue).map((issue) => `- ${issue}`);

    super(`${heading}:\n${details.join("\n")}`, options);
    this.name = "ConfigValidationError";
    this.filePath = filePath;
    this.issues = issues;
  }
}

export function validateConfig(
  config: AiraConfig,
  filePath?: string,
): AiraConfig {
  const model = config.defaults?.model;

  if (
    model !== undefined &&
    !Object.prototype.hasOwnProperty.call(config.models ?? {}, model)
  ) {
    throw new ConfigValidationError(
      [
        {
          path: "config.defaults.model",
          message: `model alias "${model}" is not defined in config.models`,
        },
      ],
      filePath,
    );
  }

  return config;
}

function formatIssue(issue: ConfigValidationIssue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}
