import { z } from "zod";

import type { AiraConfig, AiraConfigDefaults } from "./types";

export const CONFIG_ALIAS_PATTERN = /^[a-z][a-z0-9-]*$/;

function nonEmptyString(label: string) {
  return z.string().refine((value) => value.trim().length > 0, {
    message: `${label} must not be empty`,
  });
}

export const configAliasSchema = z.string().regex(CONFIG_ALIAS_PATTERN, {
  message: `alias must match ${CONFIG_ALIAS_PATTERN.source}`,
});

export const configDefaultsSchema: z.ZodType<AiraConfigDefaults> =
  z.strictObject({
    model: configAliasSchema.optional(),
    agent_timeout: z.number().int().positive().optional(),
    shell_timeout: z.number().int().positive().optional(),
    technical_retries: z.number().int().nonnegative().optional(),
  });

export const configSchema: z.ZodType<AiraConfig> = z.strictObject({
  models: z
    .record(configAliasSchema, nonEmptyString("model value"))
    .optional(),
  defaults: configDefaultsSchema.optional(),
  commands: z
    .record(configAliasSchema, nonEmptyString("command value"))
    .optional(),
});
