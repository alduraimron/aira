import { describe, expect, test } from "bun:test";

import {
  ReferenceResolutionError,
  resolveReference,
} from "../../src/context/reference";
import type { TemplateContext } from "../../src/context/types";

const context: TemplateContext = {
  input: {
    task: "Implement JWT authentication",
    enabled: false,
    attempts: 0,
    optional: null,
  },
  config: {
    commands: {
      test: "bun test",
    },
    "feature-enabled": true,
  },
  artifacts: {
    plan: "Approved plan",
  },
  steps: {
    verify: {
      output: "2 tests failed",
    },
  },
  run: {
    id: "run-123",
  },
};

function getResolutionError(
  reference: string,
  targetContext: TemplateContext = context,
): ReferenceResolutionError {
  try {
    resolveReference(reference, targetContext);
  } catch (error) {
    expect(error).toBeInstanceOf(ReferenceResolutionError);
    return error as ReferenceResolutionError;
  }

  throw new Error("expected reference resolution to fail");
}

describe("template context reference resolution", () => {
  test.each([
    ["input.task", "Implement JWT authentication"],
    ["config.commands.test", "bun test"],
    ["artifacts.plan", "Approved plan"],
    ["steps.verify.output", "2 tests failed"],
    ["run.id", "run-123"],
    ["config.feature-enabled", true],
    ["input.enabled", false],
    ["input.attempts", 0],
    ["input.optional", null],
  ])("resolves %s", (reference, expected) => {
    expect(resolveReference(reference, context)).toEqual(expected);
  });

  test("resolves own properties on records without a prototype", () => {
    const input = Object.create(null) as Record<string, unknown>;
    input.task = "Prototype-free value";

    expect(resolveReference("input.task", { ...context, input })).toBe(
      "Prototype-free value",
    );
  });

  test("rejects an unknown root namespace", () => {
    const error = getResolutionError("unknown.value");

    expect(error.code).toBe("unknown_namespace");
    expect(error.message).toContain('unknown reference namespace "unknown"');
  });

  test("rejects a missing nested property", () => {
    const error = getResolutionError("config.commands.lint");

    expect(error.code).toBe("not_found");
    expect(error.message).toContain(
      'reference "config.commands.lint" was not found',
    );
  });

  test.each(["input/task", ".input.task", "input.task."])(
    "rejects malformed dot path %p",
    (reference) => {
      const error = getResolutionError(reference);
      expect(error.code).toBe("invalid_reference");
    },
  );

  test("rejects an empty path segment", () => {
    const error = getResolutionError("input..task");
    expect(error.message).toContain('invalid reference "input..task"');
  });

  test("does not read inherited properties", () => {
    const input = Object.create({ inherited: "secret" }) as Record<
      string,
      unknown
    >;
    input.task = "own value";

    const error = getResolutionError("input.inherited", {
      ...context,
      input,
    });

    expect(error.code).toBe("not_found");
  });

  test.each(["__proto__", "constructor", "prototype"])(
    "rejects forbidden path segment %p",
    (segment) => {
      const input = {
        [segment]: "must not be read",
      };
      const error = getResolutionError(`input.${segment}`, {
        ...context,
        input,
      });

      expect(error.code).toBe("forbidden_segment");
      expect(error.message).toContain(`path segment "${segment}" is not allowed`);
    },
  );

  test("rejects unsupported bracket notation", () => {
    const error = getResolutionError('steps["verify"].output');
    expect(error.code).toBe("invalid_reference");
  });

  test("treats an own undefined value as missing", () => {
    const error = getResolutionError("input.unset", {
      ...context,
      input: { unset: undefined },
    });

    expect(error.code).toBe("not_found");
  });

  test("rejects the optional run namespace when it is absent", () => {
    const { run: _run, ...contextWithoutRun } = context;
    const error = getResolutionError("run.id", contextWithoutRun);

    expect(error.code).toBe("not_found");
  });
});
