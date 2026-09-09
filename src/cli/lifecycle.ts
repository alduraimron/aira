import type { AiraCore, RunBoundary } from "../core";
import { interactWithApproval } from "./approval";
import {
  CLI_EXIT_CANCELLED,
  CLI_EXIT_FAILURE,
  CLI_EXIT_INTERRUPTED,
  CLI_EXIT_SUCCESS,
  type CliExitCode,
} from "./exit-codes";
import type { CliIO } from "./io";
import {
  createCliExecutionReporter,
  type ExecutionReporter,
} from "./reporter";
import {
  processSigintSource,
  type SigintSource,
  withSigintAbort,
} from "./signals";

export interface RunLifecycleParams {
  core: AiraCore;
  boundary: RunBoundary;
  io: CliIO;
  sigintSource?: SigintSource;
  reporter?: ExecutionReporter;
}

export async function runLifecycle(
  params: RunLifecycleParams,
): Promise<CliExitCode> {
  let boundary = params.boundary;
  const reporter = params.reporter ?? createCliExecutionReporter(params.io);

  while (true) {
    switch (boundary.kind) {
      case "completed":
        params.io.writeOut(`✓ Run completed: ${boundary.runId}\n`);
        return CLI_EXIT_SUCCESS;
      case "failed":
        params.io.writeError(`✗ Run failed: ${boundary.runId}\n`);
        return CLI_EXIT_FAILURE;
      case "cancelled":
        params.io.writeOut("Run cancelled.\n");
        return CLI_EXIT_CANCELLED;
      case "interrupted":
        params.io.writeError(`Run interrupted: ${boundary.runId}\n`);
        return CLI_EXIT_INTERRUPTED;
      case "manual-intervention": {
        const stepId = boundary.currentStep?.id ?? "unknown";
        const attempts = boundary.intervention.maxAttempts;
        params.io.writeError(
          boundary.reason === "loop-exhausted" && attempts !== undefined
            ? `Run is waiting after loop "${stepId}" exhausted its ` +
                `${attempts} attempts.\n` +
                "Manual loop intervention is not supported yet.\n" +
                `Run ID: ${boundary.runId}\n`
            : `${boundary.summary}\nRun ID: ${boundary.runId}\n`,
        );
        return CLI_EXIT_FAILURE;
      }
      case "approval-required": {
        reporter.emit({
          type: "step.started",
          stepId: boundary.approval.stepId,
          stepType: "approval",
        });
        reporter.emit({
          type: "approval.waiting",
          stepId: boundary.approval.stepId,
          message: boundary.approval.message,
        });

        const interaction = await interactWithApproval({
          boundary,
          io: params.io,
          sigintSource: params.sigintSource,
          showWaitingHeader: false,
        });

        if (interaction.kind === "interrupted") {
          params.io.writeError("approval interrupted; run remains waiting\n");
          return CLI_EXIT_INTERRUPTED;
        }

        if (interaction.kind === "closed") {
          params.io.writeError("approval input closed; run remains waiting\n");
          return CLI_EXIT_FAILURE;
        }

        if (interaction.decision === "cancel") {
          boundary = await params.core.continueRun({
            runId: boundary.runId,
            action: "cancel",
            expectedBoundaryToken: boundary.checkpointToken,
          });
          break;
        }

        boundary = await withSigintAbort({
          io: params.io,
          source: params.sigintSource ?? processSigintSource,
          execute: async (signal) =>
            await params.core.continueRun(
              interaction.decision === "revise"
                ? {
                    runId: boundary.runId,
                    action: "revise",
                    feedback: interaction.feedback ?? "",
                    expectedBoundaryToken: boundary.checkpointToken,
                  }
                : {
                    runId: boundary.runId,
                    action: "approve",
                    expectedBoundaryToken: boundary.checkpointToken,
                  },
              { signal, onEvent: reporter.emit },
            ),
        });
        break;
      }
    }
  }
}
