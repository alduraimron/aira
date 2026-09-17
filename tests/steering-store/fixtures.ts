import { steeringResourceRevisionSchema } from "../../src/steering/schema";
import type { SteeringResourceRevision } from "../../src/steering/types";
import type { SteeringSnapshot } from "../../src/steering/snapshot";
import { steeringResourceIdSchema, steeringRevisionIdSchema } from "../../src/steering/ids";
import { steeringRegistrySchema, steeringTransactionSchema, steeringRegistryRevisionOf, steeringExpectationFor,
  type SteeringRegistry, type SteeringRevisionPublication, type SteeringStoreSnapshot } from "../../src/storage/steering-types";
import { steeringSnapshotPublicationMetadataSchema, type SteeringSnapshotPublicationMetadata } from "../../src/storage/steering-snapshot-types";
import { FileSteeringStore } from "../../src/storage/file/steering-store";
import { hashBytes } from "../../src/storage/file/canonical-json";
import { temporary as storageTemporary, at, human } from "../storage-v2/fixtures";

export { at, human };
export const project = "acme" as const;

export function revision(
  bodyText = "# Architecture\n\nUse repository boundaries.\n",
  revisionId = "1",
  previous?: SteeringResourceRevision,
  id = "steering.architecture",
): SteeringRevisionPublication {
  const body = new TextEncoder().encode(bodyText);
  const hash = hashBytes(body);
  const parsedId = steeringResourceIdSchema.parse(id);
  const identity = { id: parsedId, revision: steeringRevisionIdSchema.parse(revisionId), hash };
  const kind = id === "steering.security" ? "security" : "architecture";
  const ruleId = id === "steering.security" ? "rule.security.baseline" : "rule.architecture.repository-access";
  const semanticKey = id === "steering.security" ? "topic.security.baseline" : "topic.architecture.data-access";
  const value = id === "steering.security" ? "deny-by-default" : `repository-layer-${revisionId}`;
  const valueObject = {
    schema: "aira.dev/steering-resource/v1",
    identity,
    kind,
    layer: "project-root",
    provenance: { kind: "project", project, authorship: "authored" },
    content: { hash, bytes: body.length, media_type: "text/markdown; charset=utf-8" },
    content_encoding: "aira.dev/steering-bytes/raw/v1",
    default_authority: "normative",
    default_override_policy: "narrower-scope",
    default_enforcement: [],
    inclusion: { availability: "required", selector: { kind: "always" } },
    scope: { kind: "project-global" },
    rules: [{
      id: ruleId,
      title: "Project rule",
      authority: "normative",
      semantics: { key: semanticKey, effect: "require", value },
      override_policy: "narrower-scope",
      status: "active",
      enforcement: [],
      source: { content_hash: hash, location: { kind: "document" } },
    }],
    composition: { parents: [], overrides: [] },
    compatibility: { resolver: "aira.dev/steering-resolution/v1", required_schemas: [] },
    metadata: { title: `${kind} Steering`, labels: [kind] },
    created: { at, by: human, operation: `operation_revision_${revisionId}`, channel: "api" },
    behavioral_assets: [],
    ...(previous ? { supersedes: previous.identity } : {}),
  };
  return { revision: steeringResourceRevisionSchema.parse(valueObject), body };
}

function resourceEntry(publications: readonly SteeringRevisionPublication[], status: "active" | "retired" = "active") {
  const summaries = publications.map((publication) => steeringRegistryRevisionOf(publication.revision));
  return {
    id: publications[0]!.revision.identity.id,
    status,
    current: status === "active" ? publications.at(-1)!.revision.identity : null,
    revisions: summaries,
  };
}

export function registry(
  generation = "0",
  resources: readonly { publications: readonly SteeringRevisionPublication[]; status?: "active" | "retired" }[] = [],
): SteeringRegistry {
  return steeringRegistrySchema.parse({
    schema: "aira.dev/steering-registry/v1",
    project,
    generation,
    resources: resources.map((resource) => resourceEntry(resource.publications, resource.status)).sort((a, b) => a.id < b.id ? -1 : 1),
  });
}

export function creation(
  operation = "operation_steering_create",
  publications: readonly SteeringRevisionPublication[] = [],
) {
  const grouped = new Map<string, SteeringRevisionPublication[]>();
  for (const publication of publications) {
    const list = grouped.get(publication.revision.identity.id) ?? [];
    list.push(publication); grouped.set(publication.revision.identity.id, list);
  }
  const state = registry("0", [...grouped.values()].map((items) => ({ publications: items })));
  const resources = state.resources.map((resource) => resource.id);
  const transaction = steeringTransactionSchema.parse({
    schema: "aira.dev/steering-store-transaction/v1",
    project,
    operation,
    expected: null,
    mutation: { kind: "create", resources, reason: "Create project Steering registry" },
    actor: human,
    channel: "api",
    registry: state,
    events: [{ kind: "steering-registry-created", resources, payloads: [] }],
  });
  return { transaction, publications };
}

export function publish(snapshot: SteeringStoreSnapshot, publication: SteeringRevisionPublication, operation = "operation_steering_publish") {
  const id = publication.revision.identity.id;
  const old = snapshot.registry.resources.find((resource) => resource.id === id);
  const resources = snapshot.registry.resources.filter((resource) => resource.id !== id).map((resource) => ({ ...resource }));
  resources.push({
    id,
    status: "active" as const,
    current: publication.revision.identity,
    revisions: [...(old?.revisions ?? []), steeringRegistryRevisionOf(publication.revision)],
  });
  resources.sort((a, b) => a.id < b.id ? -1 : 1);
  return steeringTransactionSchema.parse({
    schema: "aira.dev/steering-store-transaction/v1",
    project,
    operation,
    expected: { head: snapshot.head, resources: [steeringExpectationFor(snapshot.registry, id)] },
    mutation: { kind: "publish", resources: [id], reason: "Publish exact Steering revision" },
    actor: human,
    channel: "api",
    registry: { schema: "aira.dev/steering-registry/v1", project, generation: (BigInt(snapshot.registry.generation) + 1n).toString(), resources },
    events: [{ kind: "steering-revision-published", resources: [id], payloads: [] }],
  });
}

export function snapshotMetadata(
  source: SteeringStoreSnapshot,
  snapshot: SteeringSnapshot,
  operation = "operation_snapshot_publish",
): SteeringSnapshotPublicationMetadata {
  return steeringSnapshotPublicationMetadataSchema.parse({
    source: {
      head: source.head,
      resources: snapshot.semantic.resources.map((resource) => resource.revision.identity),
    },
    publication: { at, by: human, operation, channel: "api" },
  });
}

export function retire(snapshot: SteeringStoreSnapshot, id = "steering.architecture", operation = "operation_steering_retire") {
  const resourceId = steeringResourceIdSchema.parse(id);
  return steeringTransactionSchema.parse({
    schema: "aira.dev/steering-store-transaction/v1",
    project,
    operation,
    expected: { head: snapshot.head, resources: [steeringExpectationFor(snapshot.registry, resourceId)] },
    mutation: { kind: "retire", resources: [resourceId], reason: "Retire Steering resource" },
    actor: human,
    channel: "api",
    registry: { ...snapshot.registry, generation: (BigInt(snapshot.registry.generation) + 1n).toString(), resources: snapshot.registry.resources.map((resource) =>
      resource.id === resourceId ? { ...resource, status: "retired" as const, current: null } : resource) },
    events: [{ kind: "steering-resource-retired", resources: [resourceId], payloads: [] }],
  });
}

export async function temporary() {
  const context = await storageTemporary();
  return { ...context, store: new FileSteeringStore(context.root, { clock: () => at }) };
}

export async function created(publications: readonly SteeringRevisionPublication[] = []) {
  const context = await temporary(), request = creation("operation_steering_create", publications);
  const result = await context.store.createRegistry(request.transaction, request.publications);
  return { ...context, request, result };
}
