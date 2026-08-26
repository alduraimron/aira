import {
  ReferenceResolutionError,
  resolveReference,
} from "../context/reference";
import type { TemplateContext } from "../context/types";

export class TemplateInterpolationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TemplateInterpolationError";
  }
}

export function interpolateTemplate(
  template: string,
  context: TemplateContext,
): string {
  let result = "";
  let cursor = 0;

  while (cursor < template.length) {
    const openingIndex = template.indexOf("{{", cursor);
    const closingIndex = template.indexOf("}}", cursor);

    if (
      closingIndex !== -1 &&
      (openingIndex === -1 || closingIndex < openingIndex)
    ) {
      throw new TemplateInterpolationError(
        `unmatched closing template delimiter "}}" at character ${closingIndex}`,
      );
    }

    if (openingIndex === -1) {
      result += template.slice(cursor);
      break;
    }

    result += template.slice(cursor, openingIndex);

    const placeholderEnd = template.indexOf("}}", openingIndex + 2);

    if (placeholderEnd === -1) {
      throw new TemplateInterpolationError(
        `unmatched opening template delimiter "{{" at character ${openingIndex}`,
      );
    }

    const expression = template.slice(openingIndex + 2, placeholderEnd);
    const reference = expression.trim();

    if (reference.length === 0) {
      throw new TemplateInterpolationError("template expression must not be empty");
    }

    if (/\r|\n/.test(expression)) {
      throw new TemplateInterpolationError(
        "template references must not span multiple lines",
      );
    }

    if (expression.includes("{{")) {
      throw new TemplateInterpolationError(
        `invalid template reference "${reference}"`,
      );
    }

    const value = resolveTemplateReference(reference, context);
    result += formatTemplateValue(value, reference);
    cursor = placeholderEnd + 2;
  }

  return result;
}

function resolveTemplateReference(
  reference: string,
  context: TemplateContext,
): unknown {
  try {
    return resolveReference(reference, context);
  } catch (error) {
    if (!(error instanceof ReferenceResolutionError)) {
      throw error;
    }

    switch (error.code) {
      case "invalid_reference":
        throw new TemplateInterpolationError(
          `invalid template reference "${reference}"`,
          { cause: error },
        );
      case "unknown_namespace":
        throw new TemplateInterpolationError(
          `unknown template namespace "${error.namespace ?? ""}"`,
          { cause: error },
        );
      case "forbidden_segment":
        throw new TemplateInterpolationError(
          `invalid template reference "${reference}": path segment ` +
            `"${error.segment ?? ""}" is not allowed`,
          { cause: error },
        );
      case "not_found":
        throw new TemplateInterpolationError(
          `template reference "${reference}" was not found`,
          { cause: error },
        );
    }
  }
}

function formatTemplateValue(value: unknown, reference: string): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
      return String(value);
    case "object": {
      try {
        const serialized = JSON.stringify(value, null, 2);

        if (serialized === undefined) {
          throw new TypeError("JSON serialization returned undefined");
        }

        return serialized;
      } catch (error) {
        throw new TemplateInterpolationError(
          `template reference "${reference}" could not be serialized as JSON: ` +
            getErrorMessage(error),
          { cause: error },
        );
      }
    }
    case "undefined":
      throw new TemplateInterpolationError(
        `template reference "${reference}" was not found`,
      );
    default:
      throw new TemplateInterpolationError(
        `template reference "${reference}" has unsupported value type ` +
          `"${typeof value}"`,
      );
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
