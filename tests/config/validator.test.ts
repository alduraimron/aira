import { describe, expect, test } from "bun:test";

import { configSchema } from "../../src/config/schema";
import {
  ConfigValidationError,
  validateConfig,
} from "../../src/config/validator";

function validateDocument(document: unknown) {
  return validateConfig(configSchema.parse(document));
}

describe("semantic config validation", () => {
  test("accepts a default model that references a configured alias", () => {
    expect(
      validateDocument({
        models: { smart: "anthropic/claude-sonnet" },
        defaults: { model: "smart" },
      }),
    ).toEqual({
      models: { smart: "anthropic/claude-sonnet" },
      defaults: { model: "smart" },
    });
  });

  test("accepts config without a default model", () => {
    expect(validateDocument({ defaults: { agent_timeout: 900 } })).toEqual({
      defaults: { agent_timeout: 900 },
    });
  });

  test("rejects a default model with no matching alias", () => {
    expect(() =>
      validateDocument({ defaults: { model: "smart" } }),
    ).toThrow(ConfigValidationError);

    try {
      validateDocument({ defaults: { model: "smart" } });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as Error).message).toContain("config.defaults.model");
      expect((error as Error).message).toContain(
        'model alias "smart" is not defined in config.models',
      );
    }
  });
});
