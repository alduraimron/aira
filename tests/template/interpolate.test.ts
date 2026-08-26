import { describe, expect, test } from "bun:test";

import type { TemplateContext } from "../../src/context/types";
import {
  interpolateTemplate,
  TemplateInterpolationError,
} from "../../src/template/interpolate";

const context: TemplateContext = {
  input: {
    task: "Implement JWT authentication",
    attempts: 0,
    enabled: false,
    optional: null,
    details: {
      owner: "platform",
      approved: true,
    },
    files: ["src/auth.ts", "tests/auth.test.ts"],
  },
  config: {
    commands: {
      test: "bun test",
    },
  },
  artifacts: {
    discovery: "Repository architecture\n\n- API in `src/api`\n- Tests in `tests`",
    plan: "Approved implementation plan",
  },
  steps: {
    verify: {
      status: "completed",
      success: false,
      exit_code: 1,
      output: "2 tests failed",
    },
  },
  run: {
    id: "run-123",
  },
};

function getInterpolationError(
  template: string,
  targetContext: TemplateContext = context,
): TemplateInterpolationError {
  try {
    interpolateTemplate(template, targetContext);
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateInterpolationError);
    return error as TemplateInterpolationError;
  }

  throw new Error("expected template interpolation to fail");
}

describe("template interpolation", () => {
  test("returns a plain string unchanged", () => {
    const template = "No template variables here.";
    expect(interpolateTemplate(template, context)).toBe(template);
  });

  test("replaces one string value", () => {
    expect(interpolateTemplate("{{ input.task }}", context)).toBe(
      "Implement JWT authentication",
    );
  });

  test("replaces multiple references", () => {
    expect(
      interpolateTemplate(
        "Task: {{ input.task }}\nCommand: {{ config.commands.test }}",
        context,
      ),
    ).toBe("Task: Implement JWT authentication\nCommand: bun test");
  });

  test("replaces a repeated reference", () => {
    expect(
      interpolateTemplate("{{ run.id }} then {{ run.id }}", context),
    ).toBe("run-123 then run-123");
  });

  test("allows whitespace inside template braces", () => {
    expect(
      interpolateTemplate(
        "{{input.task}}|{{ input.task }}|{{   input.task   }}",
        context,
      ),
    ).toBe(
      "Implement JWT authentication|Implement JWT authentication|Implement JWT authentication",
    );
  });

  test("converts a number using its normal string form", () => {
    expect(interpolateTemplate("Attempts: {{ input.attempts }}", context)).toBe(
      "Attempts: 0",
    );
  });

  test("converts a boolean to true or false", () => {
    expect(interpolateTemplate("Enabled: {{ input.enabled }}", context)).toBe(
      "Enabled: false",
    );
  });

  test("converts null to the text null", () => {
    expect(interpolateTemplate("Value: {{ input.optional }}", context)).toBe(
      "Value: null",
    );
  });

  test("serializes an object as pretty JSON", () => {
    expect(interpolateTemplate("{{ input.details }}", context)).toBe(`{
  "owner": "platform",
  "approved": true
}`);
  });

  test("serializes an array as pretty JSON", () => {
    expect(interpolateTemplate("{{ input.files }}", context)).toBe(`[
  "src/auth.ts",
  "tests/auth.test.ts"
]`);
  });

  test("inserts multiline artifact content without changing it", () => {
    expect(
      interpolateTemplate("Discovery:\n\n{{ artifacts.discovery }}", context),
    ).toBe(
      "Discovery:\n\nRepository architecture\n\n- API in `src/api`\n- Tests in `tests`",
    );
  });

  test("preserves existing Markdown formatting", () => {
    const template = `# Plan

- Task: **{{ input.task }}**
- Test command: \`{{ config.commands.test }}\`

> Keep this quote.`;

    expect(interpolateTemplate(template, context)).toBe(`# Plan

- Task: **Implement JWT authentication**
- Test command: \`bun test\`

> Keep this quote.`);
  });

  test("interpolates references embedded in larger text", () => {
    expect(
      interpolateTemplate(
        "Run {{ run.id }} failed with: {{ steps.verify.output }}.",
        context,
      ),
    ).toBe("Run run-123 failed with: 2 tests failed.");
  });

  test("rejects a missing reference", () => {
    const error = getInterpolationError("{{ artifacts.missing }}");
    expect(error.message).toContain(
      'template reference "artifacts.missing" was not found',
    );
  });

  test("rejects an unknown namespace", () => {
    const error = getInterpolationError("{{ foo }}");
    expect(error.message).toContain('unknown template namespace "foo"');
  });

  test.each(["{{ }}", "{{   }}"])(
    "rejects empty template expression %p",
    (template) => {
      const error = getInterpolationError(template);
      expect(error.message).toContain("template expression must not be empty");
    },
  );

  test.each([
    '{{ input.task || "fallback" }}',
    "{{ foo() }}",
    '{{ steps["verify"].output }}',
  ])("rejects unsupported template expression %p", (template) => {
    const error = getInterpolationError(template);
    expect(error.message).toContain("invalid template reference");
  });

  test("rejects an unmatched opening delimiter", () => {
    const error = getInterpolationError("Hello {{ input.task");
    expect(error.message).toContain("unmatched opening template delimiter");
  });

  test("rejects an unmatched closing delimiter", () => {
    const error = getInterpolationError("Hello input.task }}");
    expect(error.message).toContain("unmatched closing template delimiter");
  });

  test("rejects a multiline template reference", () => {
    const error = getInterpolationError(`{{ input.task
input.task }}`);
    expect(error.message).toContain(
      "template references must not span multiple lines",
    );
  });

  test("rejects an own undefined value instead of inserting an empty string", () => {
    const error = getInterpolationError("{{ input.unset }}", {
      ...context,
      input: { unset: undefined },
    });

    expect(error.message).toContain(
      'template reference "input.unset" was not found',
    );
  });
});
