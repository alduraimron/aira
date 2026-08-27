import { describe, expect, test } from "bun:test";

import type { AgentCommand } from "../../src/commands";
import type { AiraConfig } from "../../src/config";
import {
  DEFAULT_AIRA_AGENT_TIMEOUT_SECONDS,
  resolveAgentStepConfiguration,
} from "../../src/executor";
import { ExecutionError } from "../../src/executor";
import type { AgentStep } from "../../src/workflow";

function step(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    id: "plan",
    uses: "agent",
    command: "plan",
    ...overrides,
  };
}

function command(
  metadata: AgentCommand["metadata"] = {},
): AgentCommand {
  return {
    name: "plan",
    filePath: "/commands/plan.md",
    prompt: "Plan the work.",
    metadata,
  };
}

const modelConfig: AiraConfig = {
  models: {
    step: "provider/step-model",
    command: "provider/command-model",
    default: "provider/default-model",
  },
  defaults: { model: "default" },
};

describe("agent configuration resolution", () => {
  test.each([
    ["step", step({ model: "step" }), command({ model: "command" }), modelConfig, "provider/step-model"],
    ["command", step(), command({ model: "command" }), modelConfig, "provider/command-model"],
    ["config", step(), command(), modelConfig, "provider/default-model"],
    ["undefined", step(), command(), {}, undefined],
  ] as const)(
    "resolves model from %s precedence and maps the alias",
    (_name, agentStep, agentCommand, config, expected) => {
      expect(
        resolveAgentStepConfiguration(agentStep, agentCommand, config).model,
      ).toBe(expected);
    },
  );

  test("fails an unknown selected model alias", () => {
    expect(() =>
      resolveAgentStepConfiguration(
        step({ model: "missing" }),
        command({ model: "command" }),
        modelConfig,
      ),
    ).toThrow(ExecutionError);

    try {
      resolveAgentStepConfiguration(
        step({ model: "missing" }),
        command(),
        modelConfig,
      );
    } catch (error) {
      expect((error as Error).message).toContain(
        'unknown model alias "missing"',
      );
    }
  });

  test.each([
    ["step", step({ thinking: "high" }), command({ thinking: "low" }), "high"],
    ["command", step(), command({ thinking: "low" }), "low"],
    ["undefined", step(), command(), undefined],
  ] as const)(
    "resolves thinking from %s precedence",
    (_name, agentStep, agentCommand, expected) => {
      expect(
        resolveAgentStepConfiguration(agentStep, agentCommand, {}).thinking,
      ).toBe(expected);
    },
  );

  test.each([
    ["step", step({ timeout: 10 }), command({ timeout: 20 }), { defaults: { agent_timeout: 30 } }, 10],
    ["command", step(), command({ timeout: 20 }), { defaults: { agent_timeout: 30 } }, 20],
    ["config", step(), command(), { defaults: { agent_timeout: 30 } }, 30],
    ["internal", step(), command(), {}, DEFAULT_AIRA_AGENT_TIMEOUT_SECONDS],
  ] as const)(
    "resolves timeout from %s precedence",
    (_name, agentStep, agentCommand, config, expected) => {
      expect(
        resolveAgentStepConfiguration(agentStep, agentCommand, config)
          .timeoutSeconds,
      ).toBe(expected);
    },
  );

  test.each([
    ["step", step({ retry: 2 }), command({ retry: 1 }), { defaults: { technical_retries: 0 } }, 2],
    ["command", step(), command({ retry: 1 }), { defaults: { technical_retries: 0 } }, 1],
    ["config", step(), command(), { defaults: { technical_retries: 3 } }, 3],
    ["explicit zero", step({ retry: 0 }), command({ retry: 4 }), { defaults: { technical_retries: 5 } }, 0],
    ["internal", step(), command(), {}, 1],
  ] as const)(
    "resolves technical retries from %s precedence",
    (_name, agentStep, agentCommand, config, expected) => {
      expect(
        resolveAgentStepConfiguration(agentStep, agentCommand, config)
          .technicalRetries,
      ).toBe(expected);
    },
  );

  test.each([
    [
      "step",
      step({ tools: ["read", "bash"] }),
      command({ tools: ["read", "write"] }),
      ["read", "bash", "complete_step"],
    ],
    [
      "command",
      step(),
      command({ tools: ["read", "edit", "write"] }),
      ["read", "edit", "write", "complete_step"],
    ],
    [
      "safe default",
      step(),
      command(),
      ["read", "grep", "find", "ls", "complete_step"],
    ],
    ["explicit empty", step({ tools: [] }), command(), ["complete_step"]],
  ] as const)(
    "resolves tools from %s precedence",
    (_name, agentStep, agentCommand, expected) => {
      expect(
        resolveAgentStepConfiguration(agentStep, agentCommand, {}).tools,
      ).toEqual([...expected]);
    },
  );

  test("rejects complete_step in workflow or command tool metadata", () => {
    expect(() =>
      resolveAgentStepConfiguration(
        step({ tools: ["complete_step"] }),
        command(),
        {},
      ),
    ).toThrow('reserved Aira tool "complete_step"');

    expect(() =>
      resolveAgentStepConfiguration(
        step({ tools: ["read"] }),
        command({ tools: ["complete_step"] }),
        {},
      ),
    ).toThrow('reserved Aira tool "complete_step"');
  });
});
