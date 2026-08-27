export const DEFAULT_TECHNICAL_RETRIES = 1;

export interface TechnicalRetrySources {
  step?: number;
  command?: number;
  config?: number;
}

/** Resolves retries after the first attempt using most-specific-first precedence. */
export function resolveTechnicalRetryCount(
  sources: TechnicalRetrySources,
): number {
  const candidates = [
    ["workflow step retry", sources.step],
    ["command retry", sources.command],
    ["config technical_retries", sources.config],
  ] as const;

  for (const [source, value] of candidates) {
    if (value === undefined) {
      continue;
    }

    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${source} must be a non-negative integer`);
    }

    return value;
  }

  return DEFAULT_TECHNICAL_RETRIES;
}
