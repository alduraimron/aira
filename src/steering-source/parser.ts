import { isAlias, parseDocument, visit } from "yaml";
import type { ZodIssue } from "zod";
import { canonicalJSON, hashBytes, hashCanonical } from "../canonical-json";
import { canonical, compareText, exact } from "../spec/domain/primitives";
import { steeringProjectNamespaceSchema, steeringResourceRevisionSchema } from "../steering/schema";
import type { SteeringRule } from "../steering/types";
import {
  STEERING_NATIVE_DISCOVERY_POLICY,
  STEERING_SOURCE_CONTENT_ENCODING,
  STEERING_SOURCE_FILE_OBSERVATION_SCHEMA,
  STEERING_SOURCE_MEDIA_TYPE,
  STEERING_SOURCE_OBSERVATION_SCHEMA,
  STEERING_SOURCE_PROPOSAL_SCHEMA,
  STEERING_SOURCE_ROOT,
  STEERING_SOURCE_SCHEMA,
  conventionalSteeringSourceIds,
  nativeSteeringDiscoveryPolicy,
  steeringSourceFileObservationSchema,
  steeringSourceFilesystemObservationSchema,
  steeringSourceFrontmatterSchema,
  steeringSourceObservationSchema,
  steeringSourcePathSchema,
  steeringSourceProposalSchema,
  type ParseNativeSteeringSourceInput,
  type SteeringSourceFileObservation,
  type SteeringSourceIssue,
  type SteeringSourceMetadata,
  type SteeringSourceParseFailure,
  type SteeringSourceParseResult,
  type SteeringSourceParseSuccess,
} from "./contract";

const fatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function stableIssues(issues: readonly SteeringSourceIssue[]): SteeringSourceIssue[] {
  return [...new Map(issues.map((issue) => [canonical(issue), issue])).values()]
    .sort((left, right) => compareText(canonical(left), canonical(right)));
}

function freezeData<T>(value: T): T {
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

function detached<T>(value: T): T {
  return freezeData(JSON.parse(canonicalJSON(value)) as T);
}

function failure(
  sourcePath: string,
  issues: readonly SteeringSourceIssue[],
  file?: SteeringSourceFileObservation,
  warnings: readonly SteeringSourceIssue[] = [],
): SteeringSourceParseFailure {
  return freezeData({
    ok: false as const,
    source_path: sourcePath,
    ...(file === undefined ? {} : { file }),
    issues: stableIssues(issues),
    warnings: stableIssues(warnings),
  });
}

interface FramedSource {
  readonly frontmatter: Uint8Array;
  readonly body: Uint8Array;
}

/** Delimiter lines may use LF or CRLF independently. Their exact bytes are framing, not body. */
function frameSource(bytes: Uint8Array): FramedSource | undefined {
  if (bytes.length < 4 || bytes[0] !== 0x2d || bytes[1] !== 0x2d || bytes[2] !== 0x2d) return undefined;
  let openingEnd: number;
  if (bytes[3] === 0x0a) openingEnd = 4;
  else if (bytes[3] === 0x0d && bytes[4] === 0x0a) openingEnd = 5;
  else return undefined;

  let lineStart = openingEnd;
  while (lineStart <= bytes.length) {
    let newline = lineStart;
    while (newline < bytes.length && bytes[newline] !== 0x0a) newline++;
    const hasNewline = newline < bytes.length;
    const contentEnd = hasNewline && newline > lineStart && bytes[newline - 1] === 0x0d ? newline - 1 : newline;
    if (contentEnd - lineStart === 3 && bytes[lineStart] === 0x2d && bytes[lineStart + 1] === 0x2d && bytes[lineStart + 2] === 0x2d) {
      const bodyStart = hasNewline ? newline + 1 : newline;
      return {
        frontmatter: bytes.slice(openingEnd, lineStart),
        body: bytes.slice(bodyStart),
      };
    }
    if (!hasNewline) break;
    lineStart = newline + 1;
  }
  return undefined;
}

function structureWithinLimits(value: unknown): boolean {
  let nodes = 0;
  const active = new Set<object>();
  const visitValue = (item: unknown, depth: number): boolean => {
    if (++nodes > nativeSteeringDiscoveryPolicy.max_metadata_nodes || depth > nativeSteeringDiscoveryPolicy.max_metadata_depth)
      return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "string") return item.length <= 16_384;
    if (typeof item === "number") return Number.isFinite(item) && !Object.is(item, -0);
    if (typeof item !== "object" || active.has(item)) return false;
    const prototype = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    active.add(item);
    const valid = Object.values(item).every((child) => visitValue(child, depth + 1));
    active.delete(item);
    return valid;
  };
  return visitValue(value, 0);
}

function yamlDocument(source: string): { value?: unknown; issues: SteeringSourceIssue[] } {
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source, {
      schema: "core",
      version: "1.2",
      customTags: [],
      merge: false,
      resolveKnownTags: false,
      uniqueKeys: true,
      stringKeys: true,
      strict: true,
      prettyErrors: false,
    });
  } catch {
    return { issues: [{ code: "steering-source-yaml-invalid", severity: "error", detail: "parser-failure" }] };
  }
  const issues: SteeringSourceIssue[] = [];
  for (const error of document.errors) issues.push({
    code: "steering-source-yaml-invalid",
    severity: "error",
    detail: error.code === "DUPLICATE_KEY" ? "duplicate-key" : error.code === "MULTIPLE_DOCS" ? "multiple-documents" : "syntax",
  });
  for (const warning of document.warnings) issues.push({
    code: "steering-source-yaml-feature-forbidden",
    severity: "error",
    detail: warning.code === "TAG_RESOLVE_FAILED" ? "custom-or-unknown-tag" : "yaml-warning",
  });

  let forbidden = false;
  try {
    visit(document, {
      Alias: () => { forbidden = true; },
      Node: (_key, node) => {
        if (!isAlias(node) && typeof node === "object" && node !== null && "anchor" in node && node.anchor !== undefined)
          forbidden = true;
      },
    });
  } catch {
    return { issues: [{ code: "steering-source-metadata-limit", severity: "error", detail: "yaml-depth" }] };
  }
  if (forbidden) issues.push({
    code: "steering-source-yaml-feature-forbidden",
    severity: "error",
    detail: "anchors-or-aliases",
  });
  if (issues.length) return { issues: stableIssues(issues) };
  try {
    return { value: document.toJS({ maxAliasCount: 0 }), issues: [] };
  } catch {
    return { issues: [{ code: "steering-source-yaml-feature-forbidden", severity: "error", detail: "alias-expansion" }] };
  }
}

function formatField(path: readonly PropertyKey[]): string | undefined {
  if (!path.length) return undefined;
  return path.map((part, index) => typeof part === "number" ? `[${part}]` : `${index === 0 ? "" : "."}${String(part)}`).join("");
}

function metadataIssues(issues: readonly ZodIssue[]): SteeringSourceIssue[] {
  const result: SteeringSourceIssue[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) result.push({
        code: "steering-source-unknown-field",
        severity: "error",
        field: formatField([...issue.path, key]),
      });
      continue;
    }
    const field = formatField(issue.path);
    const path = issue.path.map(String);
    const code = path.includes("rules") ? "steering-source-rule-invalid" :
      path.includes("kind") || path.includes("custom_kind") ? "steering-source-kind-invalid" :
      path.includes("authority") || path.includes("enforcement") || issue.message.includes("steering-binding") ||
        issue.message.includes("enforceable-steering") ? "steering-source-authority-invalid" :
      "steering-source-metadata-invalid";
    const detail = /^[a-z][a-z0-9-]*$/.test(issue.message) ? issue.message : "schema";
    result.push({ code, severity: "error", ...(field === undefined ? {} : { field }), detail });
  }
  return stableIssues(result);
}

function bodyLineCount(body: Uint8Array): number {
  if (body.length === 0) return 0;
  let lines = 1;
  for (const byte of body) if (byte === 0x0a) lines++;
  if (body[body.length - 1] === 0x0a) lines--;
  return lines;
}

function sourceLocationIssues(rules: readonly SteeringRule[], body: Uint8Array): SteeringSourceIssue[] {
  const lines = bodyLineCount(body), issues: SteeringSourceIssue[] = [];
  for (const rule of rules) if (rule.source?.location.kind === "line-range" &&
    (rule.source.location.start > lines || rule.source.location.end > lines)) issues.push({
      code: "steering-source-rule-location-invalid",
      severity: "error",
      field: `rules.${rule.id}.source.location`,
      detail: "line-range-outside-body",
    });
  return issues;
}

function conventionalWarning(path: string, metadata: SteeringSourceMetadata): SteeringSourceIssue[] {
  const relative = path.slice(`${STEERING_SOURCE_ROOT}/`.length);
  if (relative.includes("/")) return [];
  const expected = conventionalSteeringSourceIds[relative as keyof typeof conventionalSteeringSourceIds];
  if (expected === undefined || expected === metadata.id) return [];
  return [{
    code: "steering-source-conventional-name-mismatch",
    severity: "warning",
    path,
    resource_id: metadata.id,
    detail: expected,
  }];
}

/**
 * Parse exact caller bytes into a detached source proposal. This function has no
 * filesystem, registry, resolver, clock, or publication side effects.
 */
export function parseNativeSteeringSource(input: ParseNativeSteeringSourceInput): SteeringSourceParseResult {
  const sourcePath = typeof input?.source_path === "string" ? input.source_path : "<invalid>";
  if (!input || !(input.bytes instanceof Uint8Array)) return failure(sourcePath, [{
    code: "steering-source-input-invalid", severity: "error", detail: "bytes",
  }]);
  const bytes = Uint8Array.from(input.bytes);
  if (bytes.length > nativeSteeringDiscoveryPolicy.max_file_bytes) return failure(sourcePath, [{
    code: "steering-source-file-size-limit", severity: "error", path: sourcePath,
  }]);
  if (!steeringProjectNamespaceSchema.safeParse(input.project).success) return failure(sourcePath, [{
    code: "steering-source-project-invalid", severity: "error", path: sourcePath,
  }]);
  if (!steeringSourcePathSchema.safeParse(sourcePath).success) return failure(sourcePath, [{
    code: "steering-source-path-invalid", severity: "error", path: sourcePath,
  }]);

  const pathParts = sourcePath.slice(`${STEERING_SOURCE_ROOT}/`.length).split("/");
  const custom = pathParts[0] === nativeSteeringDiscoveryPolicy.custom_directory;
  if ((custom && (pathParts.length < 2 || pathParts.length - 2 > nativeSteeringDiscoveryPolicy.custom_max_depth)) ||
    (!custom && pathParts.length !== 1)) return failure(sourcePath, [{
      code: "steering-source-path-invalid", severity: "error", path: sourcePath,
      detail: custom ? "custom-depth" : "unsupported-recursion",
    }]);

  const filesystemResult = input.filesystem === undefined ? steeringSourceFilesystemObservationSchema.safeParse({
    kind: "detached", size: bytes.length,
  }) : steeringSourceFilesystemObservationSchema.safeParse(input.filesystem);
  if (!filesystemResult.success || filesystemResult.data.size !== bytes.length) return failure(sourcePath, [{
    code: "steering-source-input-invalid", severity: "error", path: sourcePath, detail: "filesystem-observation",
  }]);

  const source = { hash: hashBytes(bytes), bytes: bytes.length, media_type: STEERING_SOURCE_MEDIA_TYPE } as const;
  const fileResult = steeringSourceFileObservationSchema.safeParse({
    schema: STEERING_SOURCE_FILE_OBSERVATION_SCHEMA,
    discovery: STEERING_NATIVE_DISCOVERY_POLICY,
    project: input.project,
    source_path: sourcePath,
    source,
    filesystem: filesystemResult.data,
  });
  if (!fileResult.success) return failure(sourcePath, [{
    code: "steering-source-input-invalid", severity: "error", path: sourcePath, detail: "file-observation",
  }]);
  const file = detached(fileResult.data) as SteeringSourceFileObservation;

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return failure(sourcePath, [{
    code: "steering-source-encoding-invalid", severity: "error", path: sourcePath, detail: "utf8-bom-forbidden",
  }], file);
  if (bytes.includes(0)) return failure(sourcePath, [{
    code: "steering-source-binary-content", severity: "error", path: sourcePath, detail: "nul-byte",
  }], file);
  try { fatalDecoder.decode(bytes); }
  catch { return failure(sourcePath, [{ code: "steering-source-encoding-invalid", severity: "error", path: sourcePath }], file); }

  const framed = frameSource(bytes);
  if (!framed) return failure(sourcePath, [{
    code: "steering-source-framing-invalid", severity: "error", path: sourcePath,
  }], file);
  if (framed.frontmatter.length > nativeSteeringDiscoveryPolicy.max_frontmatter_bytes) return failure(sourcePath, [{
    code: "steering-source-frontmatter-size-limit", severity: "error", path: sourcePath,
  }], file);

  let frontmatterText: string;
  try { frontmatterText = fatalDecoder.decode(framed.frontmatter); }
  catch { return failure(sourcePath, [{ code: "steering-source-encoding-invalid", severity: "error", path: sourcePath }], file); }
  const decoded = yamlDocument(frontmatterText);
  if (decoded.issues.length) return failure(sourcePath, decoded.issues.map((issue) => ({ ...issue, path: sourcePath })), file);
  if (!structureWithinLimits(decoded.value)) return failure(sourcePath, [{
    code: "steering-source-metadata-limit", severity: "error", path: sourcePath,
  }], file);

  const raw = decoded.value as { aira?: { schema?: unknown; rules?: unknown } } | undefined;
  if (raw?.aira?.schema !== STEERING_SOURCE_SCHEMA) return failure(sourcePath, [{
    code: "steering-source-schema-unsupported", severity: "error", path: sourcePath,
    detail: typeof raw?.aira?.schema === "string" ? raw.aira.schema : "missing",
  }], file);
  if (Array.isArray(raw?.aira?.rules) && raw.aira.rules.length > nativeSteeringDiscoveryPolicy.max_rules_per_resource)
    return failure(sourcePath, [{ code: "steering-source-rule-count-limit", severity: "error", path: sourcePath }], file);

  const metadataResult = steeringSourceFrontmatterSchema.safeParse(decoded.value);
  if (!metadataResult.success) return failure(sourcePath,
    metadataIssues(metadataResult.error.issues).map((issue) => ({ ...issue, path: sourcePath })), file);
  const metadata = metadataResult.data.aira as SteeringSourceMetadata;
  if (metadata.provenance.authorship === "adopted" && metadata.provenance.adopted_from.kind === "steering-revision" &&
    /^(?:steering|project\.steering)\./.test(metadata.provenance.adopted_from.revision.id)) return failure(sourcePath, [{
      code: "steering-source-provenance-invalid",
      severity: "error",
      path: sourcePath,
      resource_id: metadata.id,
      detail: "adoption-source-must-be-external",
    }], file);

  const body = Uint8Array.from(framed.body);
  const bodyHash = hashBytes(body);
  const metadataHash = hashCanonical(metadata);
  const provenance = {
    kind: "project" as const,
    project: input.project,
    authorship: metadata.provenance.authorship,
    ...(metadata.provenance.authorship === "adopted" ? { adopted_from: metadata.provenance.adopted_from } : {}),
  };
  const rules = metadata.rules.map((rule) => ({
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
    ...(rule.source === undefined ? {} : { source: { content_hash: bodyHash, location: rule.source.location } }),
  }));

  // Validate through the existing complete domain resource contract using only
  // synthetic publication-owned fields, then discard those fields. No revision
  // identity is proposed or published by this adapter.
  const resourceResult = steeringResourceRevisionSchema.safeParse({
    schema: "aira.dev/steering-resource/v1",
    identity: { id: metadata.id, revision: "1", hash: bodyHash },
    kind: metadata.kind,
    ...(metadata.custom_kind === undefined ? {} : { custom_kind: metadata.custom_kind }),
    layer: metadata.layer,
    provenance,
    content: { hash: bodyHash, bytes: body.length, media_type: STEERING_SOURCE_MEDIA_TYPE },
    content_encoding: STEERING_SOURCE_CONTENT_ENCODING,
    default_authority: metadata.authority,
    default_override_policy: metadata.override_policy,
    default_enforcement: metadata.enforcement,
    inclusion: metadata.inclusion,
    scope: metadata.scope,
    rules,
    composition: metadata.composition,
    compatibility: metadata.compatibility,
    metadata: {
      title: metadata.title,
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
      labels: metadata.labels,
    },
    created: {
      at: "1970-01-01T00:00:00.000Z",
      by: { kind: "human", id: "native-source-validation" },
      operation: "operation_native-source-validation",
    },
    behavioral_assets: metadata.behavioral_assets,
  });
  if (!resourceResult.success) return failure(sourcePath,
    metadataIssues(resourceResult.error.issues).map((issue) => ({ ...issue, path: sourcePath })), file);

  const locationIssues = sourceLocationIssues(resourceResult.data.rules, body).map((issue) => ({
    ...issue, path: sourcePath, resource_id: metadata.id,
  }));
  if (locationIssues.length) return failure(sourcePath, locationIssues, file);

  if (metadata.authority === "enforceable") {
    const missingStructuredDefault = metadata.enforcement.some((binding) => !resourceResult.data.rules.some((rule) =>
      rule.status === "active" && rule.authority === "enforceable" && rule.enforcement.some((candidate) => exact(candidate, binding))));
    if (missingStructuredDefault) return failure(sourcePath, [{
      code: "steering-source-authority-invalid",
      severity: "error",
      path: sourcePath,
      resource_id: metadata.id,
      detail: "unstructured-default-enforcement",
    }], file);
  }

  const proposalResult = steeringSourceProposalSchema.safeParse({
    schema: STEERING_SOURCE_PROPOSAL_SCHEMA,
    identity: { id: metadata.id, body_hash: bodyHash },
    kind: resourceResult.data.kind,
    ...(resourceResult.data.custom_kind === undefined ? {} : { custom_kind: resourceResult.data.custom_kind }),
    layer: resourceResult.data.layer,
    provenance: resourceResult.data.provenance,
    content: resourceResult.data.content,
    content_encoding: resourceResult.data.content_encoding,
    default_authority: resourceResult.data.default_authority,
    default_override_policy: resourceResult.data.default_override_policy,
    default_enforcement: resourceResult.data.default_enforcement,
    inclusion: resourceResult.data.inclusion,
    scope: resourceResult.data.scope,
    rules: resourceResult.data.rules,
    composition: resourceResult.data.composition,
    compatibility: resourceResult.data.compatibility,
    metadata: resourceResult.data.metadata,
    behavioral_assets: resourceResult.data.behavioral_assets,
    source_metadata_hash: metadataHash,
  });
  if (!proposalResult.success) return failure(sourcePath, [{
    code: "steering-source-metadata-invalid", severity: "error", path: sourcePath, detail: "proposal-conversion",
  }], file);

  const observationResult = steeringSourceObservationSchema.safeParse({
    schema: STEERING_SOURCE_OBSERVATION_SCHEMA,
    source_schema: STEERING_SOURCE_SCHEMA,
    discovery: STEERING_NATIVE_DISCOVERY_POLICY,
    project: input.project,
    control: { steering_root: STEERING_SOURCE_ROOT },
    source_path: sourcePath,
    identity: {
      id: metadata.id,
      kind: metadata.kind,
      ...(metadata.custom_kind === undefined ? {} : { custom_kind: metadata.custom_kind }),
    },
    source,
    body: { hash: bodyHash, bytes: body.length, media_type: STEERING_SOURCE_MEDIA_TYPE },
    metadata_hash: metadataHash,
    filesystem: filesystemResult.data,
    provenance: {
      kind: "native-project-source",
      project: input.project,
      authorship: metadata.provenance.authorship,
      ...(metadata.provenance.authorship === "adopted" ? { adopted_from: metadata.provenance.adopted_from } : {}),
    },
  });
  if (!observationResult.success) return failure(sourcePath, [{
    code: "steering-source-metadata-invalid", severity: "error", path: sourcePath, detail: "observation-conversion",
  }], file);

  const warnings = stableIssues(conventionalWarning(sourcePath, metadata));
  const success: SteeringSourceParseSuccess = {
    ok: true,
    observation: detached(observationResult.data),
    proposal: detached(proposalResult.data),
    source_bytes: Uint8Array.from(bytes),
    body_bytes: Uint8Array.from(body),
    warnings: freezeData(warnings),
  };
  return freezeData(success);
}
