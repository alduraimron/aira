import type { RunPreview, RunPreviewStep } from "../core";
import type { CliIO } from "./io";

export function printDryRunPlan(preview: RunPreview, io: CliIO): void {
  io.writeOut(
    `Workflow: ${preview.workflow.name}\n` +
      `Task: ${preview.task}\n\n` +
      "Steps:\n",
  );

  for (const [index, step] of preview.steps.entries()) {
    io.writeOut(`  ${index + 1}. ${formatStep(step)}\n`);

    if (step.type === "loop") {
      printLoopChildren(step.steps ?? [], io, "     ");
    }
  }
}

function printLoopChildren(
  steps: readonly RunPreviewStep[],
  io: CliIO,
  indentation: string,
): void {
  for (const step of steps) {
    io.writeOut(`${indentation}- ${formatStep(step)}\n`);

    if (step.type === "loop") {
      printLoopChildren(step.steps ?? [], io, `${indentation}  `);
    }
  }
}

function formatStep(step: RunPreviewStep): string {
  switch (step.type) {
    case "agent": {
      const details = [
        `command=${step.command ?? "unknown"}`,
        ...(step.agent?.model === undefined
          ? []
          : [`model=${step.agent.model}`]),
        ...(step.agent === undefined
          ? []
          : [
              `timeout=${step.agent.timeoutSeconds}s`,
              `retry=${step.agent.technicalRetries}`,
            ]),
      ];
      return `${step.id}  agent  ${details.join(" ")}`;
    }
    case "shell":
      return `${step.id}  shell`;
    case "approval":
      return (
        `${step.id}  approval` +
        (step.approvalArtifact === undefined
          ? ""
          : `  artifact=${step.approvalArtifact}`)
      );
    case "loop":
      return `${step.id}  loop  max_attempts=${step.maxAttempts ?? "unknown"}`;
  }
}
