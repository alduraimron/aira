import type { Workflow, WorkflowStep } from "./types";

/** Returns steps in declaration order, including loop children. */
export function flattenWorkflowSteps(workflow: Workflow): WorkflowStep[] {
  const flattened: WorkflowStep[] = [];

  const visit = (steps: readonly WorkflowStep[]) => {
    for (const step of steps) {
      flattened.push(step);

      if (step.uses === "loop") {
        visit(step.steps);
      }
    }
  };

  visit(workflow.steps);
  return flattened;
}

export function flattenWorkflowStepIds(workflow: Workflow): string[] {
  return flattenWorkflowSteps(workflow).map((step) => step.id);
}

export function findWorkflowStep(
  workflow: Workflow,
  stepId: string,
): WorkflowStep | undefined {
  return flattenWorkflowSteps(workflow).find((step) => step.id === stepId);
}
