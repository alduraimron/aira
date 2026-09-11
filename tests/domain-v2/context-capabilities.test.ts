import { describe, expect, test } from "bun:test";
import { contextDeclarationSchema, matchesPath, deterministicGlobSchema } from "../../src/context/declarations";
import { contextSnapshotSchema, validateSnapshotDeclarations } from "../../src/context/snapshot";
import { capabilityPolicySchema, effectiveCapabilityPolicySchema, capabilityEscalationSchema } from "../../src/capabilities/schema";
import { capabilityDecision, compileCapabilityPolicy, composeCapabilityPolicies } from "../../src/capabilities/policy";
import { workspaceFingerprintSchema, executionBackendCapabilitiesSchema } from "../../src/workspace/schema";
import { sameWorkspaceFingerprint, checkBackendRequirements } from "../../src/workspace/fingerprint";
import { fixture, snapshot, declaration, hash, capabilityPolicy, backend, fingerprint, profile, metadata, human } from "./fixtures";

describe("INV-CONTEXT-001: declarations/snapshots are knowledge, not grants", () => {
  test("ordered hash/size snapshot matches required declaration", () => {
    const s = snapshot(), d = declaration();
    expect(validateSnapshotDeclarations(s, [d])).toEqual([]);
    expect(s.entries[0]!.classification).toBe("untrusted");
    expect(s).not.toHaveProperty("capabilities");
  });
  test("required and optional missing declarations remain distinct", () => {
    const empty = contextSnapshotSchema.parse({ ...snapshot(), entries: [], total_bytes: 0 });
    expect(validateSnapshotDeclarations(empty, [declaration()])).toEqual([{ code: "required-context-missing", subject: "context_code" }]);
    expect(validateSnapshotDeclarations(empty, [declaration(false)])).toEqual([]);
  });
  test("phase/task selector controls declaration applicability", () => {
    const d = contextDeclarationSchema.parse({ ...declaration(), tasks: { kind: "selected", ids: ["T2"] } });
    const empty = contextSnapshotSchema.parse({ ...snapshot(), entries: [], total_bytes: 0 });
    expect(validateSnapshotDeclarations(empty, [d])).toEqual([]);
  });
  test("strictly ascending logical paths and contiguous order are required", () => {
    const s = snapshot(), second = { ...s.entries[0]!, logical_path: "src/b.ts", order: 1 };
    expect(contextSnapshotSchema.safeParse({ ...s, entries: [s.entries[0], second], total_bytes: 20 }).success).toBe(true);
    expect(contextSnapshotSchema.safeParse({ ...s, entries: [second, s.entries[0]], total_bytes: 20 }).success).toBe(false);
    expect(contextSnapshotSchema.safeParse({ ...s, entries: [{ ...s.entries[0], order: 1 }] }).success).toBe(false);
  });
  test("hash/size/total are required, bounded and exact", () => {
    const s = snapshot();
    for (const entry of [{ ...s.entries[0], content_hash: undefined }, { ...s.entries[0], byte_size: -1 }, { ...s.entries[0], byte_size: Number.MAX_SAFE_INTEGER + 1 }])
      expect(contextSnapshotSchema.safeParse({ ...s, entries: [entry] }).success).toBe(false);
    expect(contextSnapshotSchema.safeParse({ ...s, total_bytes: 11 }).success).toBe(false);
    expect(validateSnapshotDeclarations(s, [{ ...declaration(), max_bytes: 1 }]).map((i) => i.code)).toContain("context-size-exceeded");
  });
  test("inclusion, reason, classification, and source bindings are checked", () => {
    const s = snapshot(); s.entries[0]!.classification = "public";
    expect(validateSnapshotDeclarations(s, [declaration()]).map((i) => i.code)).toContain("context-declaration-mismatch");
    expect(contextSnapshotSchema.safeParse({ ...snapshot(), entries: [{ ...snapshot().entries[0], inclusion: "summary" }] }).success).toBe(false);
  });
  test("deterministic glob grammar supports ** without platform enumeration", () => {
    const glob = { kind: "glob" as const, pattern: "src/**/*.ts", dialect: "aira.dev/glob/v1" as const };
    expect(matchesPath(glob, "src/a.ts")).toBe(true); expect(matchesPath(glob, "src/deep/a.ts")).toBe(true);
    expect(matchesPath(glob, "src/a.js")).toBe(false); expect(matchesPath(glob, "src/../secret.ts")).toBe(false);
    for (const pattern of ["../src/*", "/src/*", "src/{a,b}.ts", "src/a**.ts", "src\\*.ts"])
      expect(deterministicGlobSchema.safeParse(pattern).success).toBe(false);
  });
});

describe("INV-CAP-001/002/003/004: deny-wins, restriction-only composition", () => {
  test("deny and protected paths override grants", () => {
    const p = capabilityPolicy(); p.filesystem.read.deny.push({ kind: "exact", path: "src/no.ts" });
    const effective = composeCapabilityPolicies(p);
    for (const logical_path of ["src/no.ts", "src/secrets/key.ts", "elsewhere/a.ts", "src/../secret.ts"])
      expect(capabilityDecision(effective, { kind: "filesystem", action: "read", logical_path })).toBe("deny");
    expect(capabilityDecision(effective, { kind: "filesystem", action: "read", logical_path: "src/ok.ts" })).toBe("allow");
  });
  test("child grant cannot widen stronger parent, including unlike path selectors", () => {
    const parent = capabilityPolicy(), child = capabilityPolicy();
    parent.filesystem.write.allow = [{ kind: "exact", path: "src/only.ts" }];
    child.filesystem.write.allow = [{ kind: "glob", pattern: "**", dialect: "aira.dev/glob/v1" }];
    const effective = composeCapabilityPolicies(parent, child);
    expect(capabilityDecision(effective, { kind: "filesystem", action: "write", logical_path: "src/other.ts" })).toBe("deny");
    expect(capabilityDecision(effective, { kind: "filesystem", action: "write", logical_path: "src/only.ts" })).toBe("allow");
    expect(capabilityDecision(composeCapabilityPolicies(child, parent), { kind: "filesystem", action: "write", logical_path: "src/other.ts" })).toBe("deny");
  });
  test("backend requirements are a union of restrictions; cannot drop parent hard requirements", () => {
    const parent = capabilityPolicy(), child = capabilityPolicy(); child.required_backend = ["force_termination"];
    const effective = composeCapabilityPolicies(parent, child);
    expect(effective.required_backend).toContain("filesystem_read_confinement"); expect(effective.required_backend).toContain("force_termination");
    expect(effectiveCapabilityPolicySchema.safeParse({ ...effective, required_backend: [] }).success).toBe(false);
  });
  test("unrestricted shell + tool allowlist cannot claim backend confinement", () => {
    const effective = composeCapabilityPolicies(capabilityPolicy());
    expect(capabilityDecision(effective, { kind: "process", profile: profile("execute"), arbitrary_shell: true })).toBe("allow");
    expect(compileCapabilityPolicy(effective, backend(false)).backend_compatible).toBe(false);
    expect(compileCapabilityPolicy(effective, backend(true)).backend_compatible).toBe(true);
  });
  test("tool implementation substitution cannot inherit a trusted name", () => {
    const p = capabilityPolicy(), tool = p.tools.allow[0]!, effective = composeCapabilityPolicies(p);
    expect(capabilityDecision(effective, { kind: "tool", tool })).toBe("allow");
    expect(capabilityDecision(effective, { kind: "tool", tool: { ...tool, integrity: hash(601) } })).toBe("deny");
    p.tools.deny.push({ name: "read" });
    expect(capabilityDecision(composeCapabilityPolicies(p), { kind: "tool", tool })).toBe("deny");
    expect(capabilityPolicySchema.safeParse({ ...p, tools: { allow: [{ name: "read" }], deny: [] } }).success).toBe(false);
  });
  test("network allowlisting and deny dominate asks; env restrictions intersect", () => {
    const p = capabilityPolicy();
    p.network = { mode: "ask", destinations: [{ host: "example.com", port: 443, protocol: "tcp" }], deny: [] };
    const request = { kind: "network" as const, destination: { host: "example.com", port: 443, protocol: "tcp" as const } };
    expect(capabilityDecision(composeCapabilityPolicies(p), request)).toBe("requires-human-escalation");
    const parent = capabilityPolicy(); parent.network = { mode: "deny" };
    expect(capabilityDecision(composeCapabilityPolicies(parent, p), request)).toBe("deny");
    expect(capabilityDecision(composeCapabilityPolicies(p), { kind: "environment", name: "LANG", ambient: true })).toBe("deny");
  });
  test("escalation provenance is human and cannot make an incapable backend capable", () => {
    const f = fixture(), p = capabilityPolicy();
    const record = { schema: "aira.dev/capability-escalation/v1", operation: "operation_escalate", actor: human,
      spec_id: f.spec.id, generation: f.spec.generation, policies: [p.identity], request: { kind: "process", profile: profile("execute"), arbitrary_shell: true },
      decision: "allowed", reason: "Explicit review", at: metadata.at };
    expect(capabilityEscalationSchema.safeParse(record).success).toBe(true);
    expect(capabilityEscalationSchema.safeParse({ ...record, actor: { kind: "model", id: "local" } }).success).toBe(false);
    expect(compileCapabilityPolicy(composeCapabilityPolicies(p), backend(false)).backend_compatible).toBe(false);
  });
  test("composition does not mutate parent or child", () => {
    const p = capabilityPolicy(), before = JSON.stringify(p), effective = composeCapabilityPolicies(p);
    expect(effective.layers[0] === p).toBe(false);
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe("INV-WORKSPACE-001/002: provider-neutral exact fingerprints", () => {
  test("equality includes content, policy, provider, algorithm and workspace identity", () => {
    const original = fingerprint(); expect(sameWorkspaceFingerprint(original, structuredClone(original))).toBe(true);
    const mutations = [
      { ...original, digest: hash(700) },
      { ...original, algorithm: { ...original.algorithm, hash: hash(701) } },
      { ...original, provider: { ...original.provider, identity: { ...original.provider.identity, configuration_hash: hash(702) } } },
      { ...original, state: { ...original.state, untracked_content_hash: hash(703) } },
      { ...original, capture_policy: { ...original.capture_policy, ignored: "excluded" as const } },
    ];
    for (const changed of mutations) expect(sameWorkspaceFingerprint(original, changed)).toBe(false);
    expect(workspaceFingerprintSchema.safeParse({ ...original, schema: "aira.dev/workspace-fingerprint/v2" }).success).toBe(false);
  });
  test("configured backend capabilities, not worktree/container labels", () => {
    expect(executionBackendCapabilitiesSchema.safeParse({ filesystem_read_confinement: true }).success).toBe(false);
    expect(executionBackendCapabilitiesSchema.safeParse({ ...backend().capabilities, sandbox: true }).success).toBe(false);
    expect(checkBackendRequirements(["force_termination"], backend(false))).toEqual([{ code: "backend-capability-unavailable", subject: "force_termination" }]);
  });
});
