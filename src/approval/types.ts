import type { RunState } from "../run/types";
import type { Workflow } from "../workflow/types";

export const APPROVAL_DECISIONS = ["approve", "revise", "cancel"] as const;

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export interface ApplyApprovalDecisionParams {
  workflow: Workflow;
  runsRoot: string;
  state: RunState;
  stepId: string;
  decision: ApprovalDecision;
  feedback?: string;
  now?: () => Date;
}
