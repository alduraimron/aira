const SENSITIVE_ASSIGNMENT_PATTERN =
  /(\b[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|credential|authorization)[A-Za-z0-9_-]*\s*=\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;&|]+)/gi;
const SENSITIVE_FLAG_PATTERN =
  /(--[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|credential|authorization)[A-Za-z0-9_-]*(?:\s*=\s*|\s+))(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;&|]+)/gi;
const BEARER_TOKEN_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const PROVIDER_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g;

/** Returns bounded, single-line text safe for operator-facing displays. */
export function sanitizeDisplayText(
  value: string,
  maxLength: number,
): string {
  const sourceLimit = Math.max(maxLength + 1, maxLength * 4);
  const sourceWasTruncated = value.length > sourceLimit;
  const bounded = sourceWasTruncated ? value.slice(0, sourceLimit) : value;
  const inline = bounded
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSensitiveText(inline);

  if (!sourceWasTruncated && redacted.length <= maxLength) {
    return redacted;
  }

  return `${redacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, "$1[redacted]")
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, "$1[redacted]")
    .replace(SENSITIVE_FLAG_PATTERN, "$1[redacted]")
    .replace(PROVIDER_TOKEN_PATTERN, "[redacted]");
}
