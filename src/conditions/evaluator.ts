import {
  ReferenceResolutionError,
  resolveReference,
} from "../context/reference";
import type { TemplateContext } from "../context/types";
import { parseCondition } from "./parser";
import {
  ConditionEvaluationError,
  type ConditionExpressionNode,
  type ConditionValueNode,
} from "./types";

export function evaluateCondition(
  expression: string,
  context: TemplateContext,
): boolean {
  return evaluateExpression(parseCondition(expression), context);
}

function evaluateExpression(
  expression: ConditionExpressionNode,
  context: TemplateContext,
): boolean {
  switch (expression.type) {
    case "comparison": {
      const left = evaluateValue(expression.left, context);
      const right = evaluateValue(expression.right, context);
      const equal = Object.is(left, right);
      return expression.operator === "==" ? equal : !equal;
    }
    case "not":
      return !evaluateExpression(expression.operand, context);
    case "and": {
      const left = evaluateExpression(expression.left, context);
      const right = evaluateExpression(expression.right, context);
      return left && right;
    }
    case "or": {
      const left = evaluateExpression(expression.left, context);
      const right = evaluateExpression(expression.right, context);
      return left || right;
    }
  }
}

function evaluateValue(
  value: ConditionValueNode,
  context: TemplateContext,
): unknown {
  if (value.type === "literal") {
    return value.value;
  }

  try {
    return resolveReference(value.reference, context);
  } catch (error) {
    if (!(error instanceof ReferenceResolutionError)) {
      throw error;
    }

    switch (error.code) {
      case "invalid_reference":
        throw new ConditionEvaluationError(
          `invalid condition reference "${value.reference}"`,
          { cause: error },
        );
      case "unknown_namespace":
        throw new ConditionEvaluationError(
          `unknown condition namespace "${error.namespace ?? ""}"`,
          { cause: error },
        );
      case "forbidden_segment":
        throw new ConditionEvaluationError(
          `invalid condition reference "${value.reference}": path segment ` +
            `"${error.segment ?? ""}" is not allowed`,
          { cause: error },
        );
      case "not_found":
        throw new ConditionEvaluationError(
          `condition reference "${value.reference}" was not found`,
          { cause: error },
        );
    }
  }
}
