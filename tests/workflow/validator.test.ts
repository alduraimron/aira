import { describe, expect, test } from "bun:test";

import { workflowSchema } from "../../src/workflow/schema";
import type { Workflow } from "../../src/workflow/types";
import {
  validateWorkflow,
  WorkflowValidationError,
} from "../../src/workflow/validator";

function validateDocument(document: unknown): Workflow {
  return validateWorkflow(workflowSchema.parse(document));
}

function getValidationError(document: unknown): WorkflowValidationError {
  try {
    validateDocument(document);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowValidationError);
    return error as WorkflowValidationError;
  }

  throw new Error("expected workflow validation to fail");
}

describe("semantic workflow validation", () => {
  test("accepts an approval that references an agent and its artifact", () => {
    expect(() =>
      validateDocument({
        name: "feature",
        steps: [
          {
            id: "plan",
            uses: "agent",
            command: "plan",
            artifact: {
              name: "plan",
              filename: "reports/plan.md",
              versioned: true,
            },
          },
          {
            id: "approve-plan",
            uses: "approval",
            artifact: "plan",
            revise: "plan",
            message: "Approve the plan?",
          },
        ],
      }),
    ).not.toThrow();
  });

  test("accepts a loop containing shell and agent steps", () => {
    expect(() =>
      validateDocument({
        name: "verify",
        steps: [
          {
            id: "verify-cycle",
            uses: "loop",
            max_attempts: 3,
            until: "steps.verify.success == true",
            steps: [
              {
                id: "verify",
                uses: "shell",
                commands: [
                  { name: "test", run: "{{ config.commands.test }}" },
                  { name: "typecheck", run: "{{ config.commands.typecheck }}" },
                ],
              },
              {
                id: "repair",
                uses: "agent",
                command: "repair",
                when: "steps.verify.success == false",
              },
            ],
          },
        ],
      }),
    ).not.toThrow();
  });

  test("rejects duplicate top-level step IDs", () => {
    const error = getValidationError({
      name: "checks",
      steps: [
        { id: "test", uses: "shell", run: "bun test" },
        { id: "test", uses: "agent", command: "repair" },
      ],
    });

    expect(error.message).toContain('duplicate step ID "test"');
  });

  test("rejects a duplicate ID shared by a top-level and loop child step", () => {
    const error = getValidationError({
      name: "checks",
      steps: [
        { id: "test", uses: "shell", run: "bun test" },
        {
          id: "cycle",
          uses: "loop",
          max_attempts: 2,
          until: "steps.test.success == true",
          steps: [{ id: "test", uses: "agent", command: "repair" }],
        },
      ],
    });

    expect(error.message).toContain('duplicate step ID "test"');
    expect(error.message).toContain("steps[1].steps[0]");
  });

  test("rejects a nested loop", () => {
    const error = getValidationError({
      name: "checks",
      steps: [
        {
          id: "outer",
          uses: "loop",
          max_attempts: 2,
          until: "steps.inner.success == true",
          steps: [
            {
              id: "inner",
              uses: "loop",
              max_attempts: 2,
              until: "steps.test.success == true",
              steps: [{ id: "test", uses: "shell", run: "bun test" }],
            },
          ],
        },
      ],
    });

    expect(error.message).toContain("nested loops are not allowed");
    expect(error.message).toContain('loop "outer"');
  });

  test("rejects approval revise references to a missing step", () => {
    const error = getValidationError({
      name: "feature",
      steps: [
        {
          id: "approve-plan",
          uses: "approval",
          revise: "plan",
        },
      ],
    });

    expect(error.message).toContain('revise references missing step "plan"');
  });

  test("rejects approval revise references to a non-agent step", () => {
    const error = getValidationError({
      name: "feature",
      steps: [
        { id: "test", uses: "shell", run: "bun test" },
        { id: "approve", uses: "approval", revise: "test" },
      ],
    });

    expect(error.message).toContain("revise must reference an agent step");
    expect(error.message).toContain('"test" uses "shell"');
  });

  test("rejects approval references to a missing artifact", () => {
    const error = getValidationError({
      name: "feature",
      steps: [
        { id: "plan", uses: "agent", command: "plan" },
        { id: "approve", uses: "approval", artifact: "plan" },
      ],
    });

    expect(error.message).toContain(
      'artifact references missing agent artifact "plan"',
    );
  });

  test("rejects duplicate artifact names", () => {
    const error = getValidationError({
      name: "feature",
      steps: [
        {
          id: "first-plan",
          uses: "agent",
          command: "plan",
          artifact: { name: "plan", filename: "first.md" },
        },
        {
          id: "second-plan",
          uses: "agent",
          command: "plan",
          artifact: { name: "plan", filename: "second.md" },
        },
      ],
    });

    expect(error.message).toContain('duplicate artifact name "plan"');
    expect(error.message).toContain('step "first-plan"');
  });

  test("rejects duplicate shell command names", () => {
    const error = getValidationError({
      name: "checks",
      steps: [
        {
          id: "verify",
          uses: "shell",
          commands: [
            { name: "test", run: "bun test" },
            { name: "test", run: "bun test --watch=false" },
          ],
        },
      ],
    });

    expect(error.message).toContain('duplicate shell command name "test"');
    expect(error.message).toContain('step "verify"');
  });

  test("rejects an invalid workflow name", () => {
    const error = getValidationError({
      name: "Feature Plan",
      steps: [{ id: "plan", uses: "agent", command: "plan" }],
    });

    expect(error.message).toContain('workflow name "Feature Plan" must match');
  });

  test.each(["Approve", "_plan", "verify step", "foo.bar"])(
    "rejects invalid step ID %p",
    (id) => {
      const error = getValidationError({
        name: "feature",
        steps: [{ id, uses: "agent", command: "plan" }],
      });

      expect(error.message).toContain(`step ID "${id}" must match`);
    },
  );

  test("rejects an invalid artifact name", () => {
    const error = getValidationError({
      name: "feature",
      steps: [
        {
          id: "plan",
          uses: "agent",
          command: "plan",
          artifact: { name: "Plan.File", filename: "plan.md" },
        },
      ],
    });

    expect(error.message).toContain('artifact name "Plan.File" must match');
  });

  test.each(["/var/tmp/plan.md", "C:\\temp\\plan.md"])(
    "rejects absolute artifact filename %p",
    (filename) => {
      const error = getValidationError({
        name: "feature",
        steps: [
          {
            id: "plan",
            uses: "agent",
            command: "plan",
            artifact: { name: "plan", filename },
          },
        ],
      });

      expect(error.message).toContain("must be a relative path");
    },
  );

  test.each(["../plan.md", "foo/../../bar.md", "foo\\..\\bar.md"])(
    "rejects artifact path traversal %p",
    (filename) => {
      const error = getValidationError({
        name: "feature",
        steps: [
          {
            id: "plan",
            uses: "agent",
            command: "plan",
            artifact: { name: "plan", filename },
          },
        ],
      });

      expect(error.message).toContain('must not contain ".." path segments');
    },
  );

  test("semantic validation also rejects an empty workflow steps list", () => {
    const workflow = { name: "empty", steps: [] } as Workflow;

    expect(() => validateWorkflow(workflow)).toThrow("workflow steps must not be empty");
  });

  test("semantic validation also rejects an empty loop steps list", () => {
    const workflow = {
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
    } as Workflow;

    expect(() => validateWorkflow(workflow)).toThrow("loop steps must not be empty");
  });
});
