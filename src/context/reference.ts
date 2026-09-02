import type { TemplateContext } from "./types";

export const REFERENCE_SEGMENT_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

export const TEMPLATE_CONTEXT_NAMESPACES = [
  "input",
  "config",
  "artifacts",
  "revision",
  "steps",
  "run",
] as const;

export type TemplateContextNamespace =
  (typeof TEMPLATE_CONTEXT_NAMESPACES)[number];

export type ReferenceResolutionErrorCode =
  | "invalid_reference"
  | "unknown_namespace"
  | "forbidden_segment"
  | "not_found";

interface ReferenceResolutionErrorDetails {
  namespace?: string;
  segment?: string;
}

export class ReferenceResolutionError extends Error {
  readonly code: ReferenceResolutionErrorCode;
  readonly reference: string;
  readonly namespace?: string;
  readonly segment?: string;

  constructor(
    code: ReferenceResolutionErrorCode,
    reference: string,
    details: ReferenceResolutionErrorDetails = {},
  ) {
    super(formatReferenceError(code, reference, details));
    this.name = "ReferenceResolutionError";
    this.code = code;
    this.reference = reference;
    this.namespace = details.namespace;
    this.segment = details.segment;
  }
}

const namespaceSet = new Set<string>(TEMPLATE_CONTEXT_NAMESPACES);
const forbiddenSegments = new Set(["__proto__", "constructor", "prototype"]);

export function resolveReference(
  reference: string,
  context: TemplateContext,
): unknown {
  const segments = reference.split(".");

  if (
    reference.length === 0 ||
    segments.some((segment) => !REFERENCE_SEGMENT_PATTERN.test(segment))
  ) {
    throw new ReferenceResolutionError("invalid_reference", reference);
  }

  const namespace = segments[0];

  if (namespace === undefined || !namespaceSet.has(namespace)) {
    throw new ReferenceResolutionError("unknown_namespace", reference, {
      namespace,
    });
  }

  const forbiddenSegment = segments.find((segment) =>
    forbiddenSegments.has(segment),
  );

  if (forbiddenSegment !== undefined) {
    throw new ReferenceResolutionError("forbidden_segment", reference, {
      namespace,
      segment: forbiddenSegment,
    });
  }

  let current: unknown = context;

  for (const segment of segments) {
    if (!isObject(current) || !hasOwnProperty(current, segment)) {
      throw new ReferenceResolutionError("not_found", reference, {
        namespace,
      });
    }

    current = current[segment];
  }

  if (current === undefined) {
    throw new ReferenceResolutionError("not_found", reference, {
      namespace,
    });
  }

  return current;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOwnProperty(
  value: Record<string, unknown>,
  property: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function formatReferenceError(
  code: ReferenceResolutionErrorCode,
  reference: string,
  details: ReferenceResolutionErrorDetails,
): string {
  switch (code) {
    case "invalid_reference":
      return `invalid reference "${reference}"`;
    case "unknown_namespace":
      return `unknown reference namespace "${details.namespace ?? ""}"`;
    case "forbidden_segment":
      return (
        `invalid reference "${reference}": path segment ` +
        `"${details.segment ?? ""}" is not allowed`
      );
    case "not_found":
      return `reference "${reference}" was not found`;
  }
}
