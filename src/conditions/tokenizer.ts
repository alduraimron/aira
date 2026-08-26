import { ConditionEvaluationError } from "./types";

type TokenBase = {
  readonly lexeme: string;
  readonly position: number;
};

export type ConditionToken =
  | (TokenBase & {
      readonly type: "reference";
      readonly value: string;
    })
  | (TokenBase & {
      readonly type: "string";
      readonly value: string;
    })
  | (TokenBase & {
      readonly type: "number";
      readonly value: number;
    })
  | (TokenBase & {
      readonly type: "boolean";
      readonly value: boolean;
    })
  | (TokenBase & {
      readonly type: "null";
      readonly value: null;
    })
  | (TokenBase & {
      readonly type: "equal" | "not_equal" | "and" | "or" | "not" | "eof";
    });

export function tokenizeCondition(expression: string): ConditionToken[] {
  const tokens: ConditionToken[] = [];
  let cursor = 0;

  while (cursor < expression.length) {
    const character = expression.charAt(cursor);

    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }

    if (character === '"' || character === "'") {
      const token = readString(expression, cursor, character);
      tokens.push(token.token);
      cursor = token.nextPosition;
      continue;
    }

    if (
      isDigit(character) ||
      (character === "-" && isDigit(expression.charAt(cursor + 1)))
    ) {
      const token = readNumber(expression, cursor);
      tokens.push(token.token);
      cursor = token.nextPosition;
      continue;
    }

    if (isIdentifierStart(character)) {
      const token = readWord(expression, cursor);
      tokens.push(token.token);
      cursor = token.nextPosition;
      continue;
    }

    if (isOperatorCharacter(character)) {
      const token = readOperator(expression, cursor);

      if (token.lexeme === "==") {
        tokens.push({
          type: "equal",
          lexeme: token.lexeme,
          position: cursor,
        });
        cursor = token.nextPosition;
        continue;
      }

      if (token.lexeme === "!=") {
        tokens.push({
          type: "not_equal",
          lexeme: token.lexeme,
          position: cursor,
        });
        cursor = token.nextPosition;
        continue;
      }

      throw new ConditionEvaluationError(
        `unsupported operator "${token.lexeme}" at character ${cursor}`,
      );
    }

    if (character === "(" || character === ")") {
      throw new ConditionEvaluationError(
        `parentheses are not supported at character ${cursor}`,
      );
    }

    if ("+*/%&|".includes(character) || character === "-") {
      throw new ConditionEvaluationError(
        `unsupported operator "${character}" at character ${cursor}`,
      );
    }

    throw new ConditionEvaluationError(
      `invalid token "${character}" at character ${cursor}`,
    );
  }

  tokens.push({
    type: "eof",
    lexeme: "",
    position: expression.length,
  });

  return tokens;
}

interface ReadTokenResult {
  token: ConditionToken;
  nextPosition: number;
}

function readString(
  expression: string,
  start: number,
  quote: '"' | "'",
): ReadTokenResult {
  let cursor = start + 1;
  let value = "";

  while (cursor < expression.length) {
    const character = expression.charAt(cursor);

    if (character === quote) {
      const nextPosition = cursor + 1;
      return {
        token: {
          type: "string",
          lexeme: expression.slice(start, nextPosition),
          position: start,
          value,
        },
        nextPosition,
      };
    }

    if (character === "\r" || character === "\n") {
      break;
    }

    if (character === "\\") {
      const escaped = expression.charAt(cursor + 1);

      if (escaped === "") {
        break;
      }

      if (escaped !== "\\" && escaped !== '"' && escaped !== "'") {
        throw new ConditionEvaluationError(
          `unsupported escape sequence "\\${escaped}" in string literal ` +
            `at character ${cursor}`,
        );
      }

      value += escaped;
      cursor += 2;
      continue;
    }

    value += character;
    cursor += 1;
  }

  throw new ConditionEvaluationError(
    `unterminated quoted string at character ${start}`,
  );
}

function readNumber(expression: string, start: number): ReadTokenResult {
  let cursor = start;

  if (expression.charAt(cursor) === "-") {
    cursor += 1;
  }

  while (isDigit(expression.charAt(cursor))) {
    cursor += 1;
  }

  if (expression.charAt(cursor) === ".") {
    cursor += 1;
    const fractionStart = cursor;

    while (isDigit(expression.charAt(cursor))) {
      cursor += 1;
    }

    if (cursor === fractionStart) {
      const invalidLiteral = expression.slice(start, cursor);
      throw new ConditionEvaluationError(
        `invalid number literal "${invalidLiteral}" at character ${start}`,
      );
    }
  }

  const lexeme = expression.slice(start, cursor);
  const value = Number(lexeme);

  if (!Number.isFinite(value)) {
    throw new ConditionEvaluationError(
      `invalid number literal "${lexeme}" at character ${start}`,
    );
  }

  return {
    token: {
      type: "number",
      lexeme,
      position: start,
      value,
    },
    nextPosition: cursor,
  };
}

function readWord(expression: string, start: number): ReadTokenResult {
  let cursor = start + 1;

  while (isReferenceCharacter(expression.charAt(cursor))) {
    cursor += 1;
  }

  const lexeme = expression.slice(start, cursor);
  const base = { lexeme, position: start };

  switch (lexeme) {
    case "and":
    case "or":
    case "not":
      return {
        token: { ...base, type: lexeme },
        nextPosition: cursor,
      };
    case "true":
      return {
        token: { ...base, type: "boolean", value: true },
        nextPosition: cursor,
      };
    case "false":
      return {
        token: { ...base, type: "boolean", value: false },
        nextPosition: cursor,
      };
    case "null":
      return {
        token: { ...base, type: "null", value: null },
        nextPosition: cursor,
      };
    default:
      return {
        token: { ...base, type: "reference", value: lexeme },
        nextPosition: cursor,
      };
  }
}

function readOperator(
  expression: string,
  start: number,
): { lexeme: string; nextPosition: number } {
  let cursor = start + 1;

  while (isOperatorCharacter(expression.charAt(cursor))) {
    cursor += 1;
  }

  return {
    lexeme: expression.slice(start, cursor),
    nextPosition: cursor,
  };
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isIdentifierStart(character: string): boolean {
  return /[a-zA-Z_]/.test(character);
}

function isReferenceCharacter(character: string): boolean {
  return /[a-zA-Z0-9_.-]/.test(character);
}

function isOperatorCharacter(character: string): boolean {
  return character === "=" || character === "!" || character === ">" || character === "<";
}
