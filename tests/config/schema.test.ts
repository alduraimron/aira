import { describe, expect, test } from "bun:test";

import { configSchema } from "../../src/config/schema";
import type { AiraConfig } from "../../src/config/types";

const fullConfig: AiraConfig = {
  models: {
    cheap: "openai/gpt-5-mini",
    smart: "anthropic/claude-sonnet",
    coding: "anthropic/claude-sonnet",
  },
  defaults: {
    model: "coding",
    agent_timeout: 900,
    shell_timeout: 300,
    technical_retries: 1,
  },
  commands: {
    test: "bun test",
    lint: "bun run lint",
    typecheck: "bun run typecheck",
    build: "bun run build",
  },
};

describe("config schema", () => {
  test("accepts an empty config", () => {
    expect(configSchema.parse({})).toEqual({});
  });

  test("accepts multiple model aliases", () => {
    expect(
      configSchema.parse({
        models: {
          cheap: "openai/gpt-5-mini",
          smart: "anthropic/claude-sonnet",
        },
      }),
    ).toEqual({
      models: {
        cheap: "openai/gpt-5-mini",
        smart: "anthropic/claude-sonnet",
      },
    });
  });

  test("accepts defaults with zero technical retries", () => {
    expect(
      configSchema.parse({
        defaults: {
          agent_timeout: 900,
          shell_timeout: 300,
          technical_retries: 0,
        },
      }),
    ).toEqual({
      defaults: {
        agent_timeout: 900,
        shell_timeout: 300,
        technical_retries: 0,
      },
    });
  });

  test("accepts project shell command aliases", () => {
    expect(
      configSchema.parse({
        commands: {
          test: "bun test",
          typecheck: "bun run typecheck",
        },
      }),
    ).toEqual({
      commands: {
        test: "bun test",
        typecheck: "bun run typecheck",
      },
    });
  });

  test("accepts a full config", () => {
    expect(configSchema.parse(fullConfig)).toEqual(fullConfig);
  });

  test.each([
    { models: { cheap: "openai/gpt-5-mini" } },
    { defaults: { technical_retries: 1 } },
    { commands: { test: "bun test" } },
  ])("accepts config with other optional sections missing", (config) => {
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  test("rejects an unknown top-level property", () => {
    expect(configSchema.safeParse({ unexpected: true }).success).toBe(false);
  });

  test("rejects an unknown defaults property", () => {
    expect(
      configSchema.safeParse({ defaults: { retries: 1 } }).success,
    ).toBe(false);
  });

  test.each(["Smart", "my_model"])("rejects model alias %p", (alias) => {
    expect(
      configSchema.safeParse({ models: { [alias]: "provider/model" } })
        .success,
    ).toBe(false);
  });

  test("rejects an empty model value", () => {
    expect(
      configSchema.safeParse({ models: { smart: "  " } }).success,
    ).toBe(false);
  });

  test.each(["Test", "type_check"])("rejects command alias %p", (alias) => {
    expect(
      configSchema.safeParse({ commands: { [alias]: "bun test" } })
        .success,
    ).toBe(false);
  });

  test("rejects an empty command value", () => {
    expect(
      configSchema.safeParse({ commands: { test: "\t" } }).success,
    ).toBe(false);
  });

  test.each([0, -1, 1.5])("rejects agent_timeout value %p", (timeout) => {
    expect(
      configSchema.safeParse({ defaults: { agent_timeout: timeout } }).success,
    ).toBe(false);
  });

  test.each([0, -1, 1.5])("rejects shell_timeout value %p", (timeout) => {
    expect(
      configSchema.safeParse({ defaults: { shell_timeout: timeout } }).success,
    ).toBe(false);
  });

  test.each([-1, 1.5])("rejects technical_retries value %p", (retries) => {
    expect(
      configSchema.safeParse({ defaults: { technical_retries: retries } })
        .success,
    ).toBe(false);
  });
});
