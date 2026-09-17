import { canonicalJSON, hashBytes, hashCanonical } from "../canonical-json";
import { exact } from "../spec/domain/primitives";
import {
  steeringProjectNamespaceSchema,
  steeringResourceRevisionSchema,
  type SteeringResourceRevisionValue,
} from "../steering/schema";
import type { SteeringResourceRevision } from "../steering/types";
import {
  parseNativeSteeringSource,
  steeringSourceMetadataSchema,
  steeringSourcePathSchema,
  steeringSourceProposalSchema,
  type SteeringSourceMetadata,
  type SteeringSourceParseSuccess,
  type SteeringSourceProposal,
} from "../steering-source";
import {
  STEERING_MATERIALIZATION_RENDERER_CONTRACT,
  materializationSourceDescriptorSchema,
  type MaterializationSourceDescriptor,
  type SteeringMaterializationIssue,
} from "./types";

const encoder = new TextEncoder();

export interface RenderNativeSteeringSourceInput {
  readonly project: string;
  readonly target_path: string;
  readonly revision: SteeringResourceRevision | unknown;
  /** Exact immutable raw body bytes loaded from the authoritative BlobStore. */
  readonly body: Uint8Array;
}

export interface RenderNativeSteeringSourceSuccess {
  readonly ok: true;
  readonly contract: typeof STEERING_MATERIALIZATION_RENDERER_CONTRACT;
  readonly bytes: Uint8Array;
  readonly source: MaterializationSourceDescriptor;
  readonly parsed: SteeringSourceParseSuccess;
  readonly authorable_semantics_hash: string;
}

export interface RenderNativeSteeringSourceFailure {
  readonly ok: false;
  readonly issue: SteeringMaterializationIssue;
}

export type RenderNativeSteeringSourceResult = RenderNativeSteeringSourceSuccess | RenderNativeSteeringSourceFailure;

function sourceCompatibleRevision(
  project: string,
  revision: SteeringResourceRevisionValue,
): string | undefined {
  if (revision.provenance.kind !== "project" || revision.provenance.project !== project)
    return "project-provenance-required";
  if (revision.layer !== "project-root" && revision.layer !== "project-scoped")
    return "native-project-layer-required";
  if (!/^(?:steering|project\.steering)\./.test(revision.identity.id))
    return "native-project-resource-id-required";
  return undefined;
}

/**
 * The source format owns source locations but not their body hash. The adapter
 * derives that hash from newly rendered bytes when it reparses the source.
 */
function authorableRule(rule: SteeringResourceRevisionValue["rules"][number]): unknown {
  const { source, ...rest } = rule;
  return source === undefined ? rest : { ...rest, source: { location: source.location } };
}

function authorableProvenance(provenance: SteeringResourceRevisionValue["provenance"]): unknown {
  if (provenance.kind !== "project") return provenance;
  return {
    kind: "project",
    project: provenance.project,
    authorship: provenance.authorship,
    ...(provenance.adopted_from === undefined ? {} : { adopted_from: provenance.adopted_from }),
  };
}

/**
 * Exact semantic projection that native source can author. Publication-owned
 * revision allocation, creation metadata, predecessor history, native file
 * observation, and rule body hashes are intentionally excluded.
 */
export function authorableSteeringRevisionProjection(value: SteeringResourceRevision | unknown): unknown {
  const parsed = steeringResourceRevisionSchema.parse(value);
  return {
    id: parsed.identity.id,
    kind: parsed.kind,
    ...(parsed.custom_kind === undefined ? {} : { custom_kind: parsed.custom_kind }),
    layer: parsed.layer,
    provenance: authorableProvenance(parsed.provenance),
    content: parsed.content,
    content_encoding: parsed.content_encoding,
    default_authority: parsed.default_authority,
    default_override_policy: parsed.default_override_policy,
    default_enforcement: parsed.default_enforcement,
    inclusion: parsed.inclusion,
    scope: parsed.scope,
    rules: parsed.rules.map(authorableRule),
    composition: parsed.composition,
    compatibility: parsed.compatibility,
    metadata: parsed.metadata,
    behavioral_assets: parsed.behavioral_assets,
  };
}

/** The equivalent projection after the existing 05C-4A1 parser derives rule hashes. */
export function authorableSteeringProposalProjection(value: SteeringSourceProposal | unknown): unknown {
  const parsed = steeringSourceProposalSchema.parse(value);
  return {
    id: parsed.identity.id,
    kind: parsed.kind,
    ...(parsed.custom_kind === undefined ? {} : { custom_kind: parsed.custom_kind }),
    layer: parsed.layer,
    provenance: authorableProvenance(parsed.provenance),
    content: parsed.content,
    content_encoding: parsed.content_encoding,
    default_authority: parsed.default_authority,
    default_override_policy: parsed.default_override_policy,
    default_enforcement: parsed.default_enforcement,
    inclusion: parsed.inclusion,
    scope: parsed.scope,
    rules: parsed.rules.map(authorableRule),
    composition: parsed.composition,
    compatibility: parsed.compatibility,
    metadata: parsed.metadata,
    behavioral_assets: parsed.behavioral_assets,
  };
}

export function authorableSteeringSemanticsHash(value: SteeringResourceRevision | unknown): string {
  return hashCanonical(authorableSteeringRevisionProjection(value));
}

export function authorableSteeringSemanticsMatch(
  revision: SteeringResourceRevision | unknown,
  proposal: SteeringSourceProposal | unknown,
): boolean {
  try {
    return exact(authorableSteeringRevisionProjection(revision), authorableSteeringProposalProjection(proposal));
  } catch {
    return false;
  }
}

/** Deterministic JSON is valid YAML 1.2 and avoids YAML-emitter ordering ambiguity. */
export function nativeSteeringSourceMetadata(
  project: string,
  value: SteeringResourceRevision | unknown,
): SteeringSourceMetadata {
  const revision = steeringResourceRevisionSchema.parse(value);
  const compatibility = sourceCompatibleRevision(project, revision);
  if (compatibility !== undefined) throw new Error(compatibility);
  const provenance = revision.provenance;
  if (provenance.kind !== "project") throw new Error("project-provenance-required");
  return steeringSourceMetadataSchema.parse({
    schema: "aira.dev/steering-source/v1",
    id: revision.identity.id,
    kind: revision.kind,
    ...(revision.custom_kind === undefined ? {} : { custom_kind: revision.custom_kind }),
    layer: revision.layer,
    provenance: {
      authorship: provenance.authorship,
      ...(provenance.adopted_from === undefined ? {} : { adopted_from: provenance.adopted_from }),
    },
    authority: revision.default_authority,
    override_policy: revision.default_override_policy,
    enforcement: revision.default_enforcement,
    inclusion: revision.inclusion,
    scope: revision.scope,
    rules: revision.rules.map((rule) => ({
      id: rule.id,
      title: rule.title,
      authority: rule.authority,
      semantics: rule.semantics,
      override_policy: rule.override_policy,
      status: rule.status,
      ...(rule.scope === undefined ? {} : { scope: rule.scope }),
      ...(rule.inclusion === undefined ? {} : { inclusion: rule.inclusion }),
      ...(rule.rationale === undefined ? {} : { rationale: rule.rationale }),
      enforcement: rule.enforcement,
      ...(rule.source === undefined ? {} : { source: { location: rule.source.location } }),
    })),
    composition: revision.composition,
    compatibility: revision.compatibility,
    title: revision.metadata.title,
    ...(revision.metadata.description === undefined ? {} : { description: revision.metadata.description }),
    labels: revision.metadata.labels,
    behavioral_assets: revision.behavioral_assets,
  }) as SteeringSourceMetadata;
}

function forbiddenInteroperabilityTarget(path: string): boolean {
  return path.split("/").at(-1) === ["AGENTS", "md"].join(".");
}

function concatenate(prefix: Uint8Array, body: Uint8Array): Uint8Array {
  const result = new Uint8Array(prefix.length + body.length);
  result.set(prefix); result.set(body, prefix.length);
  return result;
}

/**
 * Render one exact authoritative revision as native v1 source. Only framing is
 * generated. `body` is appended as opaque bytes without decoding or rewriting.
 */
export function renderNativeSteeringSource(input: RenderNativeSteeringSourceInput): RenderNativeSteeringSourceResult {
  const targetPath = typeof input?.target_path === "string" ? input.target_path : "<invalid>";
  if (!steeringProjectNamespaceSchema.safeParse(input?.project).success)
    return { ok: false, issue: { code: "materialization-render-invalid", target_path: targetPath as never, detail: "project" } };
  if (!steeringSourcePathSchema.safeParse(targetPath).success || forbiddenInteroperabilityTarget(targetPath))
    return { ok: false, issue: { code: "materialization-render-invalid", detail: "target-path" } };
  if (!(input?.body instanceof Uint8Array))
    return { ok: false, issue: { code: "materialization-render-invalid", target_path: targetPath as never, detail: "body-bytes" } };

  let revision: SteeringResourceRevisionValue;
  try { revision = steeringResourceRevisionSchema.parse(input.revision); }
  catch { return { ok: false, issue: { code: "materialization-render-invalid", target_path: targetPath as never, detail: "revision" } }; }
  const compatibility = sourceCompatibleRevision(input.project, revision);
  if (compatibility !== undefined || (revision.kind === "custom" && !targetPath.startsWith(".aira/steering/custom/"))) return { ok: false, issue: {
    code: "materialization-render-invalid", resource: revision.identity.id, target_path: targetPath as never,
    detail: compatibility ?? "custom-target-outside-custom-root",
  } };

  const body = Uint8Array.from(input.body);
  if (hashBytes(body) !== revision.content.hash || body.length !== revision.content.bytes || revision.identity.hash !== revision.content.hash)
    return { ok: false, issue: {
      code: "materialization-render-invalid", resource: revision.identity.id, target_path: targetPath as never, detail: "authoritative-body-mismatch",
    } };

  let metadata: SteeringSourceMetadata;
  try { metadata = nativeSteeringSourceMetadata(input.project, revision); }
  catch { return { ok: false, issue: {
    code: "materialization-render-invalid", resource: revision.identity.id, target_path: targetPath as never, detail: "metadata-conversion",
  } }; }

  // JSON is an explicitly supported YAML 1.2 subset. canonicalJSON fixes every
  // key order, scalar spelling, whitespace choice, and UTF-8 framing byte.
  const framing = encoder.encode(`---\n${canonicalJSON({ aira: metadata })}\n---\n`);
  const bytes = concatenate(framing, body);
  const source = materializationSourceDescriptorSchema.parse({
    hash: hashBytes(bytes), bytes: bytes.length, media_type: "text/markdown; charset=utf-8",
  }) as MaterializationSourceDescriptor;
  const parsed = parseNativeSteeringSource({ project: input.project, source_path: targetPath, bytes });
  if (!parsed.ok) return { ok: false, issue: {
    code: "materialization-render-invalid", resource: revision.identity.id, target_path: targetPath as never,
    detail: parsed.issues[0]?.code ?? "native-parser",
  } };
  if (parsed.observation.source.hash !== source.hash || parsed.observation.source.bytes !== source.bytes ||
    parsed.observation.body.hash !== revision.content.hash || parsed.observation.body.bytes !== revision.content.bytes ||
    !authorableSteeringSemanticsMatch(revision, parsed.proposal)) return { ok: false, issue: {
    code: "materialization-roundtrip-mismatch", resource: revision.identity.id, target_path: targetPath as never,
  } };

  return {
    ok: true,
    contract: STEERING_MATERIALIZATION_RENDERER_CONTRACT,
    bytes,
    source,
    parsed,
    authorable_semantics_hash: authorableSteeringSemanticsHash(revision),
  };
}

export const renderAuthoritativeSteeringNativeSource = renderNativeSteeringSource;
export const renderSteeringNativeSource = renderNativeSteeringSource;
