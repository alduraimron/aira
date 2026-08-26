import { z } from "zod";

import type {
  AgentArtifact,
  ShellCommand,
  ShellStep,
  Workflow,
  WorkflowInput,
  WorkflowStep,
} from "./types";

function nonEmptyString(label: string) {
  return z.string().refine((value) => value.trim().length > 0, {
    message: `${label} must not be empty`,
  });
}

export const workflowInputSchema: z.ZodType<WorkflowInput> = z.strictObject({
  required: z.boolean(),
});

export const agentArtifactSchema: z.ZodType<AgentArtifact> = z.strictObject({
  name: z.string(),
  filename: z.string(),
  versioned: z.boolean().default(false),
});

export const agentStepSchema = z.strictObject({
  id: z.string(),
  uses: z.literal("agent"),
  command: nonEmptyString("agent command"),
  model: z.string().optional(),
  thinking: z.string().optional(),
  timeout: z.number().int().positive().optional(),
  retry: z.number().int().nonnegative().optional(),
  tools: z.array(z.string()).optional(),
  context: z.record(z.string(), z.string()).optional(),
  artifact: agentArtifactSchema.optional(),
  when: nonEmptyString("when condition").optional(),
});

export const shellCommandSchema: z.ZodType<ShellCommand> = z.strictObject({
  name: nonEmptyString("shell command name"),
  run: nonEmptyString("shell command"),
});

const rawShellStepSchema = z
  .strictObject({
    id: z.string(),
    uses: z.literal("shell"),
    run: nonEmptyString("shell run command").optional(),
    commands: z.array(shellCommandSchema).min(1, "commands must not be empty").optional(),
    timeout: z.number().int().positive().optional(),
    when: nonEmptyString("when condition").optional(),
  })
  .superRefine((step, context) => {
    const hasRun = step.run !== undefined;
    const hasCommands = step.commands !== undefined;

    if (hasRun === hasCommands) {
      context.addIssue({
        code: "custom",
        message: 'shell step must define exactly one of "run" or "commands"',
      });
    }
  });

export const shellStepSchema = rawShellStepSchema.transform(
  (step): ShellStep => step as ShellStep,
);

export const approvalStepSchema = z.strictObject({
  id: z.string(),
  uses: z.literal("approval"),
  artifact: z.string().optional(),
  message: z.string().optional(),
  revise: z.string().optional(),
  when: nonEmptyString("when condition").optional(),
});

export const workflowStepSchema: z.ZodType<WorkflowStep> = z.lazy(() => {
  const loopStepSchema = z.strictObject({
    id: z.string(),
    uses: z.literal("loop"),
    max_attempts: z.number().int().positive(),
    until: nonEmptyString("until condition"),
    steps: z.array(workflowStepSchema).min(1, "loop steps must not be empty"),
    when: nonEmptyString("when condition").optional(),
  });

  return z
    .discriminatedUnion("uses", [
      agentStepSchema,
      rawShellStepSchema,
      approvalStepSchema,
      loopStepSchema,
    ])
    .transform((step): WorkflowStep => step as WorkflowStep);
});

export const workflowSchema: z.ZodType<Workflow> = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
  inputs: z.record(z.string(), workflowInputSchema).optional(),
  steps: z.array(workflowStepSchema).min(1, "workflow steps must not be empty"),
});
