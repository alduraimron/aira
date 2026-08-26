import { describe, expect, test } from "bun:test";

import {
  ConditionEvaluationError,
  evaluateCondition,
} from "../../src/conditions";
import type { TemplateContext } from "../../src/context/types";

const context: TemplateContext = {
  input: {
    mode: "1",
    force: false,
    zero: 0,
    optional: null,
    threshold: 3.14,
    path: "src\\auth.ts",
  },
  config: {
    features: {
      "auth-enabled": true,
    },
  },
  artifacts: {
    review: "approved",
  },
  steps: {
    verify: {
      success: false,
      exit_code: 1,
      output: "2 tests failed",
    },
    test: {
      success: true,
    },
    lint: {
      success: true,
    },
    a: {
      success: true,
    },
    b: {
      success: false,
    },
    c: {
      success: false,
    },
    review: {
      result: "approved",
      note: 'say "yes"',
      optional: null,
    },
  },
  run: {
    id: "run-123",
  },
};

function getConditionError(
  expression: string,
  targetContext: TemplateContext = context,
): ConditionEvaluationError {
  try {
    evaluateCondition(expression, targetContext);
  } catch (error) {
    expect(error).toBeInstanceOf(ConditionEvaluationError);
    return error as ConditionEvaluationError;
  }

  throw new Error("expected condition evaluation to fail");
}

describe("condition evaluation", () => {
  test("evaluates boolean equality", () => {
    expect(evaluateCondition("steps.verify.success == false", context)).toBe(
      true,
    );
  });

  test("evaluates boolean inequality", () => {
    expect(evaluateCondition("steps.verify.success != true", context)).toBe(
      true,
    );
  });

  test("evaluates numeric equality", () => {
    expect(evaluateCondition("steps.verify.exit_code == 1", context)).toBe(
      true,
    );
    expect(evaluateCondition("input.threshold == 3.14", context)).toBe(true);
  });

  test("evaluates numeric inequality", () => {
    expect(evaluateCondition("steps.verify.exit_code != 0", context)).toBe(
      true,
    );
  });

  test("evaluates double-quoted string equality", () => {
    expect(
      evaluateCondition('steps.review.result == "approved"', context),
    ).toBe(true);
  });

  test("evaluates single-quoted string equality", () => {
    expect(
      evaluateCondition("steps.review.result == 'approved'", context),
    ).toBe(true);
  });

  test("supports escaped quotes and backslashes in strings", () => {
    expect(
      evaluateCondition('steps.review.note == "say \\"yes\\""', context),
    ).toBe(true);
    expect(
      evaluateCondition("input.path == 'src\\\\auth.ts'", context),
    ).toBe(true);
  });

  test("evaluates null equality", () => {
    expect(evaluateCondition("steps.review.optional == null", context)).toBe(
      true,
    );
  });

  test("evaluates and expressions", () => {
    expect(
      evaluateCondition(
        "steps.test.success == true and steps.lint.success == true",
        context,
      ),
    ).toBe(true);
  });

  test("evaluates or expressions", () => {
    expect(
      evaluateCondition(
        "steps.verify.success == true or steps.test.success == true",
        context,
      ),
    ).toBe(true);
  });

  test("applies not to a complete comparison", () => {
    expect(
      evaluateCondition("not steps.verify.success == true", context),
    ).toBe(true);
  });

  test("gives and higher precedence than or", () => {
    expect(
      evaluateCondition(
        "steps.a.success == true or steps.b.success == true and steps.c.success == true",
        context,
      ),
    ).toBe(true);
  });

  test("evaluates comparisons before boolean operators", () => {
    expect(
      evaluateCondition(
        "steps.test.success == true and steps.verify.exit_code != 0",
        context,
      ),
    ).toBe(true);
  });

  test("resolves multiple nested reference paths", () => {
    expect(
      evaluateCondition(
        "config.features.auth-enabled == true and steps.review.result == artifacts.review",
        context,
      ),
    ).toBe(true);
  });

  test.each([
    ["steps.verify.success == false", true],
    ["input.zero == 0", true],
    ["input.optional == null", true],
  ])("resolves false, zero, and null in %p", (expression, expected) => {
    expect(evaluateCondition(expression, context)).toBe(expected);
  });

  test("does not coerce strings, numbers, or booleans", () => {
    expect(evaluateCondition('"1" == 1', context)).toBe(false);
    expect(evaluateCondition("true == 1", context)).toBe(false);
    expect(evaluateCondition('input.mode == 1', context)).toBe(false);
  });

  test("uses Object.is semantics for numeric equality", () => {
    expect(evaluateCondition("-0 == 0", context)).toBe(false);
    expect(evaluateCondition("-0 != 0", context)).toBe(true);
  });

  test.each(["", "   \t\n"])("rejects empty expression %p", (expression) => {
    const error = getConditionError(expression);
    expect(error.message).toContain("condition expression must not be empty");
  });

  test("rejects a bare reference", () => {
    const error = getConditionError("steps.verify.success");
    expect(error.message).toContain("must be used in an explicit comparison");
  });

  test("rejects a comparison with a missing right-hand value", () => {
    const error = getConditionError("steps.verify.success ==");
    expect(error.message).toContain("expected a condition value");
  });

  test("rejects a comparison with a missing left-hand value", () => {
    const error = getConditionError("== true");
    expect(error.message).toContain(
      'expected a condition value but found "=="',
    );
  });

  test.each([">", "<", ">=", "<="])(
    "rejects unsupported comparison operator %p",
    (operator) => {
      const error = getConditionError(
        `steps.verify.exit_code ${operator} 0`,
      );
      expect(error.message).toContain(`unsupported operator "${operator}"`);
    },
  );

  test.each(["+", "*", "/"])(
    "rejects unsupported arithmetic operator %p",
    (operator) => {
      const error = getConditionError(`1 ${operator} 1 == 2`);
      expect(error.message).toContain(`unsupported operator "${operator}"`);
    },
  );

  test("rejects parentheses", () => {
    const error = getConditionError(
      "(steps.verify.success == true or input.force == true)",
    );
    expect(error.message).toContain("parentheses are not supported");
  });

  test("rejects a missing reference", () => {
    const error = getConditionError("steps.missing.success == true");
    expect(error.message).toContain(
      'condition reference "steps.missing.success" was not found',
    );
  });

  test("checks references in every boolean branch", () => {
    const error = getConditionError(
      "true == true or steps.missing.success == true",
    );
    expect(error.message).toContain(
      'condition reference "steps.missing.success" was not found',
    );
  });

  test("rejects an unknown namespace", () => {
    const error = getConditionError("unknown.value == true");
    expect(error.message).toContain('unknown condition namespace "unknown"');
  });

  test.each([
    'steps.review.result == "approved',
    "steps.review.result == 'approved",
  ])("rejects unterminated quoted string %p", (expression) => {
    const error = getConditionError(expression);
    expect(error.message).toContain("unterminated quoted string");
  });

  test("rejects an invalid token", () => {
    const error = getConditionError("steps.verify.success == @");
    expect(error.message).toContain('invalid token "@"');
  });

  test.each([
    "steps.test.success == true and or steps.lint.success == true",
    "steps.test.success == true or",
    "and steps.test.success == true",
  ])("rejects malformed boolean chain %p", (expression) => {
    expect(() => evaluateCondition(expression, context)).toThrow(
      ConditionEvaluationError,
    );
  });

  test("rejects a truthy string as a boolean expression", () => {
    const error = getConditionError(
      '"approved" and steps.test.success == true',
    );
    expect(error.message).toContain("must be used in an explicit comparison");
  });

  test("rejects not applied to a bare reference", () => {
    const error = getConditionError("not steps.verify.success");
    expect(error.message).toContain("must be used in an explicit comparison");
  });

  test.each(["===" , "!=="])(
    "rejects unsupported equality operator %p",
    (operator) => {
      const error = getConditionError(`input.zero ${operator} 0`);
      expect(error.message).toContain(`unsupported operator "${operator}"`);
    },
  );
});
