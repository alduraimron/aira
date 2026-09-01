import type { ExecutionEventListener } from "../executor/events";
import { sanitizeDisplayText } from "../observability/display";
import type { CliIO } from "./io";

export interface ExecutionReporter {
  emit: ExecutionEventListener;
}

export function createCliExecutionReporter(io: CliIO): ExecutionReporter {
  const activeSteps = new Set<string>();
  const waitingApprovals = new Set<string>();
  const shownModels = new Map<string, string>();

  const startStep = (
    stepId: string,
    stepType: string,
    model?: string,
  ): void => {
    for (const waitingStepId of waitingApprovals) {
      if (waitingStepId !== stepId) {
        waitingApprovals.delete(waitingStepId);
        activeSteps.delete(waitingStepId);
        shownModels.delete(waitingStepId);
      }
    }

    if (!activeSteps.has(stepId)) {
      activeSteps.add(stepId);
      io.writeOut(`${stepType === "approval" ? "◆" : "●"} ${inline(stepId)}\n`);
    }

    if (model !== undefined && shownModels.get(stepId) !== model) {
      shownModels.set(stepId, model);
      io.writeOut(`  model ${inline(model)}\n`);
    }
  };

  const finishStep = (stepId: string): void => {
    activeSteps.delete(stepId);
    waitingApprovals.delete(stepId);
    shownModels.delete(stepId);
  };

  const emit: ExecutionEventListener = (event) => {
    switch (event.type) {
      case "step.started":
        startStep(event.stepId, event.stepType, event.model);
        return;
      case "step.completed":
        io.writeOut(
          `✓ ${inline(event.stepId)}${formatOptionalDuration(event.durationMs)}\n`,
        );
        finishStep(event.stepId);
        return;
      case "step.failed":
        io.writeOut(
          `✗ ${inline(event.stepId)}${formatOptionalDuration(event.durationMs)}\n`,
        );
        finishStep(event.stepId);
        return;
      case "step.skipped":
        io.writeOut(`○ ${inline(event.stepId)} skipped\n`);
        finishStep(event.stepId);
        return;
      case "step.waiting":
        io.writeOut(
          `  ${inline(event.message ?? "waiting for intervention")}\n`,
        );
        return;
      case "step.retry":
        io.writeOut(
          `  ↻ retry ${event.attempt}/${event.maxAttempts}\n`,
        );
        return;
      case "loop.iteration.started":
        io.writeOut(
          `  ↻ iteration ${event.attempt}/${event.maxAttempts}\n`,
        );
        return;
      case "agent.started":
        if (
          event.model !== undefined &&
          shownModels.get(event.stepId) !== event.model
        ) {
          shownModels.set(event.stepId, event.model);
          io.writeOut(`  model ${inline(event.model)}\n`);
        }
        return;
      case "agent.tool.started":
        io.writeOut(`  → ${inline(event.summary ?? event.tool)}\n`);
        return;
      case "agent.tool.completed":
        if (!event.success) {
          io.writeOut(`  ✗ ${inline(event.tool)} failed\n`);
        }
        return;
      case "agent.retry": {
        const count =
          event.attempt === undefined
            ? ""
            : event.maxAttempts === undefined
              ? ` ${event.attempt}`
              : ` ${event.attempt}/${event.maxAttempts}`;
        io.writeOut(`  ↻ agent retry${count}\n`);
        return;
      }
      case "artifact.written":
        io.writeOut(`  → artifact ${inline(event.artifact)}\n`);
        return;
      case "shell.started":
        io.writeOut(`  $ ${inline(event.command, 220)}\n`);
        return;
      case "shell.completed":
        if (!event.success) {
          io.writeOut(
            `  ✗ command failed${
              event.exitCode === undefined ? "" : ` (exit ${event.exitCode})`
            }\n`,
          );
        }
        return;
      case "approval.waiting":
        startStep(event.stepId, "approval");
        if (!waitingApprovals.has(event.stepId)) {
          waitingApprovals.add(event.stepId);
          io.writeOut("  waiting for approval\n");
        }
        return;
    }
  };

  return { emit };
}

export function formatDuration(durationMs: number): string {
  const milliseconds = Math.max(0, durationMs);

  if (milliseconds < 1_000) {
    return `${Math.round(milliseconds)}ms`;
  }

  if (milliseconds < 60_000) {
    const seconds = milliseconds / 1_000;
    const rendered = seconds < 10 ? seconds.toFixed(1) : seconds.toFixed(0);
    return `${rendered.replace(/\.0$/, "")}s`;
  }

  const totalSeconds = Math.round(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function formatOptionalDuration(durationMs: number | undefined): string {
  return durationMs === undefined ? "" : ` ${formatDuration(durationMs)}`;
}

function inline(value: string, maxLength = 180): string {
  return sanitizeDisplayText(value, maxLength);
}
