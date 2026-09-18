import { compareText } from "../spec/domain/primitives";
import {
  STEERING_AGENTS_APPLICABILITY_SCHEMA,
  agentsObservationSchema,
  agentsScopeDepth,
  agentsTargetPathSchema,
  stableAgentsIssues,
  type AgentsApplicableObservation,
  type AgentsApplicabilityResult,
  type AgentsInteropIssue,
  type AgentsObservation,
  type AgentsPathSpecificGuidance,
  type AgentsTargetApplicability,
} from "./types";

function issue(
  code: AgentsInteropIssue["code"],
  path: string,
  detail?: string,
  relatedPaths?: readonly string[],
): AgentsInteropIssue {
  return {
    code,
    severity: "error",
    path,
    ...(relatedPaths === undefined ? {} : { related_paths: [...relatedPaths] }),
    ...(detail === undefined ? {} : { detail }),
  };
}

function freezeData<T>(value: T): T {
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

function appliesToScope(scopeRoot: string, targetPath: string): boolean {
  return scopeRoot === "." || targetPath === scopeRoot || targetPath.startsWith(`${scopeRoot}/`);
}

function entryFor(observation: AgentsObservation): AgentsApplicableObservation {
  return {
    observation,
    scope_root: observation.scope.root,
    specificity: agentsScopeDepth(observation.scope.root),
  };
}

function compareApplicable(left: AgentsApplicableObservation, right: AgentsApplicableObservation): number {
  return left.specificity - right.specificity || compareText(left.scope_root, right.scope_root) ||
    compareText(left.observation.source_path, right.observation.source_path);
}

function normalizeObservations(value: unknown): {
  readonly observations: readonly AgentsObservation[];
  readonly diagnostics: readonly AgentsInteropIssue[];
} {
  if (!Array.isArray(value)) return { observations: [], diagnostics: [issue("agents-observation-invalid", ".", "observations-not-array")] };
  const observations: AgentsObservation[] = [];
  const diagnostics: AgentsInteropIssue[] = [];
  for (const candidate of value) {
    const parsed = agentsObservationSchema.safeParse(candidate);
    if (!parsed.success) {
      diagnostics.push(issue("agents-observation-invalid", ".", "observation-schema"));
      continue;
    }
    observations.push(parsed.data as AgentsObservation);
  }
  observations.sort((left, right) => compareText(left.source_path, right.source_path));

  const bySource = new Map<string, AgentsObservation[]>();
  for (const observation of observations) {
    const grouped = bySource.get(observation.source_identity) ?? [];
    grouped.push(observation);
    bySource.set(observation.source_identity, grouped);
  }
  for (const grouped of bySource.values()) if (grouped.length > 1) {
    const paths = [...new Set(grouped.map((observation) => observation.source_path))].sort(compareText);
    diagnostics.push(issue("agents-duplicate-observation", paths[0] ?? ".", "source-location", paths));
  }

  const projects = [...new Set(observations.map((observation) => observation.project))].sort(compareText);
  if (projects.length > 1)
    diagnostics.push(issue("agents-observation-invalid", ".", "mixed-project-observations", projects));
  return { observations, diagnostics: stableAgentsIssues(diagnostics) };
}

function normalizeTargets(value: unknown): {
  readonly target_paths: readonly string[];
  readonly diagnostics: readonly AgentsInteropIssue[];
} {
  if (!Array.isArray(value)) return { target_paths: [], diagnostics: [issue("agents-path-invalid", ".", "target-paths-not-array")] };
  if (value.length === 0) return { target_paths: [], diagnostics: [issue("agents-path-invalid", ".", "empty-target-path-set")] };
  const targets: string[] = [];
  const diagnostics: AgentsInteropIssue[] = [];
  for (const target of value) {
    if (typeof target !== "string" || !agentsTargetPathSchema.safeParse(target).success) {
      diagnostics.push(issue("agents-path-invalid", typeof target === "string" ? target : ".", "invalid-target-path"));
      continue;
    }
    targets.push(target);
  }
  const sorted = [...targets].sort(compareText);
  for (let index = 1; index < sorted.length; index++) if (sorted[index - 1] === sorted[index])
    diagnostics.push(issue("agents-path-invalid", sorted[index]!, "duplicate-target-path"));
  return {
    target_paths: [...new Set(sorted)],
    diagnostics: stableAgentsIssues(diagnostics),
  };
}

/**
 * Pure lexical AGENTS scope evaluation. It never checks whether a target path
 * exists and never assigns Steering authority or interprets Markdown prose.
 */
export function resolveAgentsApplicability(
  observationsValue: readonly AgentsObservation[] | unknown,
  targetPathsValue: readonly string[] | unknown,
): AgentsApplicabilityResult {
  const observations = normalizeObservations(observationsValue);
  const targets = normalizeTargets(targetPathsValue);
  const diagnostics = stableAgentsIssues([...observations.diagnostics, ...targets.diagnostics]);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return freezeData({
    schema: STEERING_AGENTS_APPLICABILITY_SCHEMA,
    status: "invalid" as const,
    target_paths: targets.target_paths,
    targets: [],
    common_observations: [],
    path_specific_guidance: [],
    diagnostics,
  });

  const targetResults: AgentsTargetApplicability[] = targets.target_paths.map((targetPath) => ({
    target_path: targetPath,
    applicable: observations.observations.filter((observation) => appliesToScope(observation.scope.root, targetPath))
      .map(entryFor)
      .sort(compareApplicable),
  }));

  const targetPathsByObservation = new Map<string, { entry: AgentsApplicableObservation; targets: string[] }>();
  for (const target of targetResults) for (const applicable of target.applicable) {
    const key = applicable.observation.observation_identity;
    const grouped = targetPathsByObservation.get(key) ?? { entry: applicable, targets: [] };
    grouped.targets.push(target.target_path);
    targetPathsByObservation.set(key, grouped);
  }
  const groups = [...targetPathsByObservation.values()].map((group) => ({
    entry: group.entry,
    targets: [...new Set(group.targets)].sort(compareText),
  })).sort((left, right) => compareApplicable(left.entry, right.entry));

  const common = groups.filter((group) => group.targets.length === targetResults.length).map((group) => group.entry);
  const specific: AgentsPathSpecificGuidance[] = groups.filter((group) => group.targets.length !== targetResults.length)
    .map((group) => ({ observation: group.entry.observation, target_paths: group.targets }));

  return freezeData({
    schema: STEERING_AGENTS_APPLICABILITY_SCHEMA,
    status: "resolved" as const,
    target_paths: targets.target_paths,
    targets: targetResults,
    common_observations: common,
    path_specific_guidance: specific,
    diagnostics,
  });
}
