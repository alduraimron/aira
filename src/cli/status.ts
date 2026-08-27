import type { RunState, StepStatus } from "../run";

export function formatRunStatus(state: RunState): string {
  const lines = [
    `Run:       ${state.id}`,
    `Workflow:  ${state.workflow}`,
    `Status:    ${state.status}`,
    `Current:   ${state.current_step ?? "-"}`,
    `Started:   ${state.started_at}`,
    `Updated:   ${state.updated_at}`,
    "",
    "Steps:",
  ];
  const width = Math.max(0, ...Object.keys(state.steps).map((id) => id.length));

  for (const [stepId, step] of Object.entries(state.steps)) {
    lines.push(
      `  ${statusSymbol(step.status)} ${stepId.padEnd(width)}  ` +
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
      return "[!]";
    case "interrupted":
      return "[!]";
    case "skipped":
      return "[-]";
    case "pending":
      return "[ ]";
  }
}
