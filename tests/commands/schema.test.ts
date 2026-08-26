import { describe, expect, test } from "bun:test";

import { commandMetadataSchema } from "../../src/commands/schema";

const fullMetadata = {
  description: "Create a grounded implementation plan",
  model: "smart",
  thinking: "high",
  timeout: 900,
  retry: 0,
  tools: ["read", "grep", "find", "ls", "custom-tool"],
};

describe("command metadata schema", () => {
  test("accepts empty metadata", () => {
    expect(commandMetadataSchema.parse({})).toEqual({});
  });

  test("accepts all supported metadata including zero retry and multiple tools", () => {
    expect(commandMetadataSchema.parse(fullMetadata)).toEqual(fullMetadata);
  });

  test("rejects an unknown metadata field", () => {
    expect(
      commandMetadataSchema.safeParse({ unexpected: true }).success,
    ).toBe(false);
  });

  test.each(["", "  "])("rejects empty description %p", (description) => {
    expect(commandMetadataSchema.safeParse({ description }).success).toBe(
      false,
    );
  });

  test.each(["Smart", "my_model", "provider/model"])(
    "rejects model alias %p",
    (model) => {
      expect(commandMetadataSchema.safeParse({ model }).success).toBe(false);
    },
  );

  test.each(["", "\t"])("rejects empty thinking %p", (thinking) => {
    expect(commandMetadataSchema.safeParse({ thinking }).success).toBe(false);
  });

  test.each([0, -1, 1.5])("rejects timeout value %p", (timeout) => {
    expect(commandMetadataSchema.safeParse({ timeout }).success).toBe(false);
  });

  test.each([-1, 1.5])("rejects retry value %p", (retry) => {
    expect(commandMetadataSchema.safeParse({ retry }).success).toBe(false);
  });

  test.each(["", "  "])("rejects empty tool name %p", (tool) => {
    expect(commandMetadataSchema.safeParse({ tools: [tool] }).success).toBe(
      false,
    );
  });

  test.each(["Read", "file_name", "provider/tool"])(
    "rejects tool identifier %p",
    (tool) => {
      expect(commandMetadataSchema.safeParse({ tools: [tool] }).success).toBe(
        false,
      );
    },
  );

  test("rejects duplicate tools", () => {
    const result = commandMetadataSchema.safeParse({
      tools: ["read", "grep", "read"],
    });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["tools", 2]);
      expect(result.error.issues[0]?.message).toContain(
        'duplicate tool name "read"',
      );
    }
  });
});
