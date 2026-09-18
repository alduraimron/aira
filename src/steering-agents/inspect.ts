import { hashBytes } from "../canonical-json";
import { canonical, compareText } from "../spec/domain/primitives";
import { discoverAgentsInterop } from "./discovery";
import {
  AGENTS_FILENAME,
  STEERING_AGENTS_CONTENT_ENCODING,
  STEERING_AGENTS_FILE_OBSERVATION_SCHEMA,
  STEERING_AGENTS_INSPECTION_SCHEMA,
  STEERING_AGENTS_MEDIA_TYPE,
  STEERING_AGENTS_OBSERVATION_SCHEMA,
  STEERING_AGENTS_PROVENANCE_SCHEMA,
  STEERING_AGENTS_TEXT_ENCODING,
  agentsFileObservationSchema,
  agentsInteropDiscoveryPolicy,
  agentsObservationIdentityFor,
  agentsObservationSchema,
  agentsProjectIdentitySchema,
  agentsScopeDepth,
  agentsScopeRootForSourcePath,
  agentsSourceIdentityFor,
  agentsSourcePathSchema,
  stableAgentsIssues,
  type AgentsFileObservation,
  type AgentsInteropInspection,
  type AgentsInteropIssue,
  type AgentsObservation,
  type AgentsObservationChangeReason,
  type AgentsRejectedSource,
  type AgentsObservationComparison,
  type AgentsSourceObservationFailure,
  type AgentsSourceObservationResult,
  type InspectAgentsInteropOptions,
  type ObserveAgentsSourceInput,
} from "./types";

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function issue(
  code: AgentsInteropIssue["code"],
  path: string,
  severity: "error" | "warning" = "error",
  detail?: string,
): AgentsInteropIssue {
  return { code, severity, path, ...(detail === undefined ? {} : { detail }) };
}

function freezeData<T>(value: T): T {
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

function failed(
  sourcePath: string,
  diagnostics: readonly AgentsInteropIssue[],
  file?: AgentsFileObservation,
): AgentsSourceObservationFailure {
  return freezeData({
    ok: false as const,
    source_path: sourcePath,
    ...(file === undefined ? {} : { file }),
    diagnostics: stableAgentsIssues(diagnostics),
  });
}

/**
 * Build one exact AGENTS observation from caller-owned bytes. This validates
 * encoding only. It intentionally does not inspect Markdown, frontmatter, or prose.
 */
export function observeAgentsSource(input: ObserveAgentsSourceInput): AgentsSourceObservationResult {
  const sourcePath = typeof input?.source_path === "string" ? input.source_path : "<invalid>";
  if (!input || !(input.bytes instanceof Uint8Array))
    return failed(sourcePath, [issue("agents-input-invalid", sourcePath, "error", "bytes")]);
  const bytes = Uint8Array.from(input.bytes);
  if (!agentsProjectIdentitySchema.safeParse(input.project).success)
    return failed(sourcePath, [issue("agents-project-invalid", sourcePath)]);
  if (!agentsSourcePathSchema.safeParse(sourcePath).success)
    return failed(sourcePath, [issue("agents-path-invalid", sourcePath)]);
  if (bytes.length > agentsInteropDiscoveryPolicy.max_file_bytes)
    return failed(sourcePath, [issue("agents-file-too-large", sourcePath)]);

  const scopeRoot = agentsScopeRootForSourcePath(sourcePath);
  if (scopeRoot === undefined)
    return failed(sourcePath, [issue("agents-path-invalid", sourcePath)]);
  const filesystem = input.filesystem ?? { kind: "detached" as const, size: bytes.length };
  if (filesystem.size !== bytes.length)
    return failed(sourcePath, [issue("agents-input-invalid", sourcePath, "error", "filesystem-size")]);

  const source = {
    hash: hashBytes(bytes),
    bytes: bytes.length,
    media_type: STEERING_AGENTS_MEDIA_TYPE,
  } as const;
  const sourceIdentity = agentsSourceIdentityFor({
    project: input.project,
    source_path: sourcePath,
    scope_root: scopeRoot,
  });
  const provenance = {
    schema: STEERING_AGENTS_PROVENANCE_SCHEMA,
    kind: "interoperability" as const,
    source_type: AGENTS_FILENAME,
    source_path: sourcePath,
    source_hash: source.hash,
    scope_root: scopeRoot,
    discovery_policy: agentsInteropDiscoveryPolicy.contract,
  };
  const fileResult = agentsFileObservationSchema.safeParse({
    schema: STEERING_AGENTS_FILE_OBSERVATION_SCHEMA,
    discovery_policy: agentsInteropDiscoveryPolicy.contract,
    project: input.project,
    control: { root: "." },
    source_path: sourcePath,
    source_identity: sourceIdentity,
    scope: { root: scopeRoot, depth: agentsScopeDepth(scopeRoot) },
    source,
    content_encoding: STEERING_AGENTS_CONTENT_ENCODING,
    raw_bytes: bytes,
    filesystem,
    provenance,
  });
  if (!fileResult.success)
    return failed(sourcePath, [issue("agents-input-invalid", sourcePath, "error", "file-observation")]);
  const file = freezeData(fileResult.data as AgentsFileObservation);

  if (bytes.includes(0))
    return failed(sourcePath, [issue("agents-nul-content", sourcePath, "error", "nul-byte")], file);
  try { fatalUtf8.decode(bytes); }
  catch { return failed(sourcePath, [issue("agents-invalid-utf8", sourcePath)], file); }

  const observationResult = agentsObservationSchema.safeParse({
    schema: STEERING_AGENTS_OBSERVATION_SCHEMA,
    discovery_policy: agentsInteropDiscoveryPolicy.contract,
    project: input.project,
    control: { root: "." },
    source_path: sourcePath,
    source_identity: sourceIdentity,
    observation_identity: agentsObservationIdentityFor({ source_identity: sourceIdentity, source }),
    scope: { root: scopeRoot, depth: agentsScopeDepth(scopeRoot) },
    source,
    content_encoding: STEERING_AGENTS_CONTENT_ENCODING,
    raw_bytes: bytes,
    text_encoding: STEERING_AGENTS_TEXT_ENCODING,
    filesystem,
    provenance,
  });
  if (!observationResult.success)
    return failed(sourcePath, [issue("agents-observation-invalid", sourcePath, "error", "observation-conversion")], file);
  return freezeData({ ok: true as const, observation: observationResult.data as AgentsObservation });
}

function finalInspection(value: Omit<AgentsInteropInspection, "status">): AgentsInteropInspection {
  const status = value.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "invalid" as const : "valid" as const;
  return freezeData({ ...value, status });
}

function invalidInspection(project: string, diagnostics: readonly AgentsInteropIssue[]): AgentsInteropInspection {
  return finalInspection({
    schema: STEERING_AGENTS_INSPECTION_SCHEMA,
    complete: false,
    root_status: "unsafe",
    discovery_policy: agentsInteropDiscoveryPolicy,
    project,
    control: { root: "." },
    observations: [],
    rejected_sources: [],
    unsafe_paths: [],
    skipped_subtrees: [],
    diagnostics: stableAgentsIssues([...diagnostics, issue("agents-discovery-incomplete", ".")]),
  });
}

/**
 * Read-only exact AGENTS.md inspection from one explicit trusted project root.
 * It does not access a Steering store, resolver, Context, worker, or writer.
 */
export async function inspectAgentsInterop(
  projectRoot: string,
  options: InspectAgentsInteropOptions,
): Promise<AgentsInteropInspection> {
  const project = typeof options?.project === "string" ? options.project : "<invalid>";
  if (!agentsProjectIdentitySchema.safeParse(project).success)
    return invalidInspection(project, [issue("agents-project-invalid", ".")]);

  const discovered = await discoverAgentsInterop(projectRoot);
  const observations: AgentsObservation[] = [];
  const rejected: AgentsRejectedSource[] = [];
  const diagnostics: AgentsInteropIssue[] = [...discovered.diagnostics];
  if (discovered.root_status === "missing")
    diagnostics.push(issue("agents-root-missing", AGENTS_FILENAME, "warning"));

  for (const file of discovered.files) {
    const result = observeAgentsSource({
      project,
      source_path: file.source_path,
      bytes: file.bytes,
      filesystem: file.filesystem,
    });
    if (result.ok) observations.push(result.observation);
    else {
      rejected.push({
        source_path: result.source_path,
        ...(result.file === undefined ? {} : { file: result.file }),
        diagnostics: result.diagnostics,
      });
      diagnostics.push(...result.diagnostics);
    }
  }

  observations.sort((left, right) => compareText(left.source_path, right.source_path));
  rejected.sort((left, right) => compareText(left.source_path, right.source_path) ||
    compareText(canonical(left.diagnostics), canonical(right.diagnostics)));
  return finalInspection({
    schema: STEERING_AGENTS_INSPECTION_SCHEMA,
    complete: discovered.complete,
    root_status: discovered.root_status,
    discovery_policy: agentsInteropDiscoveryPolicy,
    project,
    control: { root: "." },
    observations,
    rejected_sources: rejected,
    unsafe_paths: discovered.unsafe_paths,
    skipped_subtrees: discovered.skipped_subtrees,
    diagnostics: stableAgentsIssues(diagnostics),
  });
}

function stableReasons(reasons: readonly AgentsObservationChangeReason[]): AgentsObservationChangeReason[] {
  return [...new Set(reasons)].sort(compareText);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function rawChanged(reviewed: AgentsObservation, current: unknown): AgentsObservationChangeReason[] {
  const value = record(current);
  if (value === undefined) return [];
  const reasons: AgentsObservationChangeReason[] = [];
  if (typeof value.discovery_policy === "string" && value.discovery_policy !== reviewed.discovery_policy)
    reasons.push("discovery-policy-incompatible");
  if (typeof value.project === "string" && value.project !== reviewed.project)
    reasons.push("project-changed");
  if (typeof value.source_path === "string" && value.source_path !== reviewed.source_path)
    reasons.push("source-path-changed");
  if (typeof value.source_identity === "string" && value.source_identity !== reviewed.source_identity)
    reasons.push("source-identity-changed");
  const source = record(value.source);
  if (source !== undefined && (source.hash !== reviewed.source.hash || source.bytes !== reviewed.source.bytes ||
    source.media_type !== reviewed.source.media_type)) reasons.push("bytes-changed");
  const scope = record(value.scope);
  if (scope !== undefined && (scope.root !== reviewed.scope.root || scope.depth !== reviewed.scope.depth))
    reasons.push("scope-root-changed");
  const provenance = record(value.provenance);
  if (provenance !== undefined && canonical(provenance) !== canonical(reviewed.provenance))
    reasons.push("provenance-changed");
  const filesystem = record(value.filesystem);
  if (filesystem !== undefined && (filesystem.kind !== reviewed.filesystem.kind ||
    (filesystem.kind === "filesystem" && reviewed.filesystem.kind === "filesystem" &&
      (filesystem.device !== reviewed.filesystem.device || filesystem.inode !== reviewed.filesystem.inode))))
    reasons.push("source-replaced");
  return stableReasons(reasons);
}

/**
 * Pure reviewed-observation freshness comparison. It compares exact bytes and
 * source location, while treating timestamps as diagnostics rather than identity.
 */
export function compareAgentsObservation(
  reviewedValue: AgentsObservation | unknown,
  currentValue: AgentsObservation | unknown,
): AgentsObservationComparison {
  const reviewedResult = agentsObservationSchema.safeParse(reviewedValue);
  if (!reviewedResult.success) return Object.freeze({
    status: "invalid" as const,
    reasons: Object.freeze(["agents-observation-invalid" as const]),
  });
  const reviewed = reviewedResult.data as AgentsObservation;
  const currentResult = agentsObservationSchema.safeParse(currentValue);
  if (!currentResult.success) {
    const changed = rawChanged(reviewed, currentValue);
    if (changed.length > 0) return Object.freeze({ status: "stale" as const, reasons: Object.freeze(changed) });
    return Object.freeze({
      status: "invalid" as const,
      reasons: Object.freeze(["agents-observation-invalid" as const]),
    });
  }
  const current = currentResult.data as AgentsObservation;
  const reasons: AgentsObservationChangeReason[] = [];
  if (reviewed.discovery_policy !== current.discovery_policy) reasons.push("discovery-policy-incompatible");
  if (reviewed.project !== current.project || reviewed.control.root !== current.control.root) reasons.push("project-changed");
  if (reviewed.source_path !== current.source_path) reasons.push("source-path-changed");
  if (reviewed.source_identity !== current.source_identity) reasons.push("source-identity-changed");
  if (reviewed.source.hash !== current.source.hash || reviewed.source.bytes !== current.source.bytes ||
    reviewed.source.media_type !== current.source.media_type) reasons.push("bytes-changed");
  if (reviewed.scope.root !== current.scope.root || reviewed.scope.depth !== current.scope.depth)
    reasons.push("scope-root-changed");
  if (canonical(reviewed.provenance) !== canonical(current.provenance)) reasons.push("provenance-changed");
  if (reviewed.filesystem.kind !== current.filesystem.kind ||
    (reviewed.filesystem.kind === "filesystem" && current.filesystem.kind === "filesystem" &&
      (reviewed.filesystem.device !== current.filesystem.device || reviewed.filesystem.inode !== current.filesystem.inode)))
    reasons.push("source-replaced");
  const stable = Object.freeze(stableReasons(reasons));
  return Object.freeze({ status: stable.length === 0 ? "match" as const : "stale" as const, reasons: stable });
}

export function agentsObservationMatches(
  reviewed: AgentsObservation | unknown,
  current: AgentsObservation | unknown,
): boolean {
  return compareAgentsObservation(reviewed, current).status === "match";
}
