import type { RunView } from "../core";
import type { StepStatus } from "../run";

export function formatRunStatus(view: RunView): string {
  const lines = [
    `Run:       ${view.runId}`,
    `Workflow:  ${view.workflow}`,
    `Status:    ${view.status}`,
    `Current:   ${view.currentStep?.id ?? "-"}`,
    `Started:   ${view.startedAt}`,
    `Updated:   ${view.updatedAt}`,
    "",
    "Steps:",
  ];
  const width = Math.max(0, ...view.steps.map((step) => step.id.length));

  for (const step of view.steps) {
    lines.push(
      `  ${statusSymbol(step.status)} ${step.id.padEnd(width)}  ` +
        `${step.status.padEnd(11)} attempt ${step.attempt}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function statusSymbol(status: StepStatus): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "running":
      return "[*]";
    case "waiting":
      return "[>]";
    case "failed":
    case "interrupted":
      return "[!]";
    case "skipped":
      return "[-]";
    case "pending":
      return "[ ]";
  }
}
