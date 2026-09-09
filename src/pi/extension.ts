import path from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateLine,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { PiRuntime } from "../agent";
import {
  AiraCore,
  AiraCoreError,
  CoreRunNotFoundError,
  InvalidRevisionFeedbackError,
  type ArtifactView,
  type ContinueRunInput,
  type ProjectInfo,
  type RunBoundary,
  type RunPreview,
  type RunPreviewStep,
  type RunView,
  type WorkflowInfo,
} from "../core";
import type { AiraExecutionEvent } from "../executor";
import { sanitizeDisplayText } from "../observability/display";

export const AIRA_SESSION_ENTRY_TYPE = "aira.active-run";
const AIRA_SESSION_ENTRY_VERSION = 1;
const APPROVAL_ARTIFACT_MAX_BYTES = 12 * 1024;
const APPROVAL_ARTIFACT_MAX_LINES = 300;
const START_BRIEF_SUMMARY_CHARACTERS = 180;
const APPROVAL_MESSAGE_SUMMARY_CHARACTERS = 240;
const REVISION_FEEDBACK_MAX_BYTES = 2 * 1024;
const REVISION_FEEDBACK_MAX_LINES = 12;
const REVISION_FEEDBACK_LONG_LINE_CHARACTERS = 800;
const ARTIFACT_CONTENT_MAX_BYTES = DEFAULT_MAX_BYTES - 2 * 1024;
const ARTIFACT_CONTENT_MAX_LINES = DEFAULT_MAX_LINES - 12;
const RENDER_PREVIEW_LINES = 30;

export interface AiraCoreApi {
  inspectProject(): Promise<ProjectInfo>;
  initializeProject(): Promise<ProjectInfo>;
  listWorkflows(): Promise<WorkflowInfo[]>;
  previewRun(input: { workflow: string; task: string }): Promise<RunPreview>;
  startRun(
    input: {
      workflow: string;
      task: string;
      allowDirty?: boolean;
      expectedPreparationToken?: string;
    },
    execution?: {
      signal?: AbortSignal;
      onEvent?: (event: AiraExecutionEvent) => void;
    },
  ): Promise<RunBoundary>;
  inspectRun(runId?: string): Promise<RunView | undefined>;
  continueRun(
    input: ContinueRunInput,
    execution?: {
      signal?: AbortSignal;
      onEvent?: (event: AiraExecutionEvent) => void;
    },
  ): Promise<RunBoundary>;
  readArtifact(input: {
    runId: string;
    name: string;
    path?: string;
    version?: number;
  }): Promise<ArtifactView>;
}

export interface AiraPiExtensionOptions {
  createCore?: (cwd: string) => AiraCoreApi;
}

export interface ActiveRunSessionEntry {
  version: 1;
  projectRoot: string;
  runId: string;
  active: boolean;
}

interface AuthorizationDetails {
  kind: "authorization";
  action: string;
  authorized: false;
  reason: "rejected" | "unavailable" | "aborted" | "untrusted-project";
}

interface ProjectDetails {
  kind: "project";
  project: ProjectInfo;
  workflows: WorkflowInfo[];
  run?: PresentedRunView;
  associatedRunId?: string;
}

interface PreviewDetails {
  kind: "preview";
  preview: RunPreview;
}

interface BoundaryDetails {
  kind: "boundary";
  boundary: PresentedBoundary;
  action?: "start" | "approve" | "revise" | "cancel" | "resume";
  progress?: string;
}

interface StatusDetails {
  kind: "status";
  run?: PresentedRunView;
  source: "explicit" | "session" | "latest" | "none";
}

interface ArtifactDetails {
  kind: "artifact";
  artifact: Omit<ArtifactView, "content">;
  preview: string;
  shownStartLine: number;
  shownEndLine: number;
  totalLines: number;
  truncated: boolean;
  nextStartLine?: number;
}

interface ProgressDetails {
  kind: "progress";
  workflow: string;
  runId?: string;
  latestEvent?: AiraExecutionEvent;
}

type AiraToolDetails =
  | AuthorizationDetails
  | ProjectDetails
  | PreviewDetails
  | BoundaryDetails
  | StatusDetails
  | ArtifactDetails
  | ProgressDetails;

type PresentedBoundary = Omit<RunBoundary, "approval"> & {
  approval?: RunBoundary extends infer _Boundary
    ? {
        stepId: string;
        message: string;
        revisionTargetStepId?: string;
        allowedDecisions: Array<"approve" | "revise" | "cancel">;
        artifact?: Record<string, unknown>;
      }
    : never;
};

type PresentedRunView = Omit<RunView, "boundary"> & {
  boundary?: PresentedBoundary;
};

interface SelectedRun {
  view: RunView;
  source: "explicit" | "session" | "latest";
}

interface ProgressStep {
  id: string;
  depth: number;
  status: "pending" | "running" | "waiting" | "completed" | "failed" | "skipped";
}

const projectParameters = Type.Object({});
const initParameters = Type.Object({});
const startParameters = Type.Object({
  workflow: Type.String({
    minLength: 1,
    description: "Workflow name returned by aira_project. Never assume a name.",
  }),
  task: Type.String({
    minLength: 1,
    description:
      "Self-contained execution brief. Summarize the agreed goal, context, chosen approach, constraints, acceptance criteria, and non-goals. Do not send the chat transcript.",
  }),
  allowDirty: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Allow a new run in a dirty Git worktree. Defaults to false.",
    }),
  ),
});
const statusParameters = Type.Object({
  runId: Type.Optional(
    Type.String({ description: "Explicit Aira run ID. Overrides session state." }),
  ),
});
const continueParameters = Type.Object({
  runId: Type.Optional(
    Type.String({
      description:
        "Explicit Aira run ID. Overrides the active run associated with this Pi session.",
    }),
  ),
  action: StringEnum(["approve", "revise", "cancel", "resume"] as const, {
    description:
      "Action allowed by the current Core lifecycle state. Never approve without the human's explicit authorization.",
  }),
  feedback: Type.Optional(
    Type.String({
      description: "Exact human-approved revision feedback. Required for revise.",
    }),
  ),
});
const artifactParameters = Type.Object({
  runId: Type.Optional(
    Type.String({ description: "Explicit run ID. Overrides session state." }),
  ),
  name: Type.String({
    minLength: 1,
    description: "Artifact name listed by aira_status or a lifecycle boundary.",
  }),
  path: Type.Optional(
    Type.String({
      description:
        "Known run-relative historical path listed in artifact metadata. Cannot be an arbitrary filesystem path.",
    }),
  ),
  version: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Known one-based artifact version. Cannot be combined with path.",
    }),
  ),
  startLine: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "First artifact line to return. Defaults to 1.",
    }),
  ),
  maxLines: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: DEFAULT_MAX_LINES,
      description: `Maximum lines to return. Output is also capped at ${formatSize(DEFAULT_MAX_BYTES)}.`,
    }),
  ),
});

export default function airaPiExtension(pi: ExtensionAPI): void {
  registerAiraPiExtension(pi);
}

export function registerAiraPiExtension(
  pi: ExtensionAPI,
  options: AiraPiExtensionOptions = {},
): void {
  const createCore = options.createCore ?? defaultCoreFactory;
  const activeRuns = new Map<string, string>();

  const restoreActiveRuns = (ctx: ExtensionContext): void => {
    activeRuns.clear();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type !== "custom" ||
        entry.customType !== AIRA_SESSION_ENTRY_TYPE ||
        !isActiveRunSessionEntry(entry.data)
      ) {
        continue;
      }

      const root = path.resolve(entry.data.projectRoot);

      if (entry.data.active) {
        activeRuns.set(root, entry.data.runId);
      } else {
        activeRuns.delete(root);
      }
    }
  };

  const persistAssociation = (
    projectRoot: string,
    boundary: RunBoundary,
  ): void => {
    const root = path.resolve(projectRoot);
    const active = isActiveBoundary(boundary);

    if (active) {
      activeRuns.set(root, boundary.runId);
    } else {
      activeRuns.delete(root);
    }

    pi.appendEntry<ActiveRunSessionEntry>(AIRA_SESSION_ENTRY_TYPE, {
      version: AIRA_SESSION_ENTRY_VERSION,
      projectRoot: root,
      runId: boundary.runId,
      active,
    });
  };

  pi.on("session_start", (_event, ctx) => restoreActiveRuns(ctx));
  pi.on("session_tree", (_event, ctx) => restoreActiveRuns(ctx));

  const projectTool: ToolDefinition<typeof projectParameters, AiraToolDetails> = {
    name: "aira_project",
    label: "Aira Project",
    description:
      "Inspect Aira in the current project without changing anything. Returns initialization state, available workflows and descriptions, and active or latest run information. Use this before choosing a workflow instead of assuming workflow names.",
    promptSnippet: "Inspect Aira project workflows and current run state",
    promptGuidelines: [
      "Use aira_project before an Aira handoff so you choose a real project workflow by its description.",
    ],
    parameters: projectParameters,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return await asToolError(async () => {
        const core = createCore(ctx.cwd);
        const project = await core.inspectProject();

        if (!project.initialized) {
          const details: ProjectDetails = {
            kind: "project",
            project,
            workflows: [],
          };
          return textResult(
            `Aira is not initialized.\nProject location: ${project.root}\nUse aira_init only after the human authorizes initialization.`,
            details,
          );
        }

        const workflows = await core.listWorkflows();
        const selected = await selectRun(
          core,
          project.root,
          undefined,
          activeRuns,
        );
        const details: ProjectDetails = {
          kind: "project",
          project,
          workflows,
          ...(selected === undefined
            ? {}
            : {
                run: presentRunView(selected.view),
                ...(selected.source === "session"
                  ? { associatedRunId: selected.view.runId }
                  : {}),
              }),
        };
        return textResult(formatProject(project, workflows, selected), details);
      });
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("aira project")), 0, 0);
    },
    renderResult: renderAiraResult,
  };

  const initTool: ToolDefinition<typeof initParameters, AiraToolDetails> = {
    name: "aira_init",
    label: "Aira Init",
    description:
      "Initialize Aira in the current repository. This writes the default .aira project only after Pi's interactive UI obtains explicit human authorization. It is idempotent and never overwrites an existing .aira directory.",
    promptSnippet: "Initialize Aira after explicit human authorization",
    promptGuidelines: [
      "Call aira_init only when the human has asked to initialize Aira. The tool itself will require interactive authorization.",
    ],
    parameters: initParameters,
    executionMode: "sequential",
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      return await asToolError(async () => {
        const core = createCore(ctx.cwd);
        const before = await core.inspectProject();
        const authorization = await authorize(
          ctx,
          signal,
          "Initialize Aira?",
          before.initialized
            ? `Aira is already initialized at ${before.root}. Confirm the idempotent initialization check.`
            : `Create .aira configuration, workflows, commands, and run storage in ${before.root}?`,
          "initialize Aira",
        );

        if (authorization !== true) {
          return authorization;
        }

        if (before.initialized) {
          return textResult(
            `Aira was already initialized in ${before.root}; no files were changed.`,
            {
              kind: "project",
              project: before,
              workflows: [],
            } satisfies ProjectDetails,
          );
        }

        const project = await core.initializeProject();
        return textResult(`Initialized Aira in ${project.root}.`, {
          kind: "project",
          project,
          workflows: [],
        } satisfies ProjectDetails);
      });
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("aira init")), 0, 0);
    },
    renderResult: renderAiraResult,
  };

  const startTool: ToolDefinition<typeof startParameters, AiraToolDetails> = {
    name: "aira_start",
    label: "Aira Start",
    description:
      "Preflight and start an Aira workflow in-process through Aira Core. Use only after discussion has produced a concrete agreed change and the human wants execution. Pass a self-contained execution brief, never the conversation transcript. The tool shows the exact handoff and requires interactive human authorization before creating a run. Progress streams while Aira executes. Approval artifact content is a bounded preview; use aira_artifact for explicit paginated access when marked truncated.",
    promptSnippet: "Start an agreed Aira workflow from a self-contained execution brief",
    promptGuidelines: [
      "Use aira_start only after requirements and design are settled and the human asks to execute with Aira.",
      "Before aira_start, compress the agreed discussion into a self-contained brief with goal, context, chosen approach, constraints, acceptance criteria, and non-goals. Never forward the chat transcript wholesale.",
    ],
    parameters: startParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return await asToolError(async () => {
        const core = createCore(ctx.cwd);
        const preview = await core.previewRun({
          workflow: params.workflow,
          task: params.task,
        });
        onUpdate?.(
          textResult(
            formatStartPreview(preview, params.allowDirty === true),
            { kind: "preview", preview } satisfies PreviewDetails,
          ),
        );
        const authorization = await authorize(
          ctx,
          signal,
          `Start Aira workflow "${preview.workflow.name}"?`,
          formatStartAuthorization(preview, params.allowDirty === true),
          `start workflow "${preview.workflow.name}"`,
        );

        if (authorization !== true) {
          return authorization;
        }

        const progress = ProgressTracker.fromPreview(preview);
        onUpdate?.(progressResult(progress));
        const boundary = await core.startRun(
          {
            workflow: params.workflow,
            task: params.task,
            allowDirty: params.allowDirty ?? false,
            expectedPreparationToken: preview.preparationToken,
          },
          {
            signal,
            onEvent: (event) => {
              progress.accept(event);
              onUpdate?.(progressResult(progress, event));
            },
          },
        );
        persistAssociation(preview.projectRoot, boundary);
        return boundaryResult(boundary, progress.render(), "start");
      });
    },
    renderCall(args, theme, context) {
      let text = theme.fg("toolTitle", theme.bold("aira start "));
      text += theme.fg("accent", args.workflow ?? "");
      if (args.allowDirty === true) {
        text += theme.fg("warning", " allow-dirty");
      }
      if (context.expanded && args.task) {
        text += `\n${theme.fg("dim", `Execution brief:\n${args.task}`)}`;
      }
      return new Text(text, 0, 0);
    },
    renderResult: renderAiraResult,
  };

  const statusTool: ToolDefinition<typeof statusParameters, AiraToolDetails> = {
    name: "aira_status",
    label: "Aira Status",
    description:
      "Read structured Aira run status without prompting. An explicit run ID wins. Otherwise the tool prefers this Pi session's active run for the current Aira project, then falls back to the project's latest run.",
    promptSnippet: "Inspect an Aira run and its allowed next actions",
    parameters: statusParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return await asToolError(async () => {
        const core = createCore(ctx.cwd);
        const project = await core.inspectProject();

        if (!project.initialized) {
          return textResult("Aira is not initialized in this project.", {
            kind: "status",
            source: "none",
          } satisfies StatusDetails);
        }

        const selected = await selectRun(
          core,
          project.root,
          params.runId,
          activeRuns,
        );

        if (selected === undefined) {
          return textResult("No Aira runs found.", {
            kind: "status",
            source: "none",
          } satisfies StatusDetails);
        }

        return textResult(formatRunView(selected.view), {
          kind: "status",
          run: presentRunView(selected.view),
          source: selected.source,
        } satisfies StatusDetails);
      });
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("aira status"));
      if (args.runId) {
        text += " " + theme.fg("muted", args.runId);
      }
      return new Text(text, 0, 0);
    },
    renderResult: renderAiraResult,
  };

  const continueTool: ToolDefinition<
    typeof continueParameters,
    AiraToolDetails
  > = {
    name: "aira_continue",
    label: "Aira Continue",
    description:
      "Apply approve, revise, cancel, or resume through Aira Core and continue to the next lifecycle boundary. An explicit run ID wins over session state. Every action requires interactive human authorization. Never call approve automatically. Revision submits only the exact feedback displayed to the human. Progress streams during execution. Approval artifact content is a bounded preview; use aira_artifact when marked truncated.",
    promptSnippet: "Continue an Aira run after explicit human authorization",
    promptGuidelines: [
      "Never call aira_continue with approve unless the human explicitly approved the displayed Aira artifact.",
      "Discuss an approval artifact with the human before proposing approve or revise. For revise, pass the agreed feedback exactly.",
    ],
    parameters: continueParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return await asToolError(async () => {
        const core = createCore(ctx.cwd);
        const project = await core.inspectProject();

        if (!project.initialized) {
          throw new Error("Aira is not initialized in this project.");
        }

        const selected = await selectRun(
          core,
          project.root,
          params.runId,
          activeRuns,
        );

        if (selected === undefined) {
          throw new Error("No Aira run is available to continue.");
        }

        const feedback =
          params.action === "revise" ? (params.feedback ?? "") : undefined;

        if (
          params.action === "revise" &&
          (feedback === undefined || feedback.trim().length === 0)
        ) {
          throw new InvalidRevisionFeedbackError(selected.view.runId);
        }

        assertActionAvailable(selected.view, params.action);
        const authorization = await authorize(
          ctx,
          signal,
          authorizationTitle(selected.view, params.action),
          authorizationMessage(selected.view, params.action, feedback),
          `${params.action} Aira run "${selected.view.runId}"`,
        );

        if (authorization !== true) {
          return authorization;
        }

        const progress = ProgressTracker.fromRunView(selected.view);
        onUpdate?.(progressResult(progress));
        const input: ContinueRunInput =
          params.action === "revise"
            ? {
                runId: selected.view.runId,
                action: "revise",
                feedback: feedback ?? "",
                expectedBoundaryToken: selected.view.checkpointToken,
              }
            : {
                runId: selected.view.runId,
                action: params.action,
                expectedBoundaryToken: selected.view.checkpointToken,
              };
        const boundary = await core.continueRun(input, {
          signal,
          onEvent: (event) => {
            progress.accept(event);
            onUpdate?.(progressResult(progress, event));
          },
        });
        persistAssociation(project.root, boundary);
        return boundaryResult(boundary, progress.render(), params.action);
      });
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("aira continue "));
      text += theme.fg("accent", args.action ?? "");
      if (args.runId) {
        text += " " + theme.fg("muted", args.runId);
      }
      return new Text(text, 0, 0);
    },
    renderResult: renderAiraResult,
  };

  const artifactTool: ToolDefinition<
    typeof artifactParameters,
    AiraToolDetails
  > = {
    name: "aira_artifact",
    label: "Aira Artifact",
    description:
      `Read a current or known historical Aira artifact through Core. It never accepts arbitrary filesystem paths. Output is paginated and capped at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Use startLine to continue when a result says it was truncated. This tool is read-only and never prompts.`,
    promptSnippet: "Read a bounded current or historical Aira artifact",
    parameters: artifactParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return await asToolError(async () => {
        const core = createCore(ctx.cwd);
        const project = await core.inspectProject();

        if (!project.initialized) {
          throw new Error("Aira is not initialized in this project.");
        }

        const selected = await selectRun(
          core,
          project.root,
          params.runId,
          activeRuns,
        );

        if (selected === undefined) {
          throw new Error("No Aira run is available for artifact access.");
        }

        const artifact = await core.readArtifact({
          runId: selected.view.runId,
          name: params.name,
          ...(params.path === undefined ? {} : { path: params.path }),
          ...(params.version === undefined ? {} : { version: params.version }),
        });
        return artifactResult(
          artifact,
          params.startLine ?? 1,
          params.maxLines ?? DEFAULT_MAX_LINES,
        );
      });
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("aira artifact "));
      text += theme.fg("accent", args.name ?? "");
      if (args.version !== undefined) {
        text += theme.fg("muted", ` v${args.version}`);
      } else if (args.path) {
        text += " " + theme.fg("muted", args.path);
      }
      return new Text(text, 0, 0);
    },
    renderResult: renderAiraResult,
  };

  for (const tool of [
    projectTool,
    initTool,
    startTool,
    statusTool,
    continueTool,
    artifactTool,
  ]) {
    pi.registerTool(tool);
  }

  pi.registerCommand("aira", {
    description: "Show compact Aira project and run status",
    handler: async (_args, ctx) => {
      try {
        const core = createCore(ctx.cwd);
        const project = await core.inspectProject();

        if (!project.initialized) {
          ctx.ui.notify(`Aira is not initialized in ${project.root}.`, "info");
          return;
        }

        const workflows = await core.listWorkflows();
        const selected = await selectRun(
          core,
          project.root,
          undefined,
          activeRuns,
        );
        ctx.ui.notify(formatCommandStatus(project, workflows, selected), "info");
      } catch (error) {
        ctx.ui.notify(formatToolError(error), "error");
      }
    },
  });
}

function defaultCoreFactory(cwd: string): AiraCore {
  return new AiraCore({
    cwd,
    agentRuntimeFactory: () => new PiRuntime(),
  });
}

async function asToolError<T extends AgentToolResult<AiraToolDetails>>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new Error(formatToolError(cause), { cause });
  }
}

function formatToolError(error: unknown): string {
  const message = sanitizeDisplayText(
    error instanceof Error ? error.message : String(error),
    2_000,
  );

  if (error instanceof AiraCoreError) {
    return `${message} [${error.code}]`;
  }

  return message;
}

function textResult<TDetails extends AiraToolDetails>(
  text: string,
  details: TDetails,
): AgentToolResult<TDetails> {
  const bounded = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const content = bounded.truncated
    ? `${bounded.content}\n\n[Tool output truncated: showing ${bounded.outputLines} of ${bounded.totalLines} lines, ${formatSize(bounded.outputBytes)} of ${formatSize(bounded.totalBytes)}. Request a narrower status or another artifact page.]`
    : bounded.content;

  return {
    content: [{ type: "text", text: content }],
    details,
  };
}

async function authorize(
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  title: string,
  message: string,
  action: string,
): Promise<true | AgentToolResult<AuthorizationDetails>> {
  if (isSignalAborted(signal)) {
    return authorizationFailure(action, "aborted");
  }

  if (!ctx.isProjectTrusted()) {
    return authorizationFailure(action, "untrusted-project");
  }

  if (!ctx.hasUI) {
    return authorizationFailure(action, "unavailable");
  }

  let confirmed: boolean;

  try {
    confirmed = await ctx.ui.confirm(title, message, { signal });
  } catch {
    return authorizationFailure(action, "unavailable");
  }

  if (isSignalAborted(signal)) {
    return authorizationFailure(action, "aborted");
  }

  return confirmed ? true : authorizationFailure(action, "rejected");
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function authorizationFailure(
  action: string,
  reason: AuthorizationDetails["reason"],
): AgentToolResult<AuthorizationDetails> {
  const message =
    reason === "unavailable"
      ? `Aira did not ${action}. Interactive human authorization is unavailable.`
      : reason === "untrusted-project"
        ? `Aira did not ${action}. Pi has not trusted this project for executable project configuration.`
        : reason === "aborted"
          ? `Aira did not ${action}. Authorization was aborted.`
          : `Aira did not ${action}. The human did not authorize it.`;
  return textResult(message, {
    kind: "authorization",
    action,
    authorized: false,
    reason,
  });
}

async function selectRun(
  core: AiraCoreApi,
  projectRoot: string,
  explicitRunId: string | undefined,
  activeRuns: ReadonlyMap<string, string>,
): Promise<SelectedRun | undefined> {
  if (explicitRunId !== undefined) {
    const view = await core.inspectRun(explicitRunId);
    return view === undefined ? undefined : { view, source: "explicit" };
  }

  const associatedRunId = activeRuns.get(path.resolve(projectRoot));

  if (associatedRunId !== undefined) {
    try {
      const view = await core.inspectRun(associatedRunId);

      if (view !== undefined && isActiveRunView(view)) {
        return { view, source: "session" };
      }
    } catch (error) {
      if (!(error instanceof CoreRunNotFoundError)) {
        throw error;
      }
    }
  }

  const latest = await core.inspectRun();
  return latest === undefined ? undefined : { view: latest, source: "latest" };
}

function isActiveRunSessionEntry(value: unknown): value is ActiveRunSessionEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const entry = value as Partial<ActiveRunSessionEntry>;
  return (
    entry.version === AIRA_SESSION_ENTRY_VERSION &&
    typeof entry.projectRoot === "string" &&
    path.isAbsolute(entry.projectRoot) &&
    typeof entry.runId === "string" &&
    typeof entry.active === "boolean"
  );
}

function isActiveBoundary(boundary: RunBoundary): boolean {
  return (
    boundary.kind === "approval-required" ||
    boundary.kind === "interrupted" ||
    boundary.kind === "manual-intervention"
  );
}

function isActiveRunView(view: RunView): boolean {
  return (
    view.status === "waiting" ||
    view.status === "interrupted" ||
    (view.status === "running" && view.pendingRevision !== undefined)
  );
}

function formatProject(
  project: Extract<ProjectInfo, { initialized: true }>,
  workflows: readonly WorkflowInfo[],
  selected: SelectedRun | undefined,
): string {
  const lines = [
    "Aira project",
    `Root: ${project.root}`,
    `Workflows (${workflows.length}): ${
      workflows.length === 0
        ? "none"
        : workflows.map((workflow) => workflow.name).join(", ")
    }`,
  ];

  for (const workflow of workflows) {
    if (workflow.description !== undefined) {
      lines.push(`- ${workflow.name}: ${workflow.description}`);
    }
  }

  lines.push(
    selected === undefined
      ? "Run: none"
      : `Run: ${selected.view.runId} (${selected.view.status}, ${selected.source})`,
  );

  if (selected !== undefined && selected.view.allowedActions.length > 0) {
    lines.push(`Allowed next actions: ${selected.view.allowedActions.join(", ")}`);
  }

  return lines.join("\n");
}

function formatStartPreview(preview: RunPreview, allowDirty: boolean): string {
  return [
    `Aira · ${preview.workflow.name}`,
    `Project: ${preview.projectRoot}`,
    `Steps: ${flattenPreviewSteps(preview.steps).map((step) => step.id).join(" → ")}`,
    `Dirty worktree: ${allowDirty ? "allowed" : "refused"}`,
    "",
    "Execution brief:",
    preview.task,
    "",
    "Waiting for human authorization.",
  ].join("\n");
}

function formatStartAuthorization(
  preview: RunPreview,
  allowDirty: boolean,
): string {
  const steps = flattenPreviewSteps(preview.steps);
  const summary = summarizeAuthorizationText(
    preview.task,
    START_BRIEF_SUMMARY_CHARACTERS,
  );
  return [
    `Project: ${preview.projectRoot}`,
    `Workflow: ${preview.workflow.name}`,
    `Steps: ${steps.length}`,
    `Allow dirty worktree: ${allowDirty ? "yes" : "no"}`,
    `Brief summary: ${summary.text}`,
    ...(summary.truncated
      ? [
          `Brief summary truncated: ${summary.shownCharacters} of ${summary.totalCharacters} characters shown. Review the complete brief in the Aira tool preview.`,
        ]
      : []),
    "Confirming creates and starts a new Aira run.",
  ].join("\n");
}

function summarizeAuthorizationText(
  value: string,
  maxCharacters: number,
): {
  text: string;
  truncated: boolean;
  shownCharacters: number;
  totalCharacters: number;
} {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    text: sanitizeDisplayText(value, maxCharacters),
    truncated: normalized.length > maxCharacters,
    shownCharacters: Math.min(normalized.length, maxCharacters),
    totalCharacters: normalized.length,
  };
}

function flattenPreviewSteps(steps: readonly RunPreviewStep[]): RunPreviewStep[] {
  return steps.flatMap((step) => [
    step,
    ...(step.steps === undefined ? [] : flattenPreviewSteps(step.steps)),
  ]);
}

function formatRunView(view: RunView): string {
  const lines = [
    `Aira run ${view.runId}`,
    `Workflow: ${view.workflow}`,
    `Status: ${view.status}`,
    `Current step: ${view.currentStep?.id ?? "none"}${
      view.currentStep === undefined ? "" : ` (${view.currentStep.type})`
    }`,
    `Summary: ${view.summary}`,
    `Allowed next actions: ${
      view.allowedActions.length === 0 ? "none" : view.allowedActions.join(", ")
    }`,
  ];

  if (!view.workflowAvailable) {
    lines.push(
      `Workflow definition: unavailable${
        view.workflowIssue === undefined ? "" : ` (${view.workflowIssue})`
      }`,
    );
  }

  if (view.artifacts.length > 0) {
    lines.push("Artifacts:");
    for (const artifact of view.artifacts) {
      lines.push(
        `- ${artifact.name}: ${artifact.currentPath}` +
          (artifact.versioned ? ` (${artifact.versionCount} versions)` : ""),
      );
    }
  }

  return lines.join("\n");
}

function formatCommandStatus(
  project: Extract<ProjectInfo, { initialized: true }>,
  workflows: readonly WorkflowInfo[],
  selected: SelectedRun | undefined,
): string {
  const run =
    selected === undefined
      ? "none"
      : `${selected.view.runId} ${selected.view.status}` +
        (selected.view.currentStep === undefined
          ? ""
          : ` at ${selected.view.currentStep.id}`);
  const actions =
    selected === undefined || selected.view.allowedActions.length === 0
      ? "none"
      : selected.view.allowedActions.join(", ");
  return [
    `Aira: ${project.root}`,
    `Workflows (${workflows.length}): ${workflows.map((item) => item.name).join(", ") || "none"}`,
    `Run: ${run}`,
    `Next: ${actions}`,
  ].join("\n");
}

function assertActionAvailable(
  view: RunView,
  action: "approve" | "revise" | "cancel" | "resume",
): void {
  if (!view.allowedActions.includes(action)) {
    throw new Error(
      `Aira run "${view.runId}" does not allow "${action}". Allowed actions: ` +
        (view.allowedActions.length === 0
          ? "none"
          : view.allowedActions.join(", ")),
    );
  }
}

function authorizationTitle(
  view: RunView,
  action: "approve" | "revise" | "cancel" | "resume",
): string {
  switch (action) {
    case "approve":
      return `Approve Aira step "${view.currentStep?.id ?? "unknown"}"?`;
    case "revise":
      return `Revise Aira artifact for "${view.currentStep?.id ?? "unknown"}"?`;
    case "cancel":
      return `Cancel Aira run "${view.runId}"?`;
    case "resume":
      return `Resume Aira run "${view.runId}"?`;
  }
}

function authorizationMessage(
  view: RunView,
  action: "approve" | "revise" | "cancel" | "resume",
  feedback: string | undefined,
): string {
  const approval =
    view.boundary?.kind === "approval-required"
      ? view.boundary.approval
      : undefined;

  switch (action) {
    case "approve": {
      const artifact = approval?.artifact;
      const version =
        artifact?.available === true
          ? artifact.versions.find((candidate) => candidate.isCurrent)?.version
          : undefined;
      const message = summarizeAuthorizationText(
        approval?.message ?? "Approve this Aira boundary?",
        APPROVAL_MESSAGE_SUMMARY_CHARACTERS,
      );
      return [
        `Run: ${view.runId}`,
        `Workflow: ${view.workflow}`,
        `Approval step: ${approval?.stepId ?? view.currentStep?.id ?? "unknown"}`,
        `Message: ${message.text}`,
        ...(message.truncated
          ? [
              `Approval message truncated: ${message.shownCharacters} of ${message.totalCharacters} characters shown. Review the complete boundary before confirming.`,
            ]
          : []),
        `Artifact: ${artifact?.name ?? "none"}`,
        ...(artifact?.available === true
          ? [
              `Artifact path: ${artifact.currentPath}`,
              ...(version === undefined ? [] : [`Artifact version: ${version}`]),
            ]
          : []),
        "Confirming approves this boundary and continues Aira execution.",
      ].join("\n");
    }
    case "revise":
      return [
        `Run: ${view.runId}`,
        `Workflow: ${view.workflow}`,
        `Approval step: ${approval?.stepId ?? view.currentStep?.id ?? "unknown"}`,
        `Artifact: ${approval?.artifact?.name ?? "none"}`,
        ...formatRevisionFeedbackAuthorization(feedback ?? ""),
      ].join("\n");
    case "cancel":
      return [
        `Run: ${view.runId}`,
        `Workflow: ${view.workflow}`,
        `Current step: ${view.currentStep?.id ?? "unknown"}`,
        "Cancel this run? This records Aira's existing cancel decision and does not continue execution.",
      ].join("\n");
    case "resume":
      return [
        `Run: ${view.runId}`,
        `Workflow: ${view.workflow}`,
        `Interrupted or revision step: ${view.currentStep?.id ?? view.pendingRevision?.targetStepId ?? "unknown"}`,
        "Aira will rerun the supported execution point in a fresh worker session.",
      ].join("\n");
  }
}

function formatRevisionFeedbackAuthorization(feedback: string): string[] {
  const preview = truncateHead(feedback, {
    maxBytes: REVISION_FEEDBACK_MAX_BYTES,
    maxLines: REVISION_FEEDBACK_MAX_LINES,
  });

  if (!preview.truncated) {
    return ["", "Exact revision feedback to submit:", feedback];
  }

  const displayed = preview.firstLineExceedsLimit
    ? truncateLine(
        feedback.split(/\r\n|\n|\r/, 1)[0] ?? "",
        REVISION_FEEDBACK_LONG_LINE_CHARACTERS,
      ).text
    : preview.content;
  const shownLines = preview.firstLineExceedsLimit ? 1 : preview.outputLines;
  const shownBytes = Buffer.byteLength(displayed, "utf8");
  return [
    "",
    "Revision feedback preview (truncated):",
    displayed,
    "",
    `Preview truncated: showing ${shownLines} of ${preview.totalLines} lines and ${formatSize(shownBytes)} of ${formatSize(preview.totalBytes)}.`,
    "Confirming submits the exact unmodified feedback, not only this preview.",
  ];
}

function boundaryResult(
  boundary: RunBoundary,
  progress?: string,
  action?: BoundaryDetails["action"],
): AgentToolResult<BoundaryDetails> {
  const presented = presentBoundary(boundary);
  return textResult(formatBoundary(boundary, action), {
    kind: "boundary",
    boundary: presented,
    ...(action === undefined ? {} : { action }),
    ...(progress === undefined ? {} : { progress }),
  });
}

function formatBoundary(
  boundary: RunBoundary,
  action?: BoundaryDetails["action"],
): string {
  const lines = [
    ...(action === "revise" ? ["Revision feedback submitted."] : []),
    `Aira run ${boundary.runId}`,
    `Workflow: ${boundary.workflow}`,
    `Boundary: ${boundary.kind}`,
    `Summary: ${boundary.summary}`,
    `Allowed next actions: ${
      boundary.allowedActions.length === 0
        ? "none"
        : boundary.allowedActions.join(", ")
    }`,
  ];

  if (boundary.kind === "approval-required") {
    lines.push(
      `Approval step: ${boundary.approval.stepId}`,
      `Message: ${boundary.approval.message}`,
    );
    const artifact = boundary.approval.artifact;

    if (artifact !== undefined) {
      lines.push(`Artifact: ${artifact.name}`);

      if (artifact.available) {
        const preview = truncateHead(artifact.content, {
          maxBytes: APPROVAL_ARTIFACT_MAX_BYTES,
          maxLines: APPROVAL_ARTIFACT_MAX_LINES,
        });
        lines.push(`Path: ${artifact.currentPath}`, "", preview.content);

        if (preview.truncated) {
          lines.push(
            "",
            `[Artifact preview truncated: showing ${preview.outputLines} of ${preview.totalLines} lines, ${formatSize(preview.outputBytes)} of ${formatSize(preview.totalBytes)}. Use aira_artifact to inspect it.]`,
          );
        }
      } else {
        lines.push(
          "Artifact content is not available." +
            (artifact.reason === undefined ? "" : ` ${artifact.reason}`),
        );
      }
    }
  } else if (boundary.kind === "interrupted") {
    lines.push(`Resumable: ${boundary.resumable ? "yes" : "no"}`);
  } else if (boundary.kind === "manual-intervention") {
    lines.push(`Manual recovery supported: no`, boundary.intervention.message);
  }

  if (boundary.artifacts.length > 0 && boundary.kind !== "approval-required") {
    lines.push("Artifacts:");
    for (const artifact of boundary.artifacts) {
      lines.push(`- ${artifact.name}: ${artifact.currentPath}`);
    }
  }

  return lines.join("\n");
}

function presentBoundary(boundary: RunBoundary): PresentedBoundary {
  if (boundary.kind !== "approval-required") {
    return structuredClone(boundary) as PresentedBoundary;
  }

  const artifact = boundary.approval.artifact;
  let presentedArtifact: Record<string, unknown> | undefined;

  if (artifact?.available === true) {
    const preview = truncateHead(artifact.content, {
      maxBytes: APPROVAL_ARTIFACT_MAX_BYTES,
      maxLines: APPROVAL_ARTIFACT_MAX_LINES,
    });
    const { content: _content, ...metadata } = artifact;
    presentedArtifact = {
      ...metadata,
      contentPreview: preview.content,
      contentTruncated: preview.truncated,
      totalLines: preview.totalLines,
      totalBytes: preview.totalBytes,
    };
  } else if (artifact !== undefined) {
    presentedArtifact = { ...artifact };
  }

  const { approval: _approval, ...base } = boundary;
  return {
    ...structuredClone(base),
    approval: {
      stepId: boundary.approval.stepId,
      message: boundary.approval.message,
      ...(boundary.approval.revisionTargetStepId === undefined
        ? {}
        : { revisionTargetStepId: boundary.approval.revisionTargetStepId }),
      allowedDecisions: [...boundary.approval.allowedDecisions],
      ...(presentedArtifact === undefined
        ? {}
        : { artifact: presentedArtifact }),
    },
  } as PresentedBoundary;
}

function presentRunView(view: RunView): PresentedRunView {
  const { boundary, ...base } = view;
  return {
    ...structuredClone(base),
    ...(boundary === undefined ? {} : { boundary: presentBoundary(boundary) }),
  };
}

function artifactResult(
  artifact: ArtifactView,
  startLine: number,
  maxLines: number,
): AgentToolResult<ArtifactDetails> {
  const lines = splitLines(artifact.content);
  const totalLines = lines.length;

  if (startLine > Math.max(1, totalLines)) {
    throw new Error(
      `startLine ${startLine} is beyond artifact line count ${totalLines}`,
    );
  }

  const startIndex = startLine - 1;
  const contentLineLimit = Math.min(maxLines, ARTIFACT_CONTENT_MAX_LINES);
  const requested = lines
    .slice(startIndex, startIndex + contentLineLimit)
    .join("\n");
  const preview = truncateHead(requested, {
    maxLines: contentLineLimit,
    maxBytes: ARTIFACT_CONTENT_MAX_BYTES,
  });
  const oversizedFirstLine = preview.firstLineExceedsLimit;
  const shownLines = oversizedFirstLine ? 1 : preview.outputLines;
  const shownEndLine =
    shownLines === 0 ? startLine - 1 : startLine + shownLines - 1;
  const hasMoreLines = shownEndLine < totalLines;
  const truncated = preview.truncated || hasMoreLines || oversizedFirstLine;
  const nextStartLine = hasMoreLines ? shownEndLine + 1 : undefined;
  const body = oversizedFirstLine
    ? `${truncateLine(lines[startIndex] ?? "", 1_000).text}\n[Line ${startLine} is only a preview because it exceeds the artifact byte limit.]`
    : preview.content;
  const output = [
    `Artifact: ${artifact.name}`,
    `Run: ${artifact.runId}`,
    `Path: ${artifact.path}`,
    `Showing lines ${startLine}-${shownEndLine} of ${totalLines}`,
    ...(truncated
      ? [`Next page: startLine ${nextStartLine ?? startLine}`]
      : []),
    "",
    body,
    ...(truncated
      ? [
          "",
          nextStartLine === undefined
            ? "[Artifact output truncated. The displayed line exceeds the per-call byte limit.]"
            : `[Artifact output truncated. Request startLine ${nextStartLine} with aira_artifact to continue.]`,
        ]
      : []),
  ].join("\n");
  const { content: _content, ...metadata } = artifact;
  return textResult(output, {
    kind: "artifact",
    artifact: metadata,
    preview: body,
    shownStartLine: startLine,
    shownEndLine,
    totalLines,
    truncated,
    ...(nextStartLine === undefined ? {} : { nextStartLine }),
  });
}

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  return content.split(/\r\n|\n|\r/);
}

function progressResult(
  progress: ProgressTracker,
  latestEvent?: AiraExecutionEvent,
): AgentToolResult<ProgressDetails> {
  return textResult(progress.render(), {
    kind: "progress",
    workflow: progress.workflow,
    ...(progress.runId === undefined ? {} : { runId: progress.runId }),
    ...(latestEvent === undefined ? {} : { latestEvent }),
  });
}

class ProgressTracker {
  readonly workflow: string;
  runId?: string;

  private readonly steps: ProgressStep[];
  private readonly activity: string[] = [];

  private constructor(workflow: string, steps: ProgressStep[], runId?: string) {
    this.workflow = workflow;
    this.steps = steps;
    this.runId = runId;
  }

  static fromPreview(preview: RunPreview): ProgressTracker {
    return new ProgressTracker(
      preview.workflow.name,
      previewStepsForProgress(preview.steps),
    );
  }

  static fromRunView(view: RunView): ProgressTracker {
    return new ProgressTracker(
      view.workflow,
      view.steps.map((step) => ({
        id: step.id,
        depth: step.parentStepId === undefined ? 0 : 1,
        status:
          step.status === "interrupted" ? "pending" : step.status,
      })),
      view.runId,
    );
  }

  accept(event: AiraExecutionEvent): void {
    if ("stepId" in event) {
      const step = this.steps.find((candidate) => candidate.id === event.stepId);

      if (step !== undefined) {
        switch (event.type) {
          case "step.started":
          case "agent.started":
          case "shell.started":
          case "loop.iteration.started":
            step.status = "running";
            break;
          case "step.completed":
            step.status = "completed";
            break;
          case "step.failed":
            step.status = "failed";
            break;
          case "step.skipped":
            step.status = "skipped";
            break;
          case "step.waiting":
          case "approval.waiting":
            step.status = "waiting";
            break;
        }
      }
    }

    const activity = progressActivity(event);

    if (activity !== undefined) {
      this.activity.push(activity);
      if (this.activity.length > 4) {
        this.activity.shift();
      }
    }
  }

  render(): string {
    const lines = [`Aira · ${this.workflow}`];
    const visibleSteps = this.steps.slice(0, 24);

    for (const step of visibleSteps) {
      lines.push(
        `${"  ".repeat(step.depth)}${progressSymbol(step.status)} ${step.id}`,
      );
    }

    if (this.steps.length > visibleSteps.length) {
      lines.push(`… ${this.steps.length - visibleSteps.length} more steps`);
    }

    for (const activity of this.activity) {
      lines.push(`  ${activity}`);
    }

    return lines.join("\n");
  }
}

function previewStepsForProgress(
  steps: readonly RunPreviewStep[],
  depth = 0,
): ProgressStep[] {
  return steps.flatMap((step) => [
    { id: step.id, depth, status: "pending" as const },
    ...(step.steps === undefined
      ? []
      : previewStepsForProgress(step.steps, depth + 1)),
  ]);
}

function progressSymbol(status: ProgressStep["status"]): string {
  switch (status) {
    case "completed":
      return "✓";
    case "running":
      return "◉";
    case "waiting":
      return "◆";
    case "failed":
      return "✗";
    case "skipped":
      return "-";
    case "pending":
      return "○";
  }
}

function progressActivity(event: AiraExecutionEvent): string | undefined {
  switch (event.type) {
    case "agent.tool.started":
      return event.summary ?? event.tool;
    case "shell.started":
      return `$ ${event.command}`;
    case "artifact.written":
      return `artifact ${event.artifact}`;
    case "step.retry":
      return `retry ${event.attempt}/${event.maxAttempts}`;
    case "agent.retry":
      return "worker retry";
    case "loop.iteration.started":
      return `iteration ${event.attempt}/${event.maxAttempts}`;
    default:
      return undefined;
  }
}

function renderAiraResult(
  result: AgentToolResult<AiraToolDetails>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
  context: Parameters<NonNullable<ToolDefinition["renderResult"]>>[3],
): Text {
  const details = result.details;
  const fallback = firstText(result);

  if (context.isError) {
    return new Text(theme.fg("error", fallback || "Aira tool failed"), 0, 0);
  }

  if (details?.kind === "preview") {
    const summary = theme.fg(
      "warning",
      `Review Aira start · ${details.preview.workflow.name} · ${flattenPreviewSteps(details.preview.steps).length} steps`,
    );
    return new Text(
      summary + (options.expanded ? `\n${theme.fg("dim", fallback)}` : ""),
      0,
      0,
    );
  }

  if (options.isPartial || details?.kind === "progress") {
    return new Text(theme.fg("warning", fallback || "Aira is working..."), 0, 0);
  }

  if (details === undefined) {
    return new Text(fallback, 0, 0);
  }

  switch (details.kind) {
    case "authorization":
      return new Text(theme.fg("warning", fallback), 0, 0);
    case "project": {
      const project = details.project;
      const title = project.initialized
        ? theme.fg("success", "✓ Aira project")
        : theme.fg("warning", "Aira is not initialized");
      const extra =
        options.expanded && project.initialized
          ? `\n${theme.fg("dim", `Root: ${project.root}`)}\n${theme.fg("muted", `Workflows: ${details.workflows.map((item) => item.name).join(", ") || "none"}`)}`
          : "";
      return new Text(title + extra, 0, 0);
    }
    case "status":
      return new Text(
        details.run === undefined
          ? theme.fg("dim", "No Aira run")
          : theme.fg("accent", `${details.run.workflow} · ${details.run.status}`) +
              (options.expanded ? `\n${theme.fg("dim", fallback)}` : ""),
        0,
        0,
      );
    case "boundary": {
      const color = boundaryColor(details.boundary.kind);
      const label =
        details.action === "revise"
          ? `revision submitted · ${details.boundary.kind}`
          : details.boundary.kind;
      let text = theme.fg(
        color,
        `${boundarySymbol(details.boundary.kind)} ${label}`,
      );
      text += " " + theme.fg("muted", details.boundary.runId);
      if (options.expanded) {
        text += `\n${theme.fg("dim", fallback)}`;
      }
      return new Text(text, 0, 0);
    }
    case "artifact": {
      let text = theme.fg(
        details.truncated ? "warning" : "success",
        `${details.artifact.name} · lines ${details.shownStartLine}-${details.shownEndLine}/${details.totalLines}`,
      );
      if (details.truncated) {
        text += theme.fg("warning", " truncated");
      }
      if (options.expanded) {
        const previewLines = details.preview.split("\n").slice(0, RENDER_PREVIEW_LINES);
        text += `\n${theme.fg("dim", previewLines.join("\n"))}`;
        if (details.preview.split("\n").length > previewLines.length) {
          text += `\n${theme.fg("muted", "… expand with another aira_artifact page")}`;
        }
      }
      return new Text(text, 0, 0);
    }
  }
}

function firstText(result: AgentToolResult<unknown>): string {
  const block = result.content.find((item) => item.type === "text");
  return block?.type === "text" ? block.text : "";
}

function boundaryColor(
  kind: PresentedBoundary["kind"],
): "success" | "warning" | "error" | "accent" {
  switch (kind) {
    case "completed":
      return "success";
    case "approval-required":
    case "interrupted":
    case "manual-intervention":
      return "warning";
    case "failed":
      return "error";
    case "cancelled":
      return "accent";
  }
}

function boundarySymbol(kind: PresentedBoundary["kind"]): string {
  switch (kind) {
    case "completed":
      return "✓";
    case "approval-required":
      return "◆";
    case "interrupted":
      return "!";
    case "manual-intervention":
      return "!";
    case "failed":
      return "✗";
    case "cancelled":
      return "○";
  }
}
