import { hashCanonical } from "../canonical-json";
import { canonical, compareText, exact } from "../spec/domain/primitives";
import {
  AGENTS_FILENAME,
  agentsObservationBytes,
  agentsObservationSchema,
  agentsScopeRootForSourcePath,
  agentsSourceIdentitySchema,
  agentsSourcePathSchema,
  type AgentsObservation,
} from "../steering-agents";
import { steeringInclusionSchema, steeringScopeSchema } from "../steering/applicability";
import { steeringResourceIdSchema, type SteeringResourceId } from "../steering/ids";
import { steeringProvenanceSchema, steeringResourceRevisionSchema } from "../steering/schema";
import type { SteeringProvenance, SteeringResourceRevision } from "../steering/types";
import {
  STEERING_AGENTS_IMPORT_MAPPING_SCHEMA,
  STEERING_AGENTS_IMPORT_ORDERING,
  STEERING_AGENTS_IMPORT_POLICY,
  agentsImportAdapterProfile,
  agentsImportPolicyPin,
  steeringAgentsImportMappingSchema,
  steeringAgentsImportObservationSchema,
  steeringAgentsImportSourceSchema,
  type SteeringAgentsImportFreshnessReason,
  type SteeringAgentsImportIssue,
  type SteeringAgentsImportMapping,
  type SteeringAgentsImportObservation,
  type SteeringAgentsImportPublicationAction,
  type SteeringAgentsImportSource,
} from "./types";

const importedMetadata = {
  title: "AGENTS.md interoperability guidance",
  description: "Exact imported AGENTS.md interoperability guidance.",
  labels: ["agents-md", "interoperability"],
} as const;

function sourceLocationResourceId(sourcePath: string, scopeRoot: string): SteeringResourceId {
  const path = agentsSourcePathSchema.parse(sourcePath);
  const expectedScope = agentsScopeRootForSourcePath(path);
  if (expectedScope === undefined || expectedScope !== scopeRoot)
    throw new TypeError("AGENTS import source path and scope do not agree");
  if (path === AGENTS_FILENAME) return steeringResourceIdSchema.parse("interop.steering.agents-md");
  const digest = hashCanonical({
    contract: STEERING_AGENTS_IMPORT_MAPPING_SCHEMA,
    policy: STEERING_AGENTS_IMPORT_POLICY,
    source_type: AGENTS_FILENAME,
    source_path: path,
    scope_root: scopeRoot,
  }).slice("sha256:".length);
  return steeringResourceIdSchema.parse(
    `interop.steering.agents-md.location-${digest.slice(0, 32)}.hash-${digest.slice(32)}`,
  );
}

/** Stable v1 logical identity for a validated AGENTS source location, never its bytes. */
export function steeringResourceIdForAgentsImport(input: {
  readonly source_path: string;
  readonly scope_root?: string;
}): SteeringResourceId {
  const path = agentsSourcePathSchema.parse(input.source_path);
  const scopeRoot = input.scope_root ?? agentsScopeRootForSourcePath(path);
  if (scopeRoot === undefined) throw new TypeError("Invalid AGENTS import source scope");
  return sourceLocationResourceId(path, scopeRoot);
}

/** Plan-safe exact descriptor for a fully validated 05C-4B1 observation. */
export function agentsImportObservationFor(value: AgentsObservation | unknown): SteeringAgentsImportObservation {
  const observation = agentsObservationSchema.parse(value) as AgentsObservation;
  // Parse first, including raw-byte hash validation, before intentionally
  // omitting the duplicate body bytes from the immutable import plan.
  agentsObservationBytes(observation);
  return steeringAgentsImportObservationSchema.parse({
    schema: observation.schema,
    discovery_policy: observation.discovery_policy,
    project: observation.project,
    control: observation.control,
    source_path: observation.source_path,
    source_identity: observation.source_identity,
    observation_identity: observation.observation_identity,
    scope: observation.scope,
    source: observation.source,
    content_encoding: observation.content_encoding,
    text_encoding: observation.text_encoding,
    filesystem: observation.filesystem,
    provenance: observation.provenance,
  }) as SteeringAgentsImportObservation;
}

function scopeFor(scopeRoot: string) {
  return scopeRoot === "." ? steeringScopeSchema.parse({ kind: "project-global" }) :
    steeringScopeSchema.parse({ kind: "path", selectors: [{ kind: "tree", path: scopeRoot }] });
}

function inclusionFor() {
  return steeringInclusionSchema.parse({ availability: "required", selector: { kind: "always" } });
}

/** Deterministic v1 source-location mapping and raw-guidance representation. */
export function mapAgentsImportObservation(value: AgentsObservation | unknown): SteeringAgentsImportMapping {
  const observation = agentsImportObservationFor(value);
  const resource = sourceLocationResourceId(observation.source_path, observation.scope.root);
  return steeringAgentsImportMappingSchema.parse({
    schema: STEERING_AGENTS_IMPORT_MAPPING_SCHEMA,
    policy: agentsImportPolicyPin,
    source_location: {
      source_type: AGENTS_FILENAME,
      source_path: observation.source_path,
      source_identity: observation.source_identity,
      scope_root: observation.scope.root,
    },
    resource,
    representation: {
      kind: "custom",
      custom_kind: "agents.interoperability",
      layer: "interoperability",
      default_authority: "normative",
      default_override_policy: "sealed",
      default_enforcement: [],
      rules: [],
      composition: { parents: [], overrides: [] },
      compatibility: { resolver: "aira.dev/steering-resolution/v1", required_schemas: [] },
      metadata: importedMetadata,
      behavioral_assets: [],
    },
    scope: scopeFor(observation.scope.root),
    inclusion: inclusionFor(),
    ordering: STEERING_AGENTS_IMPORT_ORDERING,
  }) as SteeringAgentsImportMapping;
}

/** Exact interoperability provenance retained by the ordinary Steering revision. */
export function agentsImportProvenanceFor(
  observationValue: AgentsObservation | unknown,
): SteeringProvenance {
  const observation = agentsImportObservationFor(observationValue);
  return steeringProvenanceSchema.parse({
    kind: "interoperability",
    source: {
      kind: "agents-md",
      source_identity: observation.source_identity,
      source_revision: observation.observation_identity,
      hash: observation.source.hash,
      adapter: agentsImportAdapterProfile,
      agents_observation: {
        schema: observation.schema,
        discovery_policy: observation.discovery_policy,
        project: observation.project,
        control: observation.control,
        source_path: observation.source_path,
        source_identity: observation.source_identity,
        observation_identity: observation.observation_identity,
        scope: observation.scope,
        source: observation.source,
        content_encoding: observation.content_encoding,
        text_encoding: observation.text_encoding,
        provenance: observation.provenance,
      },
      import_policy: agentsImportPolicyPin,
    },
  }) as SteeringProvenance;
}

/** Bind a reviewed observation, deterministic mapping, and retained provenance for planning. */
export function agentsImportSourceFor(value: AgentsObservation | unknown): SteeringAgentsImportSource {
  const observation = agentsImportObservationFor(value);
  return steeringAgentsImportSourceSchema.parse({
    observation,
    mapping: mapAgentsImportObservation(value),
    authoritative_provenance: agentsImportProvenanceFor(value),
  }) as SteeringAgentsImportSource;
}

function sourceAttribution(revision: SteeringResourceRevision) {
  if (revision.provenance.kind !== "interoperability" || revision.provenance.source.kind !== "agents-md") return undefined;
  return revision.provenance.source.agents_observation;
}

function mappingFromRevision(revision: SteeringResourceRevision): SteeringAgentsImportMapping | undefined {
  const attribution = sourceAttribution(revision);
  if (attribution === undefined) return undefined;
  try {
    const resource = sourceLocationResourceId(attribution.source_path, attribution.scope.root);
    return steeringAgentsImportMappingSchema.parse({
      schema: STEERING_AGENTS_IMPORT_MAPPING_SCHEMA,
      policy: agentsImportPolicyPin,
      source_location: {
        source_type: AGENTS_FILENAME,
        source_path: attribution.source_path,
        source_identity: attribution.source_identity,
        scope_root: attribution.scope.root,
      },
      resource,
      representation: {
        kind: "custom",
        custom_kind: "agents.interoperability",
        layer: "interoperability",
        default_authority: "normative",
        default_override_policy: "sealed",
        default_enforcement: [],
        rules: [],
        composition: { parents: [], overrides: [] },
        compatibility: { resolver: "aira.dev/steering-resolution/v1", required_schemas: [] },
        metadata: importedMetadata,
        behavioral_assets: [],
      },
      scope: scopeFor(attribution.scope.root),
      inclusion: inclusionFor(),
      ordering: STEERING_AGENTS_IMPORT_ORDERING,
    }) as SteeringAgentsImportMapping;
  } catch {
    return undefined;
  }
}

function issue(
  code: SteeringAgentsImportIssue["code"],
  resource?: SteeringResourceId,
  detail?: string,
): SteeringAgentsImportIssue {
  return {
    code,
    ...(resource === undefined ? {} : { resource }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * Verify that a persisted resource is the raw v1 AGENTS representation, not a
 * hand-authored interop resource that happens to share its logical namespace.
 */
export function validateAgentsImportRawResource(
  value: SteeringResourceRevision | unknown,
  expectedSource?: SteeringAgentsImportSource,
): readonly SteeringAgentsImportIssue[] {
  const parsed = steeringResourceRevisionSchema.safeParse(value);
  if (!parsed.success) return [issue("agents-import-mapping-conflict", undefined, "resource-schema-invalid")];
  const revision = parsed.data as SteeringResourceRevision;
  const issues: SteeringAgentsImportIssue[] = [];
  const attribution = sourceAttribution(revision);
  const mapping = mappingFromRevision(revision);
  if (attribution === undefined || mapping === undefined || revision.provenance.kind !== "interoperability" ||
    revision.provenance.source.kind !== "agents-md" || revision.provenance.source.import_policy === undefined ||
    !exact(revision.provenance.source.import_policy, agentsImportPolicyPin) ||
    !exact(revision.provenance.source.adapter, agentsImportAdapterProfile)) {
    issues.push(issue("agents-import-mapping-conflict", revision.identity.id, "missing-or-incompatible-v1-attribution"));
    return issues;
  }
  if (revision.identity.id !== mapping.resource || revision.kind !== mapping.representation.kind ||
    revision.custom_kind !== mapping.representation.custom_kind || revision.layer !== mapping.representation.layer ||
    revision.content_encoding !== "aira.dev/steering-bytes/raw/v1" || !exact(revision.metadata, mapping.representation.metadata) ||
    !exact(revision.scope, mapping.scope) || !exact(revision.inclusion, mapping.inclusion) ||
    !exact(revision.composition, mapping.representation.composition) ||
    !exact(revision.compatibility, mapping.representation.compatibility) ||
    !exact(revision.behavioral_assets, mapping.representation.behavioral_assets))
    issues.push(issue("agents-import-mapping-conflict", revision.identity.id, "raw-guidance-representation-mismatch"));
  if (revision.default_authority === "enforceable" || revision.default_authority !== mapping.representation.default_authority ||
    revision.default_override_policy !== mapping.representation.default_override_policy)
    issues.push(issue("agents-import-authority-invalid", revision.identity.id, "raw-agents-authority-ceiling"));
  if (revision.default_enforcement.length > 0 || revision.rules.some((rule) => rule.enforcement.length > 0))
    issues.push(issue("agents-import-enforcement-forbidden", revision.identity.id, "raw-agents-has-enforcement"));
  if (revision.rules.length > 0)
    issues.push(issue("agents-import-mapping-conflict", revision.identity.id, "synthetic-structured-rules-forbidden"));
  if (revision.provenance.source.hash !== revision.content.hash ||
    revision.provenance.source.agents_observation?.source.hash !== revision.content.hash ||
    revision.provenance.source.agents_observation?.source.bytes !== revision.content.bytes)
    issues.push(issue("agents-import-mapping-conflict", revision.identity.id, "body-attribution-mismatch"));
  if (expectedSource !== undefined && (!exact(revision.provenance, expectedSource.authoritative_provenance) ||
    revision.identity.id !== expectedSource.mapping.resource || revision.content.hash !== expectedSource.observation.source.hash ||
    revision.content.bytes !== expectedSource.observation.source.bytes))
    issues.push(issue("agents-import-mapping-conflict", revision.identity.id, "expected-source-mismatch"));
  return [...new Map(issues.map((value) => [canonical(value), value])).values()]
    .sort((left, right) => compareText(canonical(left), canonical(right)));
}

/** Construct an ordinary immutable Steering revision from one planned raw AGENTS action. */
export function constructSteeringAgentsImportRevision(
  action: SteeringAgentsImportPublicationAction,
  created: SteeringResourceRevision["created"],
): SteeringResourceRevision {
  const { mapping, observation, authoritative_provenance: provenance } = action.source;
  const revision = steeringResourceRevisionSchema.parse({
    schema: "aira.dev/steering-resource/v1",
    identity: action.next,
    kind: mapping.representation.kind,
    custom_kind: mapping.representation.custom_kind,
    layer: mapping.representation.layer,
    provenance,
    content: observation.source,
    content_encoding: "aira.dev/steering-bytes/raw/v1",
    default_authority: mapping.representation.default_authority,
    default_override_policy: mapping.representation.default_override_policy,
    default_enforcement: mapping.representation.default_enforcement,
    inclusion: mapping.inclusion,
    scope: mapping.scope,
    rules: mapping.representation.rules,
    composition: mapping.representation.composition,
    compatibility: mapping.representation.compatibility,
    metadata: mapping.representation.metadata,
    created,
    behavioral_assets: mapping.representation.behavioral_assets,
    ...(action.kind === "update" ? { supersedes: action.supersedes } : {}),
  }) as SteeringResourceRevision;
  const issues = validateAgentsImportRawResource(revision, action.source);
  if (issues.length) throw new TypeError(`Invalid raw AGENTS import revision: ${JSON.stringify(issues)}`);
  return revision;
}

export interface AgentsImportObservationComparison {
  readonly status: "match" | "stale" | "invalid";
  readonly reasons: readonly SteeringAgentsImportFreshnessReason[];
}

/** Exact 05C-4B1 freshness comparison against the plan-safe observation projection. */
export function compareAgentsImportObservation(
  reviewedValue: SteeringAgentsImportObservation | unknown,
  currentValue: AgentsObservation | unknown,
): AgentsImportObservationComparison {
  const reviewedResult = steeringAgentsImportObservationSchema.safeParse(reviewedValue);
  if (!reviewedResult.success) return { status: "invalid", reasons: ["agents-observation-invalid"] };
  const currentResult = agentsObservationSchema.safeParse(currentValue);
  if (!currentResult.success) return { status: "invalid", reasons: ["agents-observation-invalid"] };
  const reviewed = reviewedResult.data as SteeringAgentsImportObservation;
  const current = currentResult.data as AgentsObservation;
  const reasons: SteeringAgentsImportFreshnessReason[] = [];
  if (reviewed.discovery_policy !== current.discovery_policy) reasons.push("discovery-policy-incompatible");
  if (reviewed.project !== current.project || reviewed.control.root !== current.control.root) reasons.push("project-changed");
  if (reviewed.source_path !== current.source_path) reasons.push("source-path-changed");
  if (reviewed.source_identity !== current.source_identity) reasons.push("source-identity-changed");
  if (!exact(reviewed.source, current.source)) reasons.push("bytes-changed");
  if (!exact(reviewed.scope, current.scope)) reasons.push("scope-root-changed");
  if (!exact(reviewed.provenance, current.provenance)) reasons.push("provenance-changed");
  if (reviewed.filesystem.kind !== current.filesystem.kind ||
    (reviewed.filesystem.kind === "filesystem" && current.filesystem.kind === "filesystem" &&
      (reviewed.filesystem.device !== current.filesystem.device || reviewed.filesystem.inode !== current.filesystem.inode)))
    reasons.push("source-replaced");
  if (reviewed.observation_identity !== current.observation_identity)
    reasons.push("observation-identity-changed");
  const stable = [...new Set(reasons)].sort(compareText);
  return { status: stable.length ? "stale" : "match", reasons: stable };
}

export interface AgentsImportedGuidanceLocation {
  readonly source_path: string;
  readonly scope_root: string;
  readonly depth: number;
}

/** Metadata-only ordering aid for a future Context layer. It grants no rule precedence. */
export function agentsImportedGuidanceLocation(value: SteeringResourceRevision | unknown): AgentsImportedGuidanceLocation | undefined {
  const parsed = steeringResourceRevisionSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const attribution = sourceAttribution(parsed.data as SteeringResourceRevision);
  if (attribution === undefined) return undefined;
  return {
    source_path: attribution.source_path,
    scope_root: attribution.scope.root,
    depth: attribution.scope.depth,
  };
}

/** Broadest-to-nearest AGENTS presentation ordering only, never semantic override order. */
export function compareAgentsImportedGuidance(
  left: SteeringResourceRevision | unknown,
  right: SteeringResourceRevision | unknown,
): number {
  const leftLocation = agentsImportedGuidanceLocation(left);
  const rightLocation = agentsImportedGuidanceLocation(right);
  if (leftLocation === undefined || rightLocation === undefined)
    throw new TypeError("Imported AGENTS guidance attribution is required for ordering");
  return leftLocation.depth - rightLocation.depth || compareText(leftLocation.scope_root, rightLocation.scope_root) ||
    compareText(leftLocation.source_path, rightLocation.source_path);
}
