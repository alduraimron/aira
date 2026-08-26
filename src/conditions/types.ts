export type ConditionComparisonOperator = "==" | "!=";

export type ConditionValueNode =
  | {
      readonly type: "reference";
      readonly reference: string;
    }
  | {
      readonly type: "literal";
      readonly value: string | number | boolean | null;
    };

export type ConditionExpressionNode =
  | {
      readonly type: "comparison";
      readonly operator: ConditionComparisonOperator;
      readonly left: ConditionValueNode;
      readonly right: ConditionValueNode;
    }
  | {
      readonly type: "not";
      readonly operand: ConditionExpressionNode;
    }
  | {
      readonly type: "and" | "or";
      readonly left: ConditionExpressionNode;
      readonly right: ConditionExpressionNode;
    };

export class ConditionEvaluationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConditionEvaluationError";
  }
}
