import path from "node:path";

import type { AgentStep, Workflow, WorkflowStep } from "./types";

export const WORKFLOW_IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface WorkflowValidationIssue {
  message: string;
  path?: string;
  stepId?: string;
}

export class WorkflowValidationError extends Error {
  readonly filePath?: string;
  readonly issues: readonly WorkflowValidationIssue[];

  constructor(
    issues: readonly WorkflowValidationIssue[],
    filePath?: string,
    options?: ErrorOptions,
  ) {
    const heading = filePath
      ? `Workflow validation failed for "${filePath}"`
      : "Workflow validation failed";
    const details = issues.map(formatIssue).map((issue) => `- ${issue}`);

    super(`${heading}:\n${details.join("\n")}`, options);
    this.name = "WorkflowValidationError";
    this.filePath = filePath;
    this.issues = issues;
  }
}

interface LocatedStep {
  path: string;
  step: WorkflowStep;
}

interface LocatedArtifact {
  path: string;
  step: AgentStep;
}

export function validateWorkflow(workflow: Workflow, filePath?: string): Workflow {
  const issues: WorkflowValidationIssue[] = [];
  const stepsById = new Map<string, LocatedStep>();
  const artifactsByName = new Map<string, LocatedArtifact>();

  const addIssue = (issue: WorkflowValidationIssue) => {
    issues.push(issue);
  };

  if (!WORKFLOW_IDENTIFIER_PATTERN.test(workflow.name)) {
    addIssue({
      path: "name",
      message:
        `workflow name "${workflow.name}" must match ` +
        WORKFLOW_IDENTIFIER_PATTERN.source,
    });
  }

  if (workflow.steps.length === 0) {
    addIssue({
      path: "steps",
      message: "workflow steps must not be empty",
    });
  }

  const visitSteps = (
    steps: WorkflowStep[],
    pathPrefix: string,
    parentLoopId?: string,
  ) => {
    for (const [index, step] of steps.entries()) {
      const stepPath = `${pathPrefix}[${index}]`;
      const firstStep = stepsById.get(step.id);

      if (!WORKFLOW_IDENTIFIER_PATTERN.test(step.id)) {
        addIssue({
          path: `${stepPath}.id`,
          stepId: step.id,
          message: `step ID "${step.id}" must match ${WORKFLOW_IDENTIFIER_PATTERN.source}`,
        });
      }

      if (firstStep) {
        addIssue({
          path: `${stepPath}.id`,
          stepId: step.id,
          message: `duplicate step ID "${step.id}"; first used at ${firstStep.path}`,
        });
      } else {
        stepsById.set(step.id, { path: stepPath, step });
      }

      if (step.uses === "agent" && step.artifact) {
        const artifactPath = `${stepPath}.artifact`;
        const artifactName = step.artifact.name;
        const firstArtifact = artifactsByName.get(artifactName);

        if (!WORKFLOW_IDENTIFIER_PATTERN.test(artifactName)) {
          addIssue({
            path: `${artifactPath}.name`,
            stepId: step.id,
            message:
              `artifact name "${artifactName}" must match ` +
              WORKFLOW_IDENTIFIER_PATTERN.source,
          });
        }

        const filenameProblem = getFilenameProblem(step.artifact.filename);
        if (filenameProblem) {
          addIssue({
            path: `${artifactPath}.filename`,
            stepId: step.id,
            message: `artifact filename "${step.artifact.filename}" ${filenameProblem}`,
          });
        }

        if (firstArtifact) {
          addIssue({
            path: `${artifactPath}.name`,
            stepId: step.id,
            message:
              `duplicate artifact name "${artifactName}"; first produced by ` +
              `step "${firstArtifact.step.id}" at ${firstArtifact.path}`,
          });
        } else {
          artifactsByName.set(artifactName, {
            path: artifactPath,
            step,
          });
        }
      }

      if (step.uses === "shell") {
        const hasRun = step.run !== undefined;
        const hasCommands = step.commands !== undefined;

        if (hasRun === hasCommands) {
          addIssue({
            path: stepPath,
            stepId: step.id,
            message: 'shell step must define exactly one of "run" or "commands"',
          });
        }

        if (step.commands) {
          const commandIndexes = new Map<string, number>();

          for (const [commandIndex, command] of step.commands.entries()) {
            const firstIndex = commandIndexes.get(command.name);

            if (firstIndex !== undefined) {
              addIssue({
                path: `${stepPath}.commands[${commandIndex}].name`,
                stepId: step.id,
                message:
                  `duplicate shell command name "${command.name}"; first used at ` +
                  `${stepPath}.commands[${firstIndex}]`,
              });
            } else {
              commandIndexes.set(command.name, commandIndex);
            }
          }
        }
      }

      if (step.uses === "loop") {
        if (parentLoopId !== undefined) {
          addIssue({
            path: stepPath,
            stepId: step.id,
            message:
              `nested loops are not allowed; loop "${step.id}" is inside ` +
              `loop "${parentLoopId}"`,
          });
        }

        if (step.steps.length === 0) {
          addIssue({
            path: `${stepPath}.steps`,
            stepId: step.id,
            message: "loop steps must not be empty",
          });
        }

        visitSteps(step.steps, `${stepPath}.steps`, step.id);
      }
    }
  };

  visitSteps(workflow.steps, "steps");

  const validateApprovalReferences = (
    steps: WorkflowStep[],
    pathPrefix: string,
  ) => {
    const precedingAgentIds = new Set<string>();
    const precedingArtifactNames = new Set<string>();

    for (const [index, step] of steps.entries()) {
      const stepPath = `${pathPrefix}[${index}]`;

      if (step.uses === "approval") {
        if (step.revise !== undefined) {
          const revisedStep = stepsById.get(step.revise)?.step;

          if (!revisedStep) {
            addIssue({
              path: `${stepPath}.revise`,
              stepId: step.id,
              message: `revise references missing step "${step.revise}"`,
            });
          } else if (revisedStep.uses !== "agent") {
            addIssue({
              path: `${stepPath}.revise`,
              stepId: step.id,
              message:
                `revise must reference an agent step; "${step.revise}" uses ` +
                `"${revisedStep.uses}"`,
            });
          } else if (!precedingAgentIds.has(step.revise)) {
            addIssue({
              path: `${stepPath}.revise`,
              stepId: step.id,
              message:
                `agent step "${step.revise}" is not available before this ` +
                "approval in the same sequential block",
            });
          }
        }

        if (step.artifact !== undefined) {
          if (!artifactsByName.has(step.artifact)) {
            addIssue({
              path: `${stepPath}.artifact`,
              stepId: step.id,
              message:
                `artifact references missing agent artifact "${step.artifact}"`,
            });
          } else if (!precedingArtifactNames.has(step.artifact)) {
            addIssue({
              path: `${stepPath}.artifact`,
              stepId: step.id,
              message:
                `agent artifact "${step.artifact}" is not available before this ` +
                "approval in the same sequential block",
            });
          }
        }
      }

      if (step.uses === "agent") {
        precedingAgentIds.add(step.id);

        if (step.artifact) {
          precedingArtifactNames.add(step.artifact.name);
        }
      }

      if (step.uses === "loop") {
        validateApprovalReferences(step.steps, `${stepPath}.steps`);
      }
    }
  };

  validateApprovalReferences(workflow.steps, "steps");

  if (issues.length > 0) {
    throw new WorkflowValidationError(issues, filePath);
  }

  return workflow;
}

function formatIssue(issue: WorkflowValidationIssue): string {
  const locations: string[] = [];

  if (issue.path) {
    locations.push(issue.path);
  }

  if (issue.stepId) {
    locations.push(`step "${issue.stepId}"`);
  }

  return locations.length > 0
    ? `${locations.join(", ")}: ${issue.message}`
    : issue.message;
}

function getFilenameProblem(filename: string): string | undefined {
  if (filename.length === 0) {
    return "must not be empty";
  }

  if (filename.includes("\0")) {
    return "must not contain a null byte";
  }

  const portableFilename = filename.replaceAll("\\", "/");
  const windowsRoot = path.win32.parse(filename).root;

  if (
    path.posix.isAbsolute(portableFilename) ||
    path.win32.isAbsolute(filename) ||
    windowsRoot.length > 0
  ) {
    return "must be a relative path";
  }

  if (portableFilename.split("/").some((part) => part === "..")) {
    return 'must not contain ".." path segments';
  }

  const normalized = path.posix.normalize(portableFilename);

  if (normalized === "." || normalized.length === 0) {
    return "must name a relative file";
  }

  const base = "/aira-workflow";
  const resolved = path.posix.resolve(base, normalized);
  const relative = path.posix.relative(base, resolved);

  if (
    relative === ".." ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(relative)
  ) {
    return "must stay within the workflow artifact directory";
  }

  return undefined;
}
