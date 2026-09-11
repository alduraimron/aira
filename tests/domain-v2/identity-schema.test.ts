import { describe, expect, test } from "bun:test";
import { z } from "zod";
import * as ids from "../../src/spec/domain/ids";
import { commitSequenceSchema, specGenerationSchema, runGenerationSchema, fenceEpochSchema, successor, advanceGenerations } from "../../src/spec/domain/generations";
import { timestampSchema } from "../../src/spec/domain/primitives";
import { specSchema } from "../../src/spec/domain/schema";
import { artifactRevisionSchema, intentSchema, validateImmutableRevision, type ArtifactRevision } from "../../src/spec/domain/artifacts";
import { requirementsSchema, requirementSchema, acceptanceCriterionSchema } from "../../src/spec/domain/requirements";
import { designSchema } from "../../src/spec/domain/design";
import { analysisSchema } from "../../src/spec/domain/analysis";
import { tasksSchema } from "../../src/tasks/schema";
import { executionRunSchema, attemptRecordSchema, taskExecutionStateSchema } from "../../src/execution/schema";
import { verificationPlanSchema, verificationEvidenceSchema } from "../../src/verification/schema";
import { workspaceFingerprintSchema, executionBackendSchema, workspaceHandleSchema } from "../../src/workspace/schema";
import { contextSnapshotSchema } from "../../src/context/snapshot";
import { contextDeclarationSchema } from "../../src/context/declarations";
import { capabilityPolicySchema } from "../../src/capabilities/schema";
import { specApprovalRecordSchema } from "../../src/approval/spec-records";
import { fixture, capabilityPolicy, snapshot, declaration, metadata } from "./fixtures";

const formats: [string, z.ZodType, string, string[]][] = [
  ["RequirementId", ids.requirementIdSchema, "R12", ["R0", "R01", "r1", "R1.2", "R-1", " R1"]],
  ["AcceptanceCriterionId", ids.acceptanceCriterionIdSchema, "R12.AC4", ["R0.AC1", "R1.AC0", "R1.AC01", "AC1", "R1.ac1"]],
  ["DesignDecisionId", ids.designDecisionIdSchema, "D2", ["D0", "D01", "d1"]],
  ["TaskId", ids.taskIdSchema, "T2", ["T0", "T01", "t1"]], ["VerifierId", ids.verifierIdSchema, "V3", ["V0", "V01", "v1"]],
  ["SpecId", ids.specIdSchema, "spec_one", ["one", "spec_", "spec_../one"]],
  ["ArtifactRevisionId", ids.artifactRevisionIdSchema, "rev_one", ["one", "rev_", "rev_/one"]],
  ["ApprovalId", ids.approvalIdSchema, "approval_one", ["one", "approval_", "approval_one "]],
  ["RevisionRequestId", ids.revisionRequestIdSchema, "revision_one", ["one", "revision_", "revision_../"]],
  ["AnalysisFindingId", ids.analysisFindingIdSchema, "finding_one", ["one", "finding_", "finding_ONE"]],
  ["RunIdV2", ids.runIdV2Schema, "run_one", ["one", "run_", "20260826-100001-a1000001"]],
  ["AttemptId", ids.attemptIdSchema, "attempt_one", ["one", "attempt_", "attempt_../"]],
  ["EvidenceId", ids.evidenceIdSchema, "evidence_one", ["one", "evidence_", "evidence_ONE"]],
  ["WorkspaceId", ids.workspaceIdSchema, "workspace_one", ["one", "workspace_", "workspace_/tmp"]],
  ["PolicyId", ids.policyIdSchema, "policy_one", ["one", "policy_", "policy_*"]],
  ["ContextSnapshotId", ids.contextSnapshotIdSchema, "snapshot_one", ["one", "snapshot_", "snapshot_../"]],
  ["OperationId", ids.operationIdSchema, "operation_one", ["one", "operation_", "operation_ "]],
  ["ClaimId", ids.claimIdSchema, "claim_one", ["one", "claim_", "claim_/tmp"]],
];
describe("stable branded identity contracts", () => {
  test.each(formats)("%s accepts its format and rejects malformed identities", (_name, schema, valid, invalid) => {
    expect(schema.parse(valid)).toBe(valid);
    for (const value of invalid) expect(schema.safeParse(value).success).toBe(false);
  });
  test("INV-SPEC-002: registry tombstones prevent deletion/reuse", () => {
    const previous = ids.identityRegistrySchema.parse({ schema: "aira.dev/identity-registry/v1", entries: [{ id: "R1", introduced_in: "rev_r1", retired_in: "rev_r2" }] });
    expect(ids.validateIdentityEvolution(previous, { ...previous, entries: [] })).toEqual(["R1"]);
    expect(ids.validateIdentityEvolution(previous, { ...previous, entries: [{ id: ids.requirementIdSchema.parse("R1"), introduced_in: ids.artifactRevisionIdSchema.parse("rev_r3") }] })).toEqual(["R1"]);
    expect(ids.validateIdentityEvolution(previous, structuredClone(previous))).toEqual([]);
  });
  test("removal requires a tombstone and a retired identity cannot re-enter the active set", () => {
    const registry = ids.identityRegistrySchema.parse({ schema: "aira.dev/identity-registry/v1", entries: [{ id: "R1", introduced_in: "rev_r1" }] });
    const active = [ids.requirementIdSchema.parse("R1")];
    expect(ids.validateIdentityChange(registry, registry, active, []).map((i) => i.code)).toContain("identity-retirement-missing");
    const retired = ids.identityRegistrySchema.parse({ ...registry, entries: [{ ...registry.entries[0]!, retired_in: "rev_r2" }] });
    expect(ids.validateIdentityChange(registry, retired, active, [])).toEqual([]);
    expect(ids.validateIdentityChange(retired, retired, [], active).map((i) => i.code)).toContain("identity-reused");
  });
  test("immutable revision identity cannot be overwritten with different hash/metadata", () => {
    const revision = fixture().req;
    expect(validateImmutableRevision(revision, structuredClone(revision))).toEqual([]);
    expect(validateImmutableRevision(revision, { ...revision, content: { ...revision.content, bytes: 11 } })).toEqual([{ code: "immutable-revision-overwrite", subject: revision.id }]);
  });
  test("stable requirement/AC identity survives edits and reordering", () => {
    const r1 = fixture().requirements.requirements[0]!;
    const r2 = requirementSchema.parse({ ...r1, id: "R2", acceptance_criteria: [{ id: "R2.AC1", form: "ubiquitous", expected_behavior: "Log exports" }] });
    const doc = fixture().requirements;
    const a = requirementsSchema.parse({ ...doc, requirements: [r1, r2] });
    const b = requirementsSchema.parse({ ...doc, requirements: [r2, { ...r1, title: "Edited" }] });
    expect(a.requirements.find((r) => r.id === "R1")!.acceptance_criteria).toEqual(b.requirements.find((r) => r.id === "R1")!.acceptance_criteria);
  });
  test("AC identity must belong to its requirement", () => {
    const r = fixture().requirements.requirements[0]!;
    expect(requirementSchema.safeParse({ ...r, acceptance_criteria: [{ ...r.acceptance_criteria[0], id: "R2.AC1" }] }).success).toBe(false);
  });
  test.each(["must", "should", "could"])("canonical priority %s", (priority) => {
    expect(requirementSchema.safeParse({ ...fixture().requirements.requirements[0], priority }).success).toBe(true);
  });
  test("EARS alternatives and non-EARS fallback are structured", () => {
    expect(acceptanceCriterionSchema.safeParse({ id: "R1.AC1", form: "event-driven", expected_behavior: "Export" }).success).toBe(false);
    expect(acceptanceCriterionSchema.safeParse({ id: "R1.AC1", form: "freeform", expected_behavior: "Export", text: "An operator can export" }).success).toBe(true);
  });
  test("reference unknown requirement rejected without mutating input", () => {
    const doc = fixture().requirements;
    const bad = { ...doc, requirements: [{ ...doc.requirements[0]!, dependencies: ["R999"] }] };
    const before = JSON.stringify(bad);
    expect(requirementsSchema.safeParse(bad).success).toBe(false); expect(JSON.stringify(bad)).toBe(before);
  });
});

describe("INV-GEN-001/002: separate bounded counters", () => {
  test.each([commitSequenceSchema, specGenerationSchema, runGenerationSchema, fenceEpochSchema])("canonical decimal u64 rejects malformed/overflow states", (schema) => {
    expect(String(schema.parse("18446744073709551615"))).toBe("18446744073709551615");
    for (const value of [-1, 1, "-1", "01", "1.5", "1e3", "18446744073709551616", ""]) expect(schema.safeParse(value).success).toBe(false);
  });
  test("checked increment, no overflow wrap", () => {
    expect(successor(specGenerationSchema.parse("18446744073709551615"))).toEqual({ ok: false, issues: [{ code: "generation-overflow" }] });
    expect(successor(specGenerationSchema.parse("9"))).toEqual({ ok: true, value: specGenerationSchema.parse("10") });
  });
  test("lease/run bookkeeping advances commit/run but not Spec", () => {
    const current = { commit: commitSequenceSchema.parse("20"), spec: specGenerationSchema.parse("10"), run: runGenerationSchema.parse("5") };
    expect(advanceGenerations(current, { spec: false, run: true })).toEqual({ ok: true, value: { commit: commitSequenceSchema.parse("21"), spec: specGenerationSchema.parse("10"), run: runGenerationSchema.parse("6") } });
    expect(JSON.stringify(current)).toBe('{"commit":"20","spec":"10","run":"5"}');
  });
});

describe("strict, versioned persisted contracts", () => {
  const f = fixture();
  const documents: [z.ZodType, object][] = [
    [specSchema, f.spec], [artifactRevisionSchema, f.req], [requirementsSchema, f.requirements], [designSchema, f.design], [tasksSchema, f.tasks],
    [analysisSchema, f.review.analyses[0]!], [executionRunSchema, f.run], [attemptRecordSchema, f.attempt], [taskExecutionStateSchema, f.state],
    [verificationPlanSchema, f.plan], [verificationEvidenceSchema, f.record], [workspaceFingerprintSchema, f.workspace.fingerprint], [executionBackendSchema, f.backend],
    [contextSnapshotSchema, snapshot()], [contextDeclarationSchema, declaration()], [capabilityPolicySchema, capabilityPolicy()], [specApprovalRecordSchema, f.review.approvals[0]!],
    [intentSchema, { schema: "aira.dev/intent/v1", spec_id: "spec_one", revision: "rev_i1", statement: "Export", constraints: [], metadata }],
    [workspaceHandleSchema, { schema: "aira.dev/workspace-handle/v1", id: "workspace_one", provider: f.workspace.fingerprint.provider, project_identity: "project-one",
      repository_identity: "repository-one", location: "provider://workspace/one", isolation: "isolated-filesystem", provider_data: { branch: "aira/test" } }],
  ];
  for (const [schema, document] of documents) {
    test(`${(document as { schema: string }).schema}: strict version/fields, lossless cloning`, () => {
      expect(schema.parse(document)).toEqual(document);
      expect(schema.safeParse({ ...document, surprise: true }).success).toBe(false);
      expect(schema.safeParse({ ...document, schema: "aira.dev/unknown/v99" }).success).toBe(false);
      expect(schema.safeParse({ ...document, schema: undefined }).success).toBe(false);
    });
  }
  test("unknown nested fields fail closed", () => {
    expect(specSchema.safeParse({ ...f.spec, metadata: { ...f.spec.metadata, unknown: 1 } }).success).toBe(false);
    expect(requirementsSchema.safeParse({ ...f.requirements, requirements: [{ ...f.requirements.requirements[0], guessed: true }] }).success).toBe(false);
  });
  test("impossible dates are rejected without normalization", () => {
    for (const value of ["2026-02-30T12:00:00Z", "2026-08-26T24:00:00Z", "2026-08-26T12:00:00+00:00", "yesterday"])
      expect(timestampSchema.safeParse(value).success).toBe(false);
  });
});

// Compile-time separation is tested by tsc, not only runtime regexes.
if (false) {
  // @ts-expect-error raw strings are not validated IDs
  const task: ids.TaskId = "T1";
  // @ts-expect-error branded task identity is not a requirement identity
  const requirement: ids.RequirementId = ids.taskIdSchema.parse("T1");
  // @ts-expect-error Spec generation is not storage publication order
  const commit: import("../../src/spec/domain/generations").CommitSequence = specGenerationSchema.parse("1");
  const revision: ArtifactRevision = fixture().req;
  // @ts-expect-error historical revision metadata is deeply readonly
  revision.content.bytes = 20;
  // @ts-expect-error historical provenance cannot be edited in place
  revision.lineage.push({ relation: "derived_from", target: fixture().req.lineage[0]!.target });
  void [task, requirement, commit, revision];
}
