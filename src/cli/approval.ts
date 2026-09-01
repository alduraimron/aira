import {
  applyApprovalDecision,
  type ApprovalDecision,
  type ApplyApprovalDecisionParams,
} from "../approval";
import { readArtifact } from "../artifacts";
import type { RunState } from "../run";
import { findWorkflowStep, type ApprovalStep, type Workflow } from "../workflow";
import type { CliIO } from "./io";
import {
  processSigintSource,
  type SigintSource,
} from "./signals";

export type ApprovalDecisionApplier = (
  params: ApplyApprovalDecisionParams,
) => Promise<RunState>;

export type ApprovalArtifactReader = typeof readArtifact;

export type ApprovalInteractionResult =
  | { kind: "continue"; state: RunState }
  | { kind: "cancelled"; state: RunState }
  | { kind: "closed"; state: RunState }
  | { kind: "interrupted"; state: RunState };

export async function interactWithApproval(params: {
  workflow: Workflow;
  runsRoot: string;
  state: RunState;
  io: CliIO;
  sigintSource?: SigintSource;
  applyDecision?: ApprovalDecisionApplier;
  artifactReader?: ApprovalArtifactReader;
  showWaitingHeader?: boolean;
}): Promise<ApprovalInteractionResult> {
  const stepId = params.state.current_step;

  if (stepId === undefined) {
    throw new Error(`waiting run "${params.state.id}" has no current step`);
  }

  const step = findWorkflowStep(params.workflow, stepId);

  if (step?.uses !== "approval") {
    throw new Error(`current step "${stepId}" is not an approval step`);
  }

  await displayApproval(params, step);

  while (true) {
    const input = await readApprovalLine(
      params.io,
      params.sigintSource ?? processSigintSource,
    );

    if (input.kind === "interrupted") {
      return { kind: "interrupted", state: params.state };
    }

    if (input.kind === "closed") {
      return { kind: "closed", state: params.state };
    }

    const decision = parseApprovalInput(
      input.answer,
      step.revise !== undefined,
    );

    if (decision === undefined) {
      params.io.writeOut(
        step.revise === undefined
          ? "Please enter approve or cancel.\n"
          : "Please enter approve, revise, or cancel.\n",
      );
      continue;
    }

    const nextState = await (params.applyDecision ?? applyApprovalDecision)({
      workflow: params.workflow,
      runsRoot: params.runsRoot,
      state: params.state,
      stepId,
      decision,
    });

    return decision === "cancel"
      ? { kind: "cancelled", state: nextState }
      : { kind: "continue", state: nextState };
  }
}

type ApprovalLineResult =
  | { kind: "line"; answer: string }
  | { kind: "closed" }
  | { kind: "interrupted" };

async function readApprovalLine(
  io: CliIO,
  sigintSource: SigintSource,
): Promise<ApprovalLineResult> {
  const controller = new AbortController();
  let interrupted = false;
  const handler = () => {
    interrupted = true;
    controller.abort();
  };

  sigintSource.add(handler);

  try {
    const answer = await io.readLine("> ", controller.signal);

    if (interrupted) {
      return { kind: "interrupted" };
    }

    return answer === null
      ? { kind: "closed" }
      : { kind: "line", answer };
  } finally {
    sigintSource.remove(handler);
  }
}

export function parseApprovalInput(
  input: string,
  revisionSupported: boolean,
): ApprovalDecision | undefined {
  switch (input.trim().toLowerCase()) {
    case "a":
    case "approve":
      return "approve";
    case "r":
    case "revise":
      return revisionSupported ? "revise" : undefined;
    case "c":
    case "cancel":
      return "cancel";
    default:
      return undefined;
  }
}

async function displayApproval(
  params: {
    runsRoot: string;
    state: RunState;
    io: CliIO;
    artifactReader?: ApprovalArtifactReader;
    showWaitingHeader?: boolean;
  },
  step: ApprovalStep,
): Promise<void> {
  if (params.showWaitingHeader !== false) {
    params.io.writeOut(`\n[${step.id}] waiting for approval\n\n`);
  }

  if (step.artifact !== undefined) {
    params.io.writeOut(`Artifact: ${step.artifact}\n\n`);

    if (Object.prototype.hasOwnProperty.call(params.state.artifacts, step.artifact)) {
      const content = await (params.artifactReader ?? readArtifact)({
        runsRoot: params.runsRoot,
        state: params.state,
        name: step.artifact,
      });
      params.io.writeOut(`${content}\n\n`);
    } else {
      params.io.writeOut("(artifact is not available)\n\n");
    }
  }

  params.io.writeOut(
    `${step.message ?? `Approve step "${step.id}"?`}\n\n` +
      "[a] approve\n" +
      (step.revise === undefined ? "" : "[r] revise\n") +
      "[c] cancel\n",
  );
}
