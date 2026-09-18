import { z } from "zod";
import { hashBytes, hashCanonical } from "../canonical-json";
import { canonical, compareText, contentHashSchema, safeUnsignedSchema, type ContentHash, type DeepReadonly } from "../spec/domain/primitives";

export const STEERING_AGENTS_OBSERVATION_SCHEMA = "aira.dev/steering-agents-observation/v1" as const;
export const STEERING_AGENTS_FILE_OBSERVATION_SCHEMA = "aira.dev/steering-agents-file-observation/v1" as const;
export const STEERING_AGENTS_INSPECTION_SCHEMA = "aira.dev/steering-agents-inspection/v1" as const;
export const STEERING_AGENTS_APPLICABILITY_SCHEMA = "aira.dev/steering-agents-applicability/v1" as const;
export const STEERING_AGENTS_DISCOVERY_POLICY = "aira.dev/steering-agents-discovery/v1" as const;
export const STEERING_AGENTS_PROVENANCE_SCHEMA = "aira.dev/steering-agents-provenance/v1" as const;
export const STEERING_AGENTS_SOURCE_IDENTITY_CONTRACT = "aira.dev/steering-agents-source-identity/v1" as const;
export const STEERING_AGENTS_OBSERVATION_IDENTITY_CONTRACT = "aira.dev/steering-agents-observation-identity/v1" as const;
export const STEERING_AGENTS_CONTENT_ENCODING = "aira.dev/steering-bytes/raw/v1" as const;
export const STEERING_AGENTS_MEDIA_TYPE = "text/markdown; charset=utf-8" as const;
export const STEERING_AGENTS_TEXT_ENCODING = "utf-8" as const;
export const AGENTS_FILENAME = "AGENTS.md" as const;

/**
 * Fixed v1 limits for read-only interoperability discovery. They deliberately
 * bound traversal and bytes without turning gitignore into an authority source.
 */
export const agentsInteropDiscoveryPolicy = Object.freeze({
  contract: STEERING_AGENTS_DISCOVERY_POLICY,
  root: "." as const,
  filename: AGENTS_FILENAME,
  case_sensitive: true,
  excluded_directories: Object.freeze([".git", ".aira", "node_modules", "vendor"] as const),
  max_files: 256,
  max_file_bytes: 1_048_576,
  max_aggregate_bytes: 8_388_608,
  max_traversal_depth: 32,
  max_entries_per_directory: 1_024,
  max_total_entries: 4_096,
  max_logical_path_bytes: 1_024,
  read_chunk_bytes: 65_536,
  ordering: "source-path-codepoint" as const,
});

const decimalSchema = z.string().regex(/^(0|[1-9][0-9]*)$/, "invalid-agents-filesystem-decimal");
const positiveLinksSchema = safeUnsignedSchema.refine((value) => value > 0, "invalid-agents-link-count");

/** Matches the existing portable project/control namespace grammar without importing a Steering source type. */
export const agentsProjectIdentitySchema = z.string().max(63)
  .regex(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "invalid-agents-project-identity");

function validLogicalPath(value: string): boolean {
  return value.length > 0 && value.length <= agentsInteropDiscoveryPolicy.max_logical_path_bytes &&
    new TextEncoder().encode(value).length <= agentsInteropDiscoveryPolicy.max_logical_path_bytes &&
    !value.startsWith("/") && !value.includes("\\") && !value.includes(":") &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Portable, logical project-relative path grammar. No filesystem lookup occurs here. */
export const agentsLogicalPathSchema = z.string().refine(validLogicalPath, "invalid-agents-logical-path");
export const agentsTargetPathSchema = agentsLogicalPathSchema;
export const agentsScopeRootSchema = z.union([z.literal("."), agentsLogicalPathSchema]);
export const agentsSourcePathSchema = agentsLogicalPathSchema.refine((value) =>
  value.split("/").at(-1) === AGENTS_FILENAME, "invalid-agents-source-path");

export function agentsScopeRootForSourcePath(sourcePath: string): string | undefined {
  if (!agentsSourcePathSchema.safeParse(sourcePath).success) return undefined;
  const parts = sourcePath.split("/");
  parts.pop();
  return parts.length === 0 ? "." : parts.join("/");
}

export function agentsScopeDepth(scopeRoot: string): number {
  return scopeRoot === "." ? 0 : scopeRoot.split("/").length;
}

export const agentsScopeSchema = z.strictObject({
  root: agentsScopeRootSchema,
  depth: safeUnsignedSchema,
}).superRefine((value, ctx) => {
  if (value.depth !== agentsScopeDepth(value.root))
    ctx.addIssue({ code: "custom", path: ["depth"], message: "agents-scope-depth-mismatch" });
});

export const agentsContentDescriptorSchema = z.strictObject({
  hash: contentHashSchema,
  bytes: safeUnsignedSchema,
  media_type: z.literal(STEERING_AGENTS_MEDIA_TYPE),
});

export const agentsFilesystemObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("filesystem"),
    device: decimalSchema,
    inode: decimalSchema,
    links: positiveLinksSchema,
    mode: safeUnsignedSchema,
    size: safeUnsignedSchema,
    modified_ns: decimalSchema,
    changed_ns: decimalSchema,
  }),
  z.strictObject({
    kind: z.literal("detached"),
    size: safeUnsignedSchema,
  }),
]);

export const agentsSourceIdentitySchema = z.string()
  .regex(/^agents_source_[a-f0-9]{64}$/, "invalid-agents-source-identity")
  .brand<"AgentsSourceIdentity">();
export const agentsObservationIdentitySchema = z.string()
  .regex(/^agents_observation_[a-f0-9]{64}$/, "invalid-agents-observation-identity")
  .brand<"AgentsObservationIdentity">();

export type AgentsSourceIdentity = z.infer<typeof agentsSourceIdentitySchema>;
export type AgentsObservationIdentity = z.infer<typeof agentsObservationIdentitySchema>;

function sourceIdentityValue(project: string, sourcePath: string, scopeRoot: string): AgentsSourceIdentity {
  const hash = hashCanonical({
    contract: STEERING_AGENTS_SOURCE_IDENTITY_CONTRACT,
    project,
    control: { root: "." },
    source_type: AGENTS_FILENAME,
    source_path: sourcePath,
    scope_root: scopeRoot,
  });
  return agentsSourceIdentitySchema.parse(`agents_source_${hash.slice("sha256:".length)}`);
}

function observationIdentityValue(
  sourceIdentity: AgentsSourceIdentity,
  source: Readonly<{ hash: ContentHash; bytes: number; media_type: typeof STEERING_AGENTS_MEDIA_TYPE }>,
): AgentsObservationIdentity {
  const hash = hashCanonical({
    contract: STEERING_AGENTS_OBSERVATION_IDENTITY_CONTRACT,
    discovery_policy: STEERING_AGENTS_DISCOVERY_POLICY,
    source_identity: sourceIdentity,
    source,
    content_encoding: STEERING_AGENTS_CONTENT_ENCODING,
    text_encoding: STEERING_AGENTS_TEXT_ENCODING,
  });
  return agentsObservationIdentitySchema.parse(`agents_observation_${hash.slice("sha256:".length)}`);
}

/** A source identity names a project-relative AGENTS location, never a Steering resource. */
export function agentsSourceIdentityFor(input: {
  readonly project: string;
  readonly source_path: string;
  readonly scope_root?: string;
}): AgentsSourceIdentity {
  const project = agentsProjectIdentitySchema.parse(input.project);
  const sourcePath = agentsSourcePathSchema.parse(input.source_path);
  const scopeRoot = input.scope_root ?? agentsScopeRootForSourcePath(sourcePath);
  if (scopeRoot === undefined || !agentsScopeRootSchema.safeParse(scopeRoot).success ||
    scopeRoot !== agentsScopeRootForSourcePath(sourcePath)) throw new TypeError("Invalid AGENTS source scope");
  return sourceIdentityValue(project, sourcePath, scopeRoot);
}

/** An observation identity changes with exact observed bytes and source location, not mtime or inode. */
export function agentsObservationIdentityFor(input: {
  readonly source_identity: AgentsSourceIdentity;
  readonly source: Readonly<{ hash: ContentHash; bytes: number; media_type: typeof STEERING_AGENTS_MEDIA_TYPE }>;
}): AgentsObservationIdentity {
  return observationIdentityValue(agentsSourceIdentitySchema.parse(input.source_identity), agentsContentDescriptorSchema.parse(input.source));
}

const rawBytesSchema = z.instanceof(Uint8Array);

export const agentsInteropProvenanceSchema = z.strictObject({
  schema: z.literal(STEERING_AGENTS_PROVENANCE_SCHEMA),
  kind: z.literal("interoperability"),
  source_type: z.literal(AGENTS_FILENAME),
  source_path: agentsSourcePathSchema,
  source_hash: contentHashSchema,
  scope_root: agentsScopeRootSchema,
  discovery_policy: z.literal(STEERING_AGENTS_DISCOVERY_POLICY),
});

export const agentsFileObservationSchema = z.strictObject({
  schema: z.literal(STEERING_AGENTS_FILE_OBSERVATION_SCHEMA),
  discovery_policy: z.literal(STEERING_AGENTS_DISCOVERY_POLICY),
  project: agentsProjectIdentitySchema,
  control: z.strictObject({ root: z.literal(".") }),
  source_path: agentsSourcePathSchema,
  source_identity: agentsSourceIdentitySchema,
  scope: agentsScopeSchema,
  source: agentsContentDescriptorSchema,
  content_encoding: z.literal(STEERING_AGENTS_CONTENT_ENCODING),
  /** Detached exact bytes. Use agentsObservationBytes to receive a fresh copy. */
  raw_bytes: rawBytesSchema,
  filesystem: agentsFilesystemObservationSchema,
  provenance: agentsInteropProvenanceSchema,
}).superRefine((value, ctx) => {
  const expectedScope = agentsScopeRootForSourcePath(value.source_path);
  if (expectedScope === undefined || value.scope.root !== expectedScope)
    ctx.addIssue({ code: "custom", path: ["scope", "root"], message: "agents-source-scope-mismatch" });
  else if (value.source_identity !== sourceIdentityValue(value.project, value.source_path, expectedScope))
    ctx.addIssue({ code: "custom", path: ["source_identity"], message: "agents-source-identity-mismatch" });
  if (value.source.bytes !== value.raw_bytes.length || value.source.hash !== hashBytes(value.raw_bytes))
    ctx.addIssue({ code: "custom", path: ["source"], message: "agents-source-bytes-mismatch" });
  if (value.filesystem.size !== value.source.bytes)
    ctx.addIssue({ code: "custom", path: ["filesystem", "size"], message: "agents-filesystem-size-mismatch" });
  if (value.provenance.source_path !== value.source_path || value.provenance.source_hash !== value.source.hash ||
    value.provenance.scope_root !== value.scope.root || value.provenance.discovery_policy !== value.discovery_policy)
    ctx.addIssue({ code: "custom", path: ["provenance"], message: "agents-provenance-mismatch" });
});

export const agentsObservationSchema = z.strictObject({
  schema: z.literal(STEERING_AGENTS_OBSERVATION_SCHEMA),
  discovery_policy: z.literal(STEERING_AGENTS_DISCOVERY_POLICY),
  project: agentsProjectIdentitySchema,
  control: z.strictObject({ root: z.literal(".") }),
  source_path: agentsSourcePathSchema,
  source_identity: agentsSourceIdentitySchema,
  observation_identity: agentsObservationIdentitySchema,
  scope: agentsScopeSchema,
  source: agentsContentDescriptorSchema,
  content_encoding: z.literal(STEERING_AGENTS_CONTENT_ENCODING),
  /** Detached exact bytes. Use agentsObservationBytes to receive a fresh copy. */
  raw_bytes: rawBytesSchema,
  text_encoding: z.literal(STEERING_AGENTS_TEXT_ENCODING),
  filesystem: agentsFilesystemObservationSchema,
  provenance: agentsInteropProvenanceSchema,
}).superRefine((value, ctx) => {
  const fileResult = agentsFileObservationSchema.safeParse({
    schema: STEERING_AGENTS_FILE_OBSERVATION_SCHEMA,
    discovery_policy: value.discovery_policy,
    project: value.project,
    control: value.control,
    source_path: value.source_path,
    source_identity: value.source_identity,
    scope: value.scope,
    source: value.source,
    content_encoding: value.content_encoding,
    raw_bytes: value.raw_bytes,
    filesystem: value.filesystem,
    provenance: value.provenance,
  });
  if (!fileResult.success)
    ctx.addIssue({ code: "custom", message: "agents-file-observation-invalid" });
  const expectedIdentity = observationIdentityValue(value.source_identity, value.source);
  if (value.observation_identity !== expectedIdentity)
    ctx.addIssue({ code: "custom", path: ["observation_identity"], message: "agents-observation-identity-mismatch" });
  if (value.provenance.source_path !== value.source_path || value.provenance.source_hash !== value.source.hash ||
    value.provenance.scope_root !== value.scope.root || value.provenance.discovery_policy !== value.discovery_policy)
    ctx.addIssue({ code: "custom", path: ["provenance"], message: "agents-provenance-mismatch" });
});

export const agentsInteropIssueCodes = [
  "agents-input-invalid",
  "agents-project-invalid",
  "agents-root-unsafe",
  "agents-root-missing",
  "agents-source-unsafe",
  "agents-source-unreadable",
  "agents-path-invalid",
  "agents-invalid-utf8",
  "agents-nul-content",
  "agents-file-too-large",
  "agents-aggregate-too-large",
  "agents-file-limit",
  "agents-depth-limit",
  "agents-entry-limit",
  "agents-discovery-incomplete",
  "agents-duplicate-observation",
  "agents-observation-stale",
  "agents-observation-invalid",
] as const;
export type AgentsInteropIssueCode = typeof agentsInteropIssueCodes[number];

export const agentsInteropIssueSchema = z.strictObject({
  code: z.enum(agentsInteropIssueCodes),
  severity: z.enum(["error", "warning"]),
  path: z.string().optional(),
  related_paths: z.array(z.string()).optional(),
  detail: z.string().optional(),
});

export type AgentsContentDescriptor = DeepReadonly<z.infer<typeof agentsContentDescriptorSchema>>;
export type AgentsFilesystemObservation = DeepReadonly<z.infer<typeof agentsFilesystemObservationSchema>>;
export type AgentsFileObservation = DeepReadonly<z.infer<typeof agentsFileObservationSchema>>;
export type AgentsInteropProvenance = DeepReadonly<z.infer<typeof agentsInteropProvenanceSchema>>;
export type AgentsObservation = DeepReadonly<z.infer<typeof agentsObservationSchema>>;
/** Exact non-authoritative input that 05C-4B2 must revalidate before any import. */
export type AgentsInteropProposal = AgentsObservation;
export const agentsInteropProposalSchema = agentsObservationSchema;
export type AgentsInteropIssue = DeepReadonly<z.infer<typeof agentsInteropIssueSchema>>;

export interface AgentsRejectedSource {
  readonly source_path: string;
  readonly file?: AgentsFileObservation;
  readonly diagnostics: readonly AgentsInteropIssue[];
}

export interface AgentsSkippedSubtree {
  readonly path: string;
  readonly reason: "policy-excluded";
}

export interface AgentsInteropInspection {
  readonly schema: typeof STEERING_AGENTS_INSPECTION_SCHEMA;
  readonly status: "valid" | "invalid";
  /** False only when bounded traversal or safe read could not complete. */
  readonly complete: boolean;
  /** Presence state of the root-level AGENTS.md, not the project directory. */
  readonly root_status: "present" | "missing" | "unsafe" | "unreadable";
  readonly discovery_policy: typeof agentsInteropDiscoveryPolicy;
  readonly project: string;
  readonly control: Readonly<{ root: "." }>;
  readonly observations: readonly AgentsObservation[];
  readonly rejected_sources: readonly AgentsRejectedSource[];
  readonly unsafe_paths: readonly AgentsInteropIssue[];
  readonly skipped_subtrees: readonly AgentsSkippedSubtree[];
  readonly diagnostics: readonly AgentsInteropIssue[];
}

export interface InspectAgentsInteropOptions {
  readonly project: string;
}

export interface ObserveAgentsSourceInput {
  readonly project: string;
  readonly source_path: string;
  readonly bytes: Uint8Array;
  readonly filesystem?: AgentsFilesystemObservation;
}

export interface AgentsSourceObservationSuccess {
  readonly ok: true;
  readonly observation: AgentsObservation;
}

export interface AgentsSourceObservationFailure {
  readonly ok: false;
  readonly source_path: string;
  readonly file?: AgentsFileObservation;
  readonly diagnostics: readonly AgentsInteropIssue[];
}

export type AgentsSourceObservationResult = AgentsSourceObservationSuccess | AgentsSourceObservationFailure;

export const agentsObservationChangeReasons = [
  "agents-observation-invalid",
  "discovery-policy-incompatible",
  "project-changed",
  "source-path-changed",
  "source-identity-changed",
  "bytes-changed",
  "scope-root-changed",
  "provenance-changed",
  "source-replaced",
] as const;
export type AgentsObservationChangeReason = typeof agentsObservationChangeReasons[number];

export interface AgentsObservationComparison {
  readonly status: "match" | "stale" | "invalid";
  readonly reasons: readonly AgentsObservationChangeReason[];
}

export interface AgentsApplicableObservation {
  readonly observation: AgentsObservation;
  readonly scope_root: string;
  /** Directory-segment depth. Greater means structurally nearer to the target. */
  readonly specificity: number;
}

export interface AgentsTargetApplicability {
  readonly target_path: string;
  /** Ordered broadest to nearest under AGENTS.md convention only. */
  readonly applicable: readonly AgentsApplicableObservation[];
}

export interface AgentsPathSpecificGuidance {
  readonly observation: AgentsObservation;
  readonly target_paths: readonly string[];
}

export interface AgentsApplicabilityResult {
  readonly schema: typeof STEERING_AGENTS_APPLICABILITY_SCHEMA;
  readonly status: "resolved" | "invalid";
  readonly target_paths: readonly string[];
  readonly targets: readonly AgentsTargetApplicability[];
  readonly common_observations: readonly AgentsApplicableObservation[];
  readonly path_specific_guidance: readonly AgentsPathSpecificGuidance[];
  readonly diagnostics: readonly AgentsInteropIssue[];
}

export function stableAgentsIssues(issues: readonly AgentsInteropIssue[]): AgentsInteropIssue[] {
  return [...new Map(issues.map((issue) => [canonical(issue), issue])).values()]
    .sort((left, right) => compareText(canonical(left), canonical(right)));
}

/** Return a fresh byte copy and verify that it still matches the observation descriptor. */
export function agentsObservationBytes(value: AgentsObservation | unknown): Uint8Array {
  const parsed = agentsObservationSchema.parse(value);
  return Uint8Array.from(parsed.raw_bytes);
}

/** Return a fresh byte copy for a rejected or valid low-level file observation. */
export function agentsFileObservationBytes(value: AgentsFileObservation | unknown): Uint8Array {
  const parsed = agentsFileObservationSchema.parse(value);
  return Uint8Array.from(parsed.raw_bytes);
}
