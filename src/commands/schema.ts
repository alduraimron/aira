import { z } from "zod";

import type { CommandMetadata } from "./types";

export const COMMAND_IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]*$/;

function nonEmptyString(label: string) {
  return z.string().refine((value) => value.trim().length > 0, {
    message: `${label} must not be empty`,
  });
}

const modelAliasSchema = z.string().regex(COMMAND_IDENTIFIER_PATTERN, {
  message: `model alias must match ${COMMAND_IDENTIFIER_PATTERN.source}`,
});

const toolNameSchema = nonEmptyString("tool name").regex(
  COMMAND_IDENTIFIER_PATTERN,
  {
    message: `tool name must match ${COMMAND_IDENTIFIER_PATTERN.source}`,
  },
);

const toolsSchema = z.array(toolNameSchema).superRefine((tools, context) => {
  const firstIndexes = new Map<string, number>();

  for (const [index, tool] of tools.entries()) {
    const firstIndex = firstIndexes.get(tool);

    if (firstIndex !== undefined) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: `duplicate tool name "${tool}"; first used at tools[${firstIndex}]`,
      });
    } else {
      firstIndexes.set(tool, index);
    }
  }
});

export const commandMetadataSchema: z.ZodType<CommandMetadata> =
  z.strictObject({
    description: nonEmptyString("description").optional(),
    model: modelAliasSchema.optional(),
    thinking: nonEmptyString("thinking").optional(),
    timeout: z.number().int().positive().optional(),
    retry: z.number().int().nonnegative().optional(),
    tools: toolsSchema.optional(),
  });
