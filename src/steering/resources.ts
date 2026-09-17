import type { z } from "zod";
import { canonical, exact, stableIssues, type DomainIssue } from "../spec/domain/primitives";
import { steeringInclusionSchema, steeringScopeSchema } from "./applicability";
import {
  authorityEnforcementIssues,
  steeringAuthoritySchema,
  steeringEnforcementBindingsSchema,
  type SteeringAuthorityValue,
  type SteeringEnforcementBindingValue,
} from "./authority";
import {
  steeringCustomCategorySchema,
  steeringResourceIdSchema,
  steeringRevisionIdSchema,
  steeringRuleIdSchema,
  steeringRevisionKey,
} from "./ids";
import {
  steeringProvenanceSchema,
  steeringResourceKindSchema,
  steeringResourceRevisionSchema,
  steeringRuleSchema,
  type SteeringResourceRevisionValue,
} from "./schema";

const stableCode = /^[a-z][a-z0-9-]*$/;
function schemaIssues(schema: z.ZodType, value: unknown, fallback: string): DomainIssue[] {
  const parsed = schema.safeParse(value);
  if (parsed.success) return [];
  return stableIssues(parsed.error.issues.map((issue) => ({
    code: stableCode.test(issue.message) ? issue.message : fallback,
    ...(issue.path.length === 0 ? {} : { subject: issue.path.map(String).join(".") }),
  })));
}

export const validateSteeringResourceIdentity = (value: unknown): DomainIssue[] =>
  schemaIssues(steeringResourceIdSchema, value, "invalid-steering-resource-id");
export const validateSteeringRevisionIdentity = (value: unknown): DomainIssue[] =>
  schemaIssues(steeringRevisionIdSchema, value, "invalid-steering-revision-id");
export const validateSteeringRuleIdentity = (value: unknown): DomainIssue[] =>
  schemaIssues(steeringRuleIdSchema, value, "invalid-steering-rule-id");
export const validateSteeringInclusion = (value: unknown): DomainIssue[] =>
  schemaIssues(steeringInclusionSchema, value, "invalid-steering-inclusion");
export const validateSteeringScope = (value: unknown): DomainIssue[] =>
  schemaIssues(steeringScopeSchema, value, "invalid-steering-scope");
export const validateSteeringEnforcementBindings = (value: unknown): DomainIssue[] =>
  schemaIssues(steeringEnforcementBindingsSchema, value, "invalid-steering-enforcement-binding");
export const validateSteeringProvenance = (value: unknown): DomainIssue[] =>
  schemaIssues(steeringProvenanceSchema, value, "invalid-steering-provenance");
export const validateSteeringRule = (value: unknown): DomainIssue[] =>
  schemaIssues(steeringRuleSchema, value, "invalid-steering-rule");
export const validateSteeringResourceRevision = (value: unknown): DomainIssue[] =>
  schemaIssues(steeringResourceRevisionSchema, value, "invalid-steering-resource-revision");

export function validateSteeringKind(kind: unknown, customKind?: unknown): DomainIssue[] {
  const parsed = steeringResourceKindSchema.safeParse(kind);
  const issues: DomainIssue[] = parsed.success ? [] : [{ code: "invalid-steering-resource-kind" }];
  if (parsed.success && (parsed.data === "custom") !== (customKind !== undefined))
    issues.push({ code: "invalid-steering-custom-kind" });
  if (customKind !== undefined && !steeringCustomCategorySchema.safeParse(customKind).success)
    issues.push({ code: "invalid-steering-custom-category" });
  return stableIssues(issues);
}

export function validateSteeringAuthority(
  authority: unknown,
  bindings: unknown,
  subject?: string,
): DomainIssue[] {
  const parsedAuthority = steeringAuthoritySchema.safeParse(authority);
  const parsedBindings = steeringEnforcementBindingsSchema.safeParse(bindings);
  const issues: DomainIssue[] = [];
  if (!parsedAuthority.success) issues.push({ code: "invalid-steering-authority", subject });
  if (!parsedBindings.success) issues.push(...validateSteeringEnforcementBindings(bindings));
  if (parsedAuthority.success && parsedBindings.success)
    issues.push(...authorityEnforcementIssues(parsedAuthority.data, parsedBindings.data, subject));
  return stableIssues(issues);
}

export function validateImmutableSteeringRevision(
  previous: SteeringResourceRevisionValue,
  candidate: SteeringResourceRevisionValue,
): DomainIssue[] {
  return steeringRevisionKey(previous.identity) === steeringRevisionKey(candidate.identity) && !exact(previous, candidate) ?
    [{ code: "immutable-steering-revision-overwrite", subject: steeringRevisionKey(previous.identity) }] : [];
}

function logicalAssignment(revision: SteeringResourceRevisionValue): string {
  const provenance = revision.provenance.kind === "project" ?
    { kind: revision.provenance.kind, project: revision.provenance.project } : { kind: revision.provenance.kind };
  return canonical({ kind: revision.kind, custom_kind: revision.custom_kind, layer: revision.layer, provenance });
}

export function validateSteeringRuleEvolution(
  previous: SteeringResourceRevisionValue,
  candidate: SteeringResourceRevisionValue,
): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (previous.identity.id !== candidate.identity.id || !exact(candidate.supersedes, previous.identity))
    issues.push({ code: "steering-rule-evolution-predecessor-mismatch", subject: candidate.identity.id });
  for (const oldRule of previous.rules) {
    const nextRule = candidate.rules.find((rule) => rule.id === oldRule.id);
    if (nextRule === undefined) {
      issues.push({ code: "steering-rule-retirement-missing", subject: oldRule.id });
      continue;
    }
    if (nextRule.semantics.key !== oldRule.semantics.key)
      issues.push({ code: "steering-rule-identity-reassigned", subject: oldRule.id });
    if (oldRule.status === "deprecated" && nextRule.status !== "deprecated")
      issues.push({ code: "steering-rule-reused", subject: oldRule.id });
  }
  return stableIssues(issues);
}

/** Publication-history validation. It does not resolve current revisions or compose hierarchy. */
export function validateSteeringRevisionHistory(revisions: readonly SteeringResourceRevisionValue[]): DomainIssue[] {
  const issues: DomainIssue[] = [];
  for (const revision of revisions) {
    if (!steeringResourceRevisionSchema.safeParse(revision).success) {
      issues.push({ code: "invalid-steering-resource-revision" });
      continue;
    }
    const key = steeringRevisionKey(revision.identity);
    if (revisions.filter((candidate) => steeringRevisionKey(candidate.identity) === key).length !== 1)
      issues.push({ code: "duplicate-steering-revision", subject: key });
    if (revisions.some((candidate) => candidate.identity.id === revision.identity.id &&
      logicalAssignment(candidate) !== logicalAssignment(revision)))
      issues.push({ code: "steering-logical-identity-reassigned", subject: revision.identity.id });
    if (revision.supersedes !== undefined) {
      const predecessors = revisions.filter((candidate) => exact(candidate.identity, revision.supersedes));
      if (predecessors.length === 0) issues.push({ code: "steering-predecessor-unavailable", subject: key });
      else if (predecessors.length === 1) issues.push(...validateSteeringRuleEvolution(predecessors[0]!, revision));
    }
  }
  for (const predecessor of revisions) {
    const successors = revisions.filter((candidate) => candidate.supersedes !== undefined && exact(candidate.supersedes, predecessor.identity));
    if (successors.length > 1)
      issues.push({ code: "steering-revision-branch", subject: steeringRevisionKey(predecessor.identity),
        related: successors.map((successor) => steeringRevisionKey(successor.identity)).sort() });
  }
  return stableIssues(issues);
}

/** Checks an explicit project adoption edge. Byte authenticity remains an adapter/catalog observation. */
export function validateSteeringAdoption(
  source: SteeringResourceRevisionValue,
  candidate: SteeringResourceRevisionValue,
): DomainIssue[] {
  const issues: DomainIssue[] = [];
  if (source.provenance.kind === "project")
    issues.push({ code: "steering-adoption-source-must-be-external", subject: source.identity.id });
  if (candidate.provenance.kind !== "project" || candidate.provenance.authorship !== "adopted" ||
    candidate.provenance.adopted_from?.kind !== "steering-revision" ||
    !exact(candidate.provenance.adopted_from.revision, source.identity))
    issues.push({ code: "steering-adoption-provenance-mismatch", subject: candidate.identity.id });
  return stableIssues(issues);
}

