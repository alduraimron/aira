import { artifactRevisionSchema, referenceOf, approvedSpecSnapshotSchema, type ArtifactReference, type ArtifactKind } from "../../src/spec/domain/artifacts";
import { analysisSchema } from "../../src/spec/domain/analysis";
import { architectureSchema } from "../../src/spec/domain/architecture";
import { productDefinitionSchema } from "../../src/spec/domain/product";
import { programDesignSchema } from "../../src/spec/domain/program-design";
import { slicePlanSchema } from "../../src/spec/domain/slices";
import { planningKinds } from "../../src/spec/domain/planning-kinds";
import { sliceExecutionStateSchema } from "../../src/spec/domain/slice-state";
import { requirementsSchema } from "../../src/spec/domain/requirements";
import { specSchema } from "../../src/spec/domain/schema";
import { contentHashSchema, policyReferenceSchema, profileReferenceSchema } from "../../src/spec/domain/primitives";
import { specApprovalRecordSchema, approvalApplicabilitySchema } from "../../src/approval/spec-records";
import { tasksSchema, taskDefinitionSchema } from "../../src/tasks/schema";
import { executionBackendSchema, workspaceFingerprintSchema, workspaceObservationSchema } from "../../src/workspace/schema";
import { attemptRecordSchema, executionRunSchema, taskExecutionStateSchema } from "../../src/execution/schema";
import { verificationEvidenceSchema, verificationPlanSchema } from "../../src/verification/schema";
import { capabilityPolicySchema } from "../../src/capabilities/schema";
import { contextDeclarationSchema } from "../../src/context/declarations";
import { contextSnapshotSchema } from "../../src/context/snapshot";
import type { SpecMode } from "../../src/spec/domain/lifecycle";
import type { CompletionInput } from "../../src/spec/domain/completion";
import type { EvidenceContext } from "../../src/verification/applicability";
import { baseBehavioralPins, baseBehavioralCatalog, syntheticEnvironment } from "./behavioral-fixtures";

// Symbolic synthetic identities, not claims about hashed filesystem bytes.
export const hash = (n = 1) => contentHashSchema.parse(`sha256:${n.toString(16).padStart(64, "0")}`);
export const at = "2026-08-26T12:00:00.000Z";
export const started = "2026-08-26T12:00:01.000Z";
export const ended = "2026-08-26T12:00:02.000Z";
export const observed = "2026-08-26T12:00:03.000Z";
export const human = { kind: "human" as const, id: "local" };
export const metadata = { at, by: human, operation: "operation_author", channel: "cli" };
export const profile = (name: string) => profileReferenceSchema.parse({ id: `profile_${name}`, revision: `rev_profile_${name}`, hash: hash(100 + name.length) });
export const policyRef = (name: string) => policyReferenceSchema.parse({ id: `policy_${name}`, revision: `rev_policy_${name}`, hash: hash(200 + name.length) });
export function artifact(kind: ArtifactKind, name: string, inputs: ArtifactReference[] = [], number = 1) {
  return artifactRevisionSchema.parse({ schema: "aira.dev/artifact-revision/v2", id: `rev_${name}`, spec_id: "spec_one", kind,
    content: { hash: hash(number), bytes: 10, media_type: "application/json" }, created: metadata,
    lineage: inputs.map((target) => ({ relation: target.kind === "intent" ? "generated_from_intent" : "derived_from", target })) });
}
export function backend(enforced = true) {
  return executionBackendSchema.parse({ schema: "aira.dev/execution-backend/v1",
    identity: { id: "backend-local", implementation: "synthetic-test-backend", version: "1", integrity: hash(90), configuration_hash: hash(91) },
    capabilities: { filesystem_read_confinement: enforced, filesystem_write_confinement: enforced, process_confinement: enforced,
      network_confinement: enforced, environment_isolation: enforced, force_termination: enforced } });
}
export function fingerprint() {
  return workspaceFingerprintSchema.parse({ schema: "aira.dev/workspace-fingerprint/v1", workspace_id: "workspace_one",
    provider: { kind: "git-worktree", identity: backend().identity }, algorithm: profile("fingerprint"), digest: hash(40),
    capture_policy: { identity: profile("capture"), ignored: "included", submodules: "recursive", symlinks: "link-identity", generated: "included", aira_storage: "excluded", exclusions: [".aira/"] },
    state: { kind: "git", repository_identity: "repository-one", base_revision: "a".repeat(40), index_hash: hash(41), tree_hash: hash(42),
      tracked_content_hash: hash(43), tracked_diff_hash: hash(44), untracked_content_hash: hash(45), submodule_state_hash: hash(46) } });
}
export function capabilityPolicy() {
  const rule = { allow: [{ kind: "tree", path: "src" }], deny: [] };
  return capabilityPolicySchema.parse({ schema: "aira.dev/capability-policy/v1", identity: policyRef("task"),
    filesystem: { read: rule, write: rule, create: rule, delete: rule }, protected_paths: [{ kind: "tree", path: "src/secrets" }],
    process: { mode: "profiles", profiles: [profile("execute")], arbitrary_shell: true },
    network: { mode: "allow-list", destinations: [{ host: "example.com", port: 443, protocol: "tcp" }], deny: [] },
    tools: { allow: [{ name: "read", provider: "aira", implementation: "confined-read", version: "1", integrity: hash(51) }], deny: [] },
    environment: { allow: ["LANG"], deny: ["SECRET"], inherit_ambient: false },
    required_backend: ["filesystem_read_confinement", "filesystem_write_confinement", "process_confinement"] });
}
export function declaration(required = true) {
  return contextDeclarationSchema.parse({ schema: "aira.dev/context-declaration/v2", id: "context_code",
    selector: { kind: "glob", pattern: "src/**/*.ts", dialect: "aira.dev/glob/v1" }, required,
    phases: ["implementation", "verification"], tasks: { kind: "all" }, max_bytes: 100,
    inclusion: "inline", classification: "untrusted" });
}
export function snapshot() {
  return contextSnapshotSchema.parse({ schema: "aira.dev/context-snapshot/v2", id: "snapshot_one", workspace_id: "workspace_one",
    fingerprint: fingerprint(), resolver: profile("resolver"), resolver_policy: profile("context"), behavioral_assets: baseBehavioralPins().filter((p) => p.role === "context-profile"),
    phase: "implementation", task: "T1", at, ordering: "logical-path-codepoint", total_bytes: 10,
    entries: [{ logical_path: "src/a.ts", canonical_path_identity: "test:///workspace/src/a.ts", content_hash: hash(54), byte_size: 10, order: 0,
      inclusion: "inline", classification: "untrusted", reasons: [{ declaration: "context_code", description: "required source" }] }] });
}
export function task(id = "T1", dependencies: string[] = []) {
  return taskDefinitionSchema.parse({ schema: "aira.dev/task-definition/v2", identity: { id, revision: `rev_def_${id.toLowerCase()}`, hash: hash(60) },
    title: "Implement export", kind: "implementation", description: "Add export", outcome: "Users can export",
    requirements: ["R1"], acceptance_criteria: ["R1.AC1"], architecture_decisions: ["A1"], program_design_decisions: ["PD1"], slice: "S1", dependencies, required: true,
    completion: [{ kind: "verification", verifier: "V1" }], verifiers: ["V1"],
    context: { declarations: [declaration()], references: [] }, capability_policy: policyRef("task"), execution_profile: profile("execute"), behavioral_selections: [],
    workspace: { providers: ["git-worktree"], isolation: "isolated-required", repository_required: true, backend_requirements: ["process_confinement"] },
    scheduling: { priority: 0, exclusive_resources: [], labels: [] } });
}
export function fixture(mode: SpecMode = "requirements-first", authoringOrder: "requirements-first" | "architecture-first" = mode === "architecture-first" ? "architecture-first" : "requirements-first") {
  const intent = artifact("intent", "i1", [], 1);
  const prod = artifact("product", "product1", [referenceOf(intent)], 6);
  const req = artifact("requirements", "r1", [referenceOf(intent), referenceOf(prod)], 2);
  const des = artifact("architecture", "d1", authoringOrder === "architecture-first" ? [referenceOf(prod)] : [referenceOf(req)], 3);
  if (authoringOrder === "architecture-first") req.lineage.push({ relation: "derived_from", target: referenceOf(des) });
  const pd = artifact("program-design", "program1", [referenceOf(des), referenceOf(req)], 7);
  const sl = artifact("slice-plan", "slices1", [referenceOf(pd)], 8);
  const ts = artifact("tasks", "t1", [referenceOf(req), referenceOf(des), referenceOf(sl)], 4);
  const planRevision = artifact("verification-plan", "p1", [referenceOf(ts)], 5);
  const analysisInputs: { phase: "product" | "requirements" | "architecture" | "program-design" | "slice-plan" | "tasks" | "consistency"; inputs: ArtifactReference[] }[] = [
    { phase: "requirements", inputs: [referenceOf(req)] }, { phase: "architecture", inputs: [referenceOf(des)] },
    { phase: "tasks", inputs: [referenceOf(ts), referenceOf(req), referenceOf(des)] },
    { phase: "consistency", inputs: [referenceOf(des), referenceOf(req)] },
    { phase: "product", inputs: [referenceOf(prod)] }, { phase: "program-design", inputs: [referenceOf(pd)] }, { phase: "slice-plan", inputs: [referenceOf(sl)] },
  ];
  const analysisRevisions = analysisInputs.map((a, i) => artifact("analysis", `analysis_${a.phase}`, a.inputs, 10 + i));
  const analyses = analysisInputs.map((a, i) => analysisSchema.parse({ schema: "aira.dev/analysis/v2", spec_id: "spec_one",
    revision: analysisRevisions[i]!.id, phase: a.phase, inputs: a.inputs, created: metadata, outcome: "consistent", findings: [] }));
  const product = productDefinitionSchema.parse({ schema: "aira.dev/product/v1", spec_id: "spec_one", revision: prod.id,
    problem: "Users cannot take their records elsewhere", current_pain_or_opportunity: "Manual transcription loses data",
    stakeholders: [{ name: "Record owner", role: "user", need: "Portable records" }], outcomes: [{ id: "O1", statement: "Users can take records elsewhere" }],
    success_criteria: [{ id: "SC1", outcomes: ["O1"], statement: "A user exports a complete CSV", measurement: "All records present" }],
    non_goals: ["Import"], assumptions: [], constraints: [], risks: [], unresolved_questions: [] });
  const requirements = requirementsSchema.parse({ schema: "aira.dev/requirements/v2", spec_id: "spec_one", revision: req.id,
    requirements: [{ id: "R1", type: "functional", title: "Export", priority: "must", statement: "The system exports records", dependencies: [], product_outcomes: ["O1"], success_criteria: ["SC1"],
      rationale: "Portability", assumptions: ["UTF-8"], acceptance_criteria: [{ id: "R1.AC1", form: "event-driven", trigger: "User requests export", expected_behavior: "Return a CSV within 1 second" }] }] });
  const architecture = architectureSchema.parse({ schema: "aira.dev/architecture/v1", spec_id: "spec_one", revision: des.id, summary: "Streaming export",
    decisions: [{ id: "A1", title: "Stream", description: "Stream records", requirements: ["R1"], acceptance_criteria: ["R1.AC1"], rationale: "Bound memory" }],
    sections: { concurrency: { summary: "Snapshot reads" }, rollback: { summary: "Disable export endpoint" } } });
  const program_design = programDesignSchema.parse({ schema: "aira.dev/program-design/v1", spec_id: "spec_one", revision: pd.id, summary: "Export stream orchestration",
    decisions: [{ id: "PD1", title: "Export function", description: "exportRecords streams the repository result", architecture_decisions: ["A1"], requirements: ["R1"],
      acceptance_criteria: ["R1.AC1"], files: ["src/export.ts"], symbols: ["exportRecords"], rationale: "Bound memory", alternatives: [], risks: [],
      uncertainty: { status: "decided", confidence: "high", risk: "Store errors", open_alternatives: [], questions: [] } }],
    files: [{ path: "src/export.ts", action: "create", responsibility: "CSV streaming", owner: "Export module" }],
    symbols: [{ id: "exportRecords", file: "src/export.ts", name: "exportRecords", kind: "function", responsibility: "Streaming transformation",
      signature: "exportRecords(): AsyncIterable<string>", inputs: [], outputs: ["CSV rows"], errors: ["StorageError"] }],
    call_paths: [{ entry: "GET /export", symbols: ["exportRecords"], result: "CSV response" }],
    transformations: [{ input: "Repository records", transitions: ["Encode rows"], persistence_operations: ["Snapshot read"], output: "CSV", preserved_invariants: ["Read-only"] }],
    error_flows: [{ origin: "StorageError", translation: "HTTP 503", propagation: ["exportRecords", "HTTP adapter"], visible_result: "Retryable error" }],
    tests: [{ kind: "contract", boundary: "HTTP export", scenario: "Export all records", expected: "Complete CSV", symbols: ["exportRecords"] }],
    constraints: { follow: [], avoid: [], dependencies: [], compatibility: [] } });
  const slices = slicePlanSchema.parse({ schema: "aira.dev/slice-plan/v1", spec_id: "spec_one", revision: sl.id,
    slices: [{ id: "S1", kind: "implementation", title: "Export end-to-end", intent: "Portable records", outcome: "User downloads a CSV", required: true,
      product_outcomes: ["O1"], requirements: ["R1"], acceptance_criteria: ["R1.AC1"], architecture_decisions: ["A1"], program_design_decisions: ["PD1"],
      dependencies: [], tasks: ["T1"], required_verifiers: ["V1"], completion: [{ id: "complete-csv", predicate: "All records exported", verifier: "V1" }],
      demonstration: ["Download and inspect CSV"], risks: [] }] });
  const tasks = tasksSchema.parse({ schema: "aira.dev/tasks/v2", spec_id: "spec_one", revision: ts.id, ordering: "priority-then-task-id-codepoint", tasks: [task()] });
  const plan = verificationPlanSchema.parse({ schema: "aira.dev/verification-plan/v2", spec_id: "spec_one", revision: planRevision.id, profile: profile("verify"),
    verifiers: [{ schema: "aira.dev/verifier/v2", identity: { id: "V1", revision: "rev_v1", hash: hash(70) }, title: "Export contract", requirements: ["R1"], acceptance_criteria: ["R1.AC1"], tasks: ["T1"], slices: ["S1"],
      policy: policyRef("task"), recovery: [{ characteristic: "replay_safe", scope: "local read-only tests", assumptions: [], guarantee: profile("recovery") }],
      required_backend: ["process_confinement"], definition: { kind: "command", executable: "bun", arguments: ["test"], execution_profile: profile("execute") } }], required_verifiers: ["V1"] });
  const revisions = [intent, prod, req, des, pd, sl, ts, planRevision, ...analysisRevisions];
  const subjects = [intent, req, des, ts, planRevision, prod, pd, sl].map((r) => ({ artifact: referenceOf(r), lineage_hash: hash(80) }));
  const approvalOrder = authoringOrder === "architecture-first" ? ["product", "architecture", "requirements", "program-design", "slice-plan", "tasks"] : [...planningKinds];
  const reviewSubjects = approvalOrder.map((kind) => subjects.find((s) => s.artifact.kind === kind)!);
  const approvalSets = mode === "quick" ? [reviewSubjects] : reviewSubjects.map((s) => [s]);
  const approvals = approvalSets.map((set, i) => specApprovalRecordSchema.parse({ schema: "aira.dev/spec-approval/v2", id: `approval_${i + 1}`, spec_id: "spec_one",
    operation: `operation_approve${i + 1}`, actor: human, channel: "cli", observed_generation: String(i), committed_generation: String(i + 1),
    subjects: set, decision: "approved", scope: mode === "quick" ? "integrated" : "artifact",
    ...(mode === "quick" ? { integrated_group: `operation_approve${i + 1}` } : {}), at }));
  const applicability = approvals.flatMap((a) => a.subjects.map((subject) => approvalApplicabilitySchema.parse({ schema: "aira.dev/approval-applicability/v2",
    approval: a.id, spec_id: "spec_one", subject, generation: "10", status: "applicable", carried_from: a.committed_generation,
    reason: "Exact unchanged subjects carried through independent authoring/lifecycle commits", created: metadata })));
  const baseSpec = specSchema.parse({ schema: "aira.dev/spec/v2", id: "spec_one", title: "Export", kind: "feature", mode,
    authoring_order: authoringOrder, lifecycle: { state: "verifying" }, commit_sequence: "20", generation: "10", behavioral_selections: [], behavioral_profiles: [],
    artifacts: { current: subjects, proposed: [], superseded: [] }, analyses: analysisRevisions.map(referenceOf),
    lineage: { validations: [{ schema: "aira.dev/lineage-validation/v2", relation: "validated_against", subject: referenceOf(des), against: [referenceOf(req)],
      analysis: referenceOf(analysisRevisions[3]!), outcome: "consistent", generation: "4", created: metadata }], invalidations: [] },
    approvals: approvals.map((a) => a.id), approval_applicability: applicability, revisions: [], waivers: [], waiver_applicability: [],
    identities: { schema: "aira.dev/identity-registry/v2", entries: [
      { id: "O1", introduced_in: prod.id }, { id: "SC1", introduced_in: prod.id }, { id: "PD1", introduced_in: pd.id }, { id: "S1", introduced_in: sl.id },
      { id: "R1", introduced_in: req.id }, { id: "R1.AC1", introduced_in: req.id }, { id: "A1", introduced_in: des.id },
      { id: "T1", introduced_in: ts.id }, { id: "V1", introduced_in: planRevision.id },
    ] },
    decision_policy: { schema: "aira.dev/spec-decision-policy/v2", identity: policyRef("decision"), waivable: [], required_analyses: [...planningKinds] },
    completion_policy: { schema: "aira.dev/spec-completion-policy/v2", identity: policyRef("complete"), traceability: "must", product_coverage: { outcomes: true, success_criteria: true, evidence: true },
      planning_coverage: { architecture_implementation: true, program_design_exercised: true }, allow_agent_review: false,
      final_consistency_review_required: false, verification_plan_approval_required: false }, created: metadata, updated_at: observed,
    metadata: { labels: [], external_references: [] } });
  const approved = approvedSpecSnapshotSchema.parse({ schema: "aira.dev/approved-spec-snapshot/v2", spec_id: baseSpec.id, generation: "8",
    artifacts: baseSpec.artifacts.current, approvals: baseSpec.approvals, decision_policy: baseSpec.decision_policy.identity,
    completion_policy: baseSpec.completion_policy.identity, verification_profile: plan.profile, capability_policies: [policyRef("task")],
    behavioral_profiles: [], behavioral_assets: baseBehavioralPins() });
  const spec = specSchema.parse({ ...baseSpec, run_binding: { run: "run_one", snapshot: approved, applicable_generation: "10", status: "applicable" } });
  const attempt = attemptRecordSchema.parse({ schema: "aira.dev/attempt/v2", id: "attempt_one", operation: "operation_execute", run: "run_one", task: tasks.tasks[0]!.identity,
    fence: { run: "run_one", claim: "claim_one", attempt: "attempt_one", owner: "local-scheduler", epoch: "1" }, snapshot: approved, run_generation: "3",
    context: [{ id: "snapshot_one", hash: hash(55) }], policy: policyRef("task"), execution_profile: profile("execute"), workspace: fingerprint(), backend: backend(),
    behavior: { purpose: "implementation", pins: baseBehavioralPins() },
    recovery: plan.verifiers[0]!.recovery, started_at: started, ended_at: ended, outcome: "succeeded", external_effects: "known", outputs: [] });
  const state = taskExecutionStateSchema.parse({ schema: "aira.dev/task-state/v1", task: tasks.tasks[0]!.identity, run: "run_one", run_generation: "5", status: "completed",
    current_attempt: attempt.id, updated_at: ended });
  const evidence = verificationEvidenceSchema.parse({ schema: "aira.dev/evidence/v2", id: "evidence_one", spec_id: spec.id, verifier: plan.verifiers[0]!.identity, profile: plan.profile,
    snapshot: approved, task: tasks.tasks[0]!.identity, attempt: attempt.id, workspace_before: fingerprint(), workspace_after: fingerprint(), observation: "stable", backend: backend(),
    policy: policyRef("task"), context: attempt.context, behavioral_assets: baseBehavioralPins(), started_at: started, ended_at: ended, outcome: "passed", outputs: [{ hash: hash(75), bytes: 4, media_type: "text/plain" }],
    requirements: ["R1"], acceptance_criteria: ["R1.AC1"], slices: ["S1"], applicability: { schema: "aira.dev/evidence-applicability/exact-workspace/v1" } });
  const sliceState = sliceExecutionStateSchema.parse({ schema: "aira.dev/slice-state/v1", slice: "S1", plan: referenceOf(sl), run: "run_one", run_generation: "5",
    status: "completed", current_evidence: [{ verifier: "V1", evidence: evidence.id }], updated_at: ended });
  const run = executionRunSchema.parse({ schema: "aira.dev/execution-run/v2", id: "run_one", commit_sequence: "20", generation: "5", snapshot: approved, status: "verifying",
    scheduling: { max_parallel: 1, ordering: "priority-then-task-id-codepoint" }, slices: [sliceState], tasks: [state], claims: [], attempts: [attempt.id],
    authorities: [{ attempt: attempt.id, fence: attempt.fence, snapshot: approved, status: "published", generation: "5" }],
    current_evidence: [{ task: tasks.tasks[0]!.identity, verifier: evidence.verifier.id, evidence: evidence.id, generation: "5" }], created_at: started, updated_at: ended });
  const review = { spec, revisions, analyses, approvals, waivers: [] as import("../../src/approval/spec-records").HumanWaiver[] };
  const catalog = { requirements: requirements.requirements, decisions: architecture.decisions, program_decisions: program_design.decisions, verifiers: plan.verifiers.map((v) => v.identity),
    policies: [policyRef("task")], execution_profiles: [profile("execute")], contexts: [] };
  const workspace = workspaceObservationSchema.parse({ schema: "aira.dev/workspace-observation/v1", fingerprint: fingerprint(), at: observed, consistency: "stable",
    coordination: { identity: "test-observation-barrier", contract: profile("coordination") } });
  const input = { review, product, requirements, architecture, program_design, slices, tasks, plan, catalog, run, attempts: [attempt], evidence: [evidence], workspace, backend: backend(),
    behavioral: { catalog: baseBehavioralCatalog(), environment: syntheticEnvironment(), snapshots: [], contexts: [{ snapshot: snapshot(), verified_content_hash: hash(55) }] },
  } satisfies CompletionInput;
  const evidenceContext = { snapshot: approved, task: tasks.tasks[0]!.identity, attempt, authority: run.authorities[0]!, workspace: fingerprint(), backend: backend(),
    verifier: plan.verifiers[0]!, profile: plan.profile, allow_agent_review: false, selected_evidence: evidence.id } satisfies EvidenceContext;
  return { ...input, spec, review, run, state, attempt, record: evidence, evidenceContext, intent, prod, req, des, pd, sl, ts, sliceState, planRevision, analysisRevisions };
}
