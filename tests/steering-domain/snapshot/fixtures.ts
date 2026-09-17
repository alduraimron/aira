import {
  buildSteeringSnapshot,
  resolveSteering,
  steeringResourceRevisionSchema,
  type SteeringResolutionInputs,
  type SteeringResourceRevision,
  type SteeringRule,
  type SteeringSnapshot,
} from "../../../src/steering";
import { hash, request } from "../resolver/fixtures";

export { hash, request, revision, scoped, tree, namedRule, fact, override, policyBinding } from "../resolver/fixtures";
export { verifierBinding, profile } from "../fixtures";

export function nextRevision(
  previous: SteeringResourceRevision,
  digit: number,
  overrides: Partial<SteeringResourceRevision> = {},
): SteeringResourceRevision {
  const contentHash = hash(digit);
  const suppliedRules = overrides.rules ?? previous.rules;
  const rules = suppliedRules.map((rule) => ({
    ...rule,
    ...(rule.source === undefined ? {} : { source: { ...rule.source, content_hash: contentHash } }),
  })) as SteeringRule[];
  return steeringResourceRevisionSchema.parse({
    ...previous,
    ...overrides,
    identity: { id: previous.identity.id, revision: (BigInt(previous.identity.revision) + 1n).toString(), hash: contentHash },
    content: { ...previous.content, hash: contentHash },
    rules,
    supersedes: previous.identity,
  });
}

export function snapshot(
  catalog: readonly SteeringResourceRevision[],
  overrides: Partial<SteeringResolutionInputs> = {},
  constructedAt?: string,
): SteeringSnapshot {
  const resolution = resolveSteering(request(catalog, overrides));
  if (resolution.status !== "resolved") throw new Error(`fixture did not resolve: ${JSON.stringify(resolution.diagnostics)}`);
  const built = buildSteeringSnapshot(resolution, constructedAt === undefined ? {} : { constructed_at: constructedAt });
  if (!built.ok) throw new Error(`fixture did not snapshot: ${JSON.stringify(built.issues)}`);
  return built.value;
}
