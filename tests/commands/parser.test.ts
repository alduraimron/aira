import { describe, expect, test } from "bun:test";

import {
  CommandValidationError,
  parseCommandMarkdown,
} from "../../src/commands/parser";

const filePath = "/project/.aira/commands/plan.md";

function getParseError(source: string): CommandValidationError {
  try {
    parseCommandMarkdown(source, filePath);
  } catch (error) {
    expect(error).toBeInstanceOf(CommandValidationError);
    return error as CommandValidationError;
  }

  throw new Error("expected command parsing to fail");
}

describe("command Markdown parser", () => {
  test("parses a command without frontmatter", () => {
    const source =
      "Inspect the repository carefully.\n\nTask:\n\n{{ input.task }}\n";

    expect(parseCommandMarkdown(source, filePath)).toEqual({
      metadata: {},
      prompt: "Inspect the repository carefully.\n\nTask:\n\n{{ input.task }}",
    });
  });

  test("parses full frontmatter metadata", () => {
    const source = `---
description: Create a grounded implementation plan
model: smart
thinking: high
timeout: 900
retry: 0
tools:
  - read
  - grep
  - find
  - ls
  - custom-tool
---

Create the plan.
`;

    expect(parseCommandMarkdown(source, filePath)).toEqual({
      metadata: {
        description: "Create a grounded implementation plan",
        model: "smart",
        thinking: "high",
        timeout: 900,
        retry: 0,
        tools: ["read", "grep", "find", "ls", "custom-tool"],
      },
      prompt: "Create the plan.",
    });
  });

  test("preserves template variables without interpolation", () => {
    const source = `---
model: smart
---

Task:

{{ input.task }}

Discovery:

{{ artifacts.discovery }}

Verification:

{{ steps.verify.output }}
`;

    const command = parseCommandMarkdown(source, filePath);

    expect(command.prompt).toContain("{{ input.task }}");
    expect(command.prompt).toContain("{{ artifacts.discovery }}");
    expect(command.prompt).toContain("{{ steps.verify.output }}");
  });

  test("preserves multiline prompt formatting", () => {
    const source = `---
description: Review a plan
---

First paragraph.

  Indented instruction

- one
- two
`;

    expect(parseCommandMarkdown(source, filePath).prompt).toBe(
      "First paragraph.\n\n  Indented instruction\n\n- one\n- two",
    );
  });

  test("accepts empty frontmatter as empty metadata", () => {
    expect(
      parseCommandMarkdown("---\n---\nPrompt text.\n", filePath),
    ).toEqual({
      metadata: {},
      prompt: "Prompt text.",
    });
  });

  test("rejects a non-object frontmatter document", () => {
    const error = getParseError("---\nnull\n---\nPrompt text.\n");

    expect(error.message).toContain(filePath);
    expect(error.message).toContain("metadata");
    expect(error.message).toContain("expected object");
  });

  test.each(["", " \n\t\n"])("rejects empty prompt %p", (source) => {
    const error = getParseError(source);

    expect(error.message).toContain(filePath);
    expect(error.message).toContain("prompt");
    expect(error.message).toContain("must not be empty");
  });

  test("rejects malformed frontmatter YAML", () => {
    const error = getParseError(`---
description: [unterminated
---
Prompt.
`);

    expect(error.message).toContain(filePath);
    expect(error.message).toContain("frontmatter");
    expect(error.message).toContain("YAML syntax error");
  });

  test("rejects unclosed frontmatter", () => {
    const error = getParseError(`---
description: Never closed
Prompt.
`);

    expect(error.message).toContain(filePath);
    expect(error.message).toContain("frontmatter");
    expect(error.message).toContain("not closed");
  });

  test("reports unknown metadata with its path", () => {
    const error = getParseError(`---
unexpected: true
---
Prompt.
`);

    expect(error.message).toContain(filePath);
    expect(error.message).toContain("metadata.unexpected");
  });

  test("reports invalid metadata with its path", () => {
    const error = getParseError(`---
timeout: 0
---
Prompt.
`);

    expect(error.message).toContain(filePath);
    expect(error.message).toContain("metadata.timeout");
  });
});
