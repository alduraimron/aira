import { describe, expect, test } from "bun:test";

import { workflowSchema } from "../../src/workflow/schema";
import type { Workflow } from "../../src/workflow/types";

const minimalWorkflow: Workflow = {
  name: "feature",
  steps: [
    {
      id: "plan",
      uses: "agent",
      command: "plan",
    },
  ],
};

describe("workflow schema", () => {
  test("accepts a minimal workflow with one agent step", () => {
    expect(workflowSchema.parse(minimalWorkflow)).toEqual(minimalWorkflow);
  });

  test("accepts agent metadata and defaults artifact versioned to false", () => {
    const workflow = workflowSchema.parse({
      name: "feature",
      description: "Implement a feature",
      inputs: {
        task: { required: true },
      },
      steps: [
        {
          id: "plan",
          uses: "agent",
          command: "plan",
          model: "model-name",
          thinking: "high",
          timeout: 30,
          retry: 0,
          tools: ["read", "write"],
          context: { task: "{{ input.task }}" },
          when: "steps.discover.success == true",
          artifact: {
            name: "plan",
            filename: "plan.md",
          },
        },
      ],
    });

    expect(workflow.steps[0]).toMatchObject({
      model: "model-name",
      thinking: "high",
      timeout: 30,
      retry: 0,
      tools: ["read", "write"],
      context: { task: "{{ input.task }}" },
      artifact: {
        name: "plan",
        filename: "plan.md",
        versioned: false,
      },
    });
  });

  test("accepts a versioned artifact", () => {
    const workflow = workflowSchema.parse({
      name: "feature",
      steps: [
        {
          id: "plan",
          uses: "agent",
          command: "plan",
          artifact: {
            name: "plan",
            filename: "plan.md",
            versioned: true,
          },
        },
      ],
    });

    expect(workflow.steps[0]).toMatchObject({
      artifact: { versioned: true },
    });
  });

  test("accepts a shell step with one run command", () => {
    expect(
      workflowSchema.safeParse({
        name: "checks",
        steps: [{ id: "test", uses: "shell", run: "bun test" }],
      }).success,
    ).toBe(true);
  });

  test("accepts a shell step with named commands", () => {
    expect(
      workflowSchema.safeParse({
        name: "checks",
        steps: [
          {
            id: "verify",
            uses: "shell",
            commands: [
              { name: "test", run: "bun test" },
              { name: "lint", run: "bun run lint" },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  test("rejects a shell step with both run and commands", () => {
    expect(
      workflowSchema.safeParse({
        name: "checks",
        steps: [
          {
            id: "verify",
            uses: "shell",
            run: "bun test",
            commands: [{ name: "test", run: "bun test" }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects a shell step with neither run nor commands", () => {
    expect(
      workflowSchema.safeParse({
        name: "checks",
        steps: [{ id: "verify", uses: "shell" }],
      }).success,
    ).toBe(false);
  });

  test("rejects an empty top-level steps list", () => {
    expect(workflowSchema.safeParse({ name: "empty", steps: [] }).success).toBe(
      false,
    );
  });

  test("rejects an empty loop steps list", () => {
    expect(
      workflowSchema.safeParse({
        name: "checks",
        steps: [
          {
            id: "cycle",
            uses: "loop",
            max_attempts: 2,
            until: "steps.test.success == true",
            steps: [],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test.each([0, -1])("rejects max_attempts value %p", (maxAttempts) => {
    expect(
      workflowSchema.safeParse({
        name: "checks",
        steps: [
          {
            id: "cycle",
            uses: "loop",
            max_attempts: maxAttempts,
            until: "steps.test.success == true",
            steps: [{ id: "test", uses: "shell", run: "bun test" }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects a non-positive timeout", () => {
    expect(
      workflowSchema.safeParse({
        name: "feature",
        steps: [{ id: "plan", uses: "agent", command: "plan", timeout: 0 }],
      }).success,
    ).toBe(false);
  });

  test("rejects a negative retry count", () => {
    expect(
      workflowSchema.safeParse({
        name: "feature",
        steps: [{ id: "plan", uses: "agent", command: "plan", retry: -1 }],
      }).success,
    ).toBe(false);
  });

  test("rejects whitespace-only conditions", () => {
    expect(
      workflowSchema.safeParse({
        name: "feature",
        steps: [{ id: "plan", uses: "agent", command: "plan", when: "  " }],
      }).success,
    ).toBe(false);
  });
});
