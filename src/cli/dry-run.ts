import type { WorkflowPreflightResult } from "../executor";
import type { Workflow, WorkflowStep } from "../workflow";
import type { CliIO } from "./io";

export function printDryRunPlan(params: {
  workflow: Workflow;
  task: string;
  preflight: WorkflowPreflightResult;
  io: CliIO;
}): void {
  params.io.writeOut(
    `Workflow: ${params.workflow.name}\n` +
      `Task: ${params.task}\n\n` +
      "Steps:\n",
  );

  for (const [index, step] of params.workflow.steps.entries()) {
    params.io.writeOut(
      `  ${index + 1}. ${formatStep(step, params.preflight)}\n`,
    );

    if (step.uses === "loop") {
      printLoopChildren(step.steps, params.preflight, params.io, "     ");
    }
  }
}

function printLoopChildren(
  steps: readonly WorkflowStep[],
  preflight: WorkflowPreflightResult,
  io: CliIO,
  indentation: string,
): void {
  for (const step of steps) {
    io.writeOut(`${indentation}- ${formatStep(step, preflight)}\n`);

    if (step.uses === "loop") {
      printLoopChildren(step.steps, preflight, io, `${indentation}  `);
    }
  }
}

function formatStep(
  step: WorkflowStep,
  preflight: WorkflowPreflightResult,
): string {
  switch (step.uses) {
    case "agent": {
      const prepared = preflight.agentSteps.get(step.id);
      const configuration = prepared?.configuration;
      const details = [
        `command=${step.command}`,
        ...(configuration?.model === undefined
          ? []
          : [`model=${configuration.model}`]),
        ...(configuration === undefined
          ? []
          : [
              `timeout=${configuration.timeoutSeconds}s`,
              `retry=${configuration.technicalRetries}`,
            ]),
      ];
      return `${step.id}  agent  ${details.join(" ")}`;
    }
    case "shell":
      return `${step.id}  shell`;
    case "approval":
      return (
        `${step.id}  approval` +
        (step.artifact === undefined ? "" : `  artifact=${step.artifact}`)
      );
    case "loop":
      return `${step.id}  loop  max_attempts=${step.max_attempts}`;
  }
}
