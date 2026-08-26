import type { ConditionToken } from "./tokenizer";
import { tokenizeCondition } from "./tokenizer";
import {
  ConditionEvaluationError,
  type ConditionComparisonOperator,
  type ConditionExpressionNode,
  type ConditionValueNode,
} from "./types";

export function parseCondition(expression: string): ConditionExpressionNode {
  const parser = new ConditionParser(tokenizeCondition(expression));
  return parser.parse();
}

class ConditionParser {
  private cursor = 0;

  constructor(private readonly tokens: readonly ConditionToken[]) {}

  parse(): ConditionExpressionNode {
    if (this.peek().type === "eof") {
      throw new ConditionEvaluationError("condition expression must not be empty");
    }

    const expression = this.parseOrExpression();
    const trailingToken = this.peek();

    if (trailingToken.type !== "eof") {
      throw new ConditionEvaluationError(
        `unexpected token ${formatToken(trailingToken)}`,
      );
    }

    return expression;
  }

  private parseOrExpression(): ConditionExpressionNode {
    let expression = this.parseAndExpression();

    while (this.match("or")) {
      expression = {
        type: "or",
        left: expression,
        right: this.parseAndExpression(),
      };
    }

    return expression;
  }

  private parseAndExpression(): ConditionExpressionNode {
    let expression = this.parseUnaryExpression();

    while (this.match("and")) {
      expression = {
        type: "and",
        left: expression,
        right: this.parseUnaryExpression(),
      };
    }

    return expression;
  }

  private parseUnaryExpression(): ConditionExpressionNode {
    if (this.match("not")) {
      return {
        type: "not",
        operand: this.parseUnaryExpression(),
      };
    }

    return this.parseComparison();
  }

  private parseComparison(): ConditionExpressionNode {
    const leftToken = this.peek();
    const left = this.parseValue();
    const operator = this.parseComparisonOperator();

    if (operator === undefined) {
      throw new ConditionEvaluationError(
        `condition value ${formatToken(leftToken)} must be used in an explicit ` +
          'comparison with "==" or "!="',
      );
    }

    const right = this.parseValue();

    return {
      type: "comparison",
      operator,
      left,
      right,
    };
  }

  private parseValue(): ConditionValueNode {
    const token = this.peek();

    switch (token.type) {
      case "reference":
        this.advance();
        return { type: "reference", reference: token.value };
      case "string":
      case "number":
      case "boolean":
      case "null":
        this.advance();
        return { type: "literal", value: token.value };
      default:
        throw new ConditionEvaluationError(
          token.type === "eof"
            ? "expected a condition value at the end of the expression"
            : `expected a condition value but found ${formatToken(token)}`,
        );
    }
  }

  private parseComparisonOperator():
    | ConditionComparisonOperator
    | undefined {
    if (this.match("equal")) {
      return "==";
    }

    if (this.match("not_equal")) {
      return "!=";
    }

    return undefined;
  }

  private match(type: ConditionToken["type"]): boolean {
    if (this.peek().type !== type) {
      return false;
    }

    this.advance();
    return true;
  }

  private advance(): ConditionToken {
    const token = this.peek();

    if (token.type !== "eof") {
      this.cursor += 1;
    }

    return token;
  }

  private peek(): ConditionToken {
    const token = this.tokens[this.cursor];

    if (token === undefined) {
      throw new ConditionEvaluationError("malformed condition expression");
    }

    return token;
  }
}

function formatToken(token: ConditionToken): string {
  return token.type === "eof" ? "at the end of the expression" : `"${token.lexeme}"`;
}
