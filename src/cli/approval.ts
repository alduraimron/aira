import type {
  ApprovalDecision,
  ApplyApprovalDecisionParams,
} from "../approval";
import type { readArtifact } from "../artifacts";
import type { ApprovalRequiredBoundary } from "../core";
import type { CliIO } from "./io";
import { processSigintSource, type SigintSource } from "./signals";

export type ApprovalDecisionApplier = (
  params: ApplyApprovalDecisionParams,
) => Promise<import("../run").RunState>;

export type ApprovalArtifactReader = typeof readArtifact;

export type ApprovalInteractionResult =
  | {
      kind: "decision";
      decision: ApprovalDecision;
      feedback?: string;
    }
  | { kind: "closed" }
  | { kind: "interrupted" };

export async function interactWithApproval(params: {
  boundary: ApprovalRequiredBoundary;
  io: CliIO;
  sigintSource?: SigintSource;
  showWaitingHeader?: boolean;
}): Promise<ApprovalInteractionResult> {
  displayApproval(params);

  while (true) {
    const input = await readInputLine(
      params.io,
      params.sigintSource ?? processSigintSource,
      "> ",
    );

    if (input.kind !== "line") {
      return input;
    }

    const revisionSupported =
      params.boundary.approval.allowedDecisions.includes("revise");
    const decision = parseApprovalInput(input.answer, revisionSupported);

    if (decision === undefined) {
      params.io.writeOut(
        revisionSupported
          ? "Please enter approve, revise, or cancel.\n"
          : "Please enter approve or cancel.\n",
      );
      continue;
    }

    if (decision !== "revise") {
      return { kind: "decision", decision };
    }

    const feedbackInput = await readRevisionFeedback(
      params.io,
      params.sigintSource ?? processSigintSource,
    );

    if (feedbackInput.kind !== "feedback") {
      return feedbackInput;
    }

    return {
      kind: "decision",
      decision,
      feedback: feedbackInput.feedback,
    };
  }
}

type ApprovalLineResult =
  | { kind: "line"; answer: string }
  | { kind: "closed" }
  | { kind: "interrupted" };

async function readRevisionFeedback(
  io: CliIO,
  sigintSource: SigintSource,
): Promise<
  | { kind: "feedback"; feedback: string }
  | { kind: "closed" }
  | { kind: "interrupted" }
> {
  io.writeOut("\nWhat should be revised?\n");

  while (true) {
    const input = await readInputLine(io, sigintSource, "> ");

    if (input.kind !== "line") {
      return input;
    }

    const feedback = input.answer.trim();

    if (feedback.length > 0) {
      return { kind: "feedback", feedback };
    }

    io.writeOut("Revision feedback must not be empty.\n");
  }
}

async function readInputLine(
  io: CliIO,
  sigintSource: SigintSource,
  prompt: string,
): Promise<ApprovalLineResult> {
  const controller = new AbortController();
  let interrupted = false;
  const handler = () => {
    interrupted = true;
    controller.abort();
  };

  sigintSource.add(handler);

  try {
    const answer = await io.readLine(prompt, controller.signal);

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

function displayApproval(params: {
  boundary: ApprovalRequiredBoundary;
  io: CliIO;
  showWaitingHeader?: boolean;
}): void {
  const approval = params.boundary.approval;

  if (params.showWaitingHeader !== false) {
    params.io.writeOut(`\n[${approval.stepId}] waiting for approval\n\n`);
  }

  if (approval.artifact !== undefined) {
    params.io.writeOut(`Artifact: ${approval.artifact.name}\n\n`);
    params.io.writeOut(
      approval.artifact.available
        ? `${approval.artifact.content}\n\n`
        : "(artifact is not available)\n\n",
    );
  }

  params.io.writeOut(
    `${approval.message}\n\n` +
      "[a] approve\n" +
      (approval.allowedDecisions.includes("revise") ? "[r] revise\n" : "") +
      "[c] cancel\n",
  );
}
