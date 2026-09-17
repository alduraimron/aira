import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applySteeringMaterialization,
  authorableSteeringSemanticsMatch,
  materializationTemporaryPath,
  nativeSteeringSourceMetadata,
  planSteeringMaterialization,
  renderNativeSteeringSource,
  suggestSteeringMaterializationTarget,
} from "../../src/steering-materialization";
import { inspectNativeSteering } from "../../src/steering-source";
import { applySteeringAdoption, planSteeringAdoption } from "../../src/steering-adoption";
import { publish, revision } from "../steering-store/fixtures";
import { steeringResourceRevisionSchema } from "../../src/steering/schema";
import { digest } from "../steering-native-source/fixtures";
import type { SteeringRevisionPublication } from "../../src/storage/steering-types";
import { sourceBytes } from "../steering-native-source/fixtures";
import { customRevision, materializationContext, replacementAuthorization } from "./fixtures";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of clean.splice(0)) await cleanup(); });

async function context(...publications: SteeringRevisionPublication[]) {
  const value = await materializationContext(publications.length ? publications : undefined);
  clean.push(value.cleanup);
  return value;
}

async function plan(
  value: Awaited<ReturnType<typeof materializationContext>>,
  options: Omit<Parameters<typeof planSteeringMaterialization>[0], "project_root" | "project" | "store" | "blobs"> = {},
) {
  return planSteeringMaterialization({ project_root: value.root, project: "acme", store: value.store, blobs: value.store.blobs, ...options });
}

async function apply(
  value: Awaited<ReturnType<typeof materializationContext>>,
  materializationPlan: unknown,
  options: Omit<Parameters<typeof applySteeringMaterialization>[0], "project_root" | "store" | "blobs" | "plan"> = {},
) {
  return applySteeringMaterialization({ project_root: value.root, store: value.store, blobs: value.store.blobs, plan: materializationPlan, ...options });
}

function architectureTarget(root: string): string { return join(root, ".aira", "steering", "architecture.md"); }

async function materializeArchitecture(value: Awaited<ReturnType<typeof materializationContext>>) {
  const materializationPlan = await plan(value);
  expect(materializationPlan.ok).toBe(true);
  if (!materializationPlan.ok) throw new Error(JSON.stringify(materializationPlan.issues));
  const result = await apply(value, materializationPlan.plan);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return { plan: materializationPlan.plan, result: result.result };
}

describe("deterministic native source renderer", () => {
  test("renders a standard authoritative revision with exact body bytes and parser round trip", () => {
    const publication = revision("# Architecture\r\n\r\n  exact body  \r\n");
    const first = renderNativeSteeringSource({
      project: "acme", target_path: ".aira/steering/architecture.md", revision: publication.revision, body: publication.body,
    });
    const second = renderNativeSteeringSource({
      project: "acme", target_path: ".aira/steering/architecture.md", revision: publication.revision, body: publication.body,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.bytes).toEqual(second.bytes);
    expect(Array.from(first.bytes.slice(first.bytes.length - publication.body.length))).toEqual(Array.from(publication.body));
    expect(Array.from(first.parsed.body_bytes)).toEqual(Array.from(publication.body));
    expect(first.parsed.observation.body.hash).toBe(publication.revision.content.hash);
    expect(authorableSteeringSemanticsMatch(publication.revision, first.parsed.proposal)).toBe(true);
    expect(new TextDecoder().decode(first.bytes.slice(0, 4))).toBe("---\n");
  });

  test("renders custom resources under a safe explicit custom suggestion", () => {
    const publication = customRevision();
    const target = suggestSteeringMaterializationTarget(publication.revision);
    expect(target).toBe(".aira/steering/custom/project.steering.api.md");
    const rendered = renderNativeSteeringSource({ project: "acme", target_path: target, revision: publication.revision, body: publication.body });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.parsed.proposal.kind).toBe("custom");
    expect(String(rendered.parsed.proposal.custom_kind)).toBe("api-conventions");
    expect(authorableSteeringSemanticsMatch(publication.revision, rendered.parsed.proposal)).toBe(true);
  });

  test("round trips enforceable bindings and all authorable rule fields", () => {
    const base = revision("# Security\n\nRun static analysis.\n", "1", undefined, "steering.security");
    const binding = {
      kind: "verifier",
      verifier: { id: "V1", revision: "rev_verifier", hash: digest(4) },
      use: "required",
    };
    const authoritative = steeringResourceRevisionSchema.parse({
      ...base.revision,
      default_authority: "enforceable",
      default_override_policy: "sealed",
      default_enforcement: [binding],
      rules: [{
        id: "rule.security.static-analysis",
        title: "Run static analysis",
        authority: "enforceable",
        semantics: { key: "topic.security.static-analysis", effect: "require", value: { command: "lint", strict: true } },
        override_policy: "sealed",
        status: "active",
        scope: { kind: "phase", phases: ["verification"] },
        inclusion: { availability: "required", selector: { kind: "phase", phases: ["verification"] } },
        rationale: "Prevent unsafe releases.",
        enforcement: [binding],
        source: { content_hash: base.revision.content.hash, location: { kind: "heading", heading: "Static analysis" } },
      }],
      metadata: { title: "Security", description: "Release checks", labels: ["security"] },
    });
    const rendered = renderNativeSteeringSource({
      project: "acme", target_path: ".aira/steering/security.md", revision: authoritative, body: base.body,
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.parsed.proposal.default_enforcement).toEqual([expect.objectContaining({ kind: "verifier", use: "required" })]);
    const rule = rendered.parsed.proposal.rules[0]!;
    expect(rule.authority).toBe("enforceable");
    expect(rule.inclusion).toEqual({ availability: "required", selector: { kind: "phase", phases: ["verification"] } });
    expect(rule.scope).toEqual({ kind: "phase", phases: ["verification"] });
    expect(rule.rationale).toBe("Prevent unsafe releases.");
    expect(rule.enforcement[0]).toEqual(expect.objectContaining({ kind: "verifier", use: "required" }));
    expect(rule.source?.content_hash).toBe(authoritative.content.hash);
    expect(authorableSteeringSemanticsMatch(authoritative, rendered.parsed.proposal)).toBe(true);
  });

  test("does not copy publication-only revision or native-source observation fields into frontmatter", () => {
    const publication = revision();
    const rendered = renderNativeSteeringSource({
      project: "acme", target_path: ".aira/steering/architecture.md", revision: publication.revision, body: publication.body,
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const framing = new TextDecoder().decode(rendered.bytes.slice(0, rendered.bytes.length - publication.body.length));
    expect(framing).not.toContain('"revision"');
    expect(framing).not.toContain('"created"');
    expect(framing).not.toContain('"supersedes"');
    expect(framing).not.toContain('"native_source"');
  });
});

describe("read-only materialization planning", () => {
  test("plans an absent target as create without writing a directory or mutating authority", async () => {
    const value = await context();
    const before = await value.store.loadRegistry("acme");
    const materializationPlan = await plan(value);
    expect(materializationPlan.ok).toBe(true);
    if (!materializationPlan.ok) return;
    expect(materializationPlan.plan.actions).toEqual([expect.objectContaining({ kind: "create", target_path: ".aira/steering/architecture.md" })]);
    expect(materializationPlan.plan.create_directories).toEqual([".aira/steering"]);
    expect(Object.isFrozen(materializationPlan.plan)).toBe(true);
    expect(Object.isFrozen(materializationPlan.plan.actions)).toBe(true);
    expect(Object.isFrozen(materializationPlan.plan.actions[0]!)).toBe(true);
    await expect(lstat(join(value.root, ".aira", "steering"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await value.store.loadRegistry("acme")).head).toEqual(before.head);
    expect(String((await value.store.loadRegistry("acme")).registry.generation)).toBe(String(before.registry.generation));
  });

  test("plans and safely creates only the required custom authoring directory", async () => {
    const value = await context(customRevision());
    const materializationPlan = await plan(value);
    expect(materializationPlan.ok).toBe(true);
    if (!materializationPlan.ok) return;
    expect(materializationPlan.plan.actions).toEqual([expect.objectContaining({
      kind: "create", resource: "project.steering.api", target_path: ".aira/steering/custom/project.steering.api.md",
    })]);
    const applied = await apply(value, materializationPlan.plan);
    expect(applied.ok).toBe(true);
    const custom = join(value.root, ".aira", "steering", "custom");
    expect((await lstat(custom)).isDirectory()).toBe(true);
    const inspection = await inspectNativeSteering(value.root, { project: "acme" });
    expect(inspection.proposals.map((source) => String(source.observation.identity.id))).toEqual(["project.steering.api"]);
  });

  test("classifies a parser-valid differently formatted equivalent source as unchanged", async () => {
    const value = await context();
    const current = (await value.store.loadRegistry("acme")).revisions[0]!;
    const body = await value.store.blobs.get(current.content.hash);
    await mkdir(join(value.root, ".aira", "steering"), { recursive: true });
    await writeFile(architectureTarget(value.root), sourceBytes(nativeSteeringSourceMetadata("acme", current), new TextDecoder().decode(body)));
    const materializationPlan = await plan(value);
    expect(materializationPlan.ok).toBe(true);
    if (!materializationPlan.ok) return;
    expect(materializationPlan.plan.actions[0]!.kind).toBe("unchanged");
    const applied = await apply(value, materializationPlan.plan);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.result.status).toBe("no-op");
  });

  test("preserves a different existing human source as conflict unless exact replacement is selected", async () => {
    const value = await context();
    await mkdir(join(value.root, ".aira", "steering"), { recursive: true });
    await writeFile(architectureTarget(value.root), "human unadopted edit\n");
    const conflict = await plan(value);
    expect(conflict.ok).toBe(true);
    if (!conflict.ok) return;
    expect(conflict.plan.actions[0]!.kind).toBe("conflict");
    const replacement = await plan(value, { replace: ["steering.architecture"] });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    expect(replacement.plan.actions[0]!.kind).toBe("replace");
    expect(replacement.plan.authorization.replacement).toBe("required");
  });

  test("rejects exact and portable target collisions and unsafe traversal", async () => {
    const architecture = revision();
    const security = revision("# Security\n", "1", undefined, "steering.security");
    const value = await context(architecture, security);
    const collision = await plan(value, { targets: {
      "steering.architecture": ".aira/steering/same.md",
      "steering.security": ".aira/steering/same.md",
    } });
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.issues.map((issue) => issue.code)).toContain("materialization-target-collision");
    const traversal = await plan(value, { resources: ["steering.architecture"], targets: { "steering.architecture": "../outside.md" } });
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.issues.map((issue) => issue.code)).toContain("materialization-path-unsafe");
  });

  test("rejects a symlinked authoring directory during planning", async () => {
    const value = await context();
    const outside = join(value.root, "outside-directory");
    await mkdir(outside);
    await symlink(outside, join(value.root, ".aira", "steering"), "dir");
    const materializationPlan = await plan(value);
    expect(materializationPlan.ok).toBe(false);
    if (!materializationPlan.ok) expect(materializationPlan.issues.map((issue) => issue.code)).toContain("materialization-path-unsafe");
  });

  test("rejects symlink and nonregular target paths during planning", async () => {
    const value = await context();
    const outside = join(value.root, "outside.md");
    await writeFile(outside, "outside");
    await mkdir(join(value.root, ".aira", "steering"), { recursive: true });
    await symlink(outside, architectureTarget(value.root));
    const linkPlan = await plan(value);
    expect(linkPlan.ok).toBe(false);
    if (!linkPlan.ok) expect(linkPlan.issues.map((issue) => issue.code)).toContain("materialization-path-unsafe");
    await rm(architectureTarget(value.root));
    const fifo = architectureTarget(value.root);
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const fifoPlan = await plan(value);
    expect(fifoPlan.ok).toBe(false);
    if (!fifoPlan.ok) expect(fifoPlan.issues.map((issue) => issue.code)).toContain("materialization-path-unsafe");
  });
});

describe("freshness, authorization, and per-file publication", () => {
  test("protects unadopted local edits and rejects a replacement stale after planning", async () => {
    const value = await context();
    await materializeArchitecture(value);
    const target = architectureTarget(value.root);
    await writeFile(target, "first human edit\n");
    const replacement = await plan(value, { replace: ["steering.architecture"] });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    await writeFile(target, "later human edit\n");
    const applied = await apply(value, replacement.plan, { authorization: replacementAuthorization(replacement.plan) });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.issues.map((issue) => issue.code)).toContain("materialization-target-stale");
    expect(await readFile(target, "utf8")).toBe("later human edit\n");
  });

  test("requires a human for replacement and rejects worker authorization", async () => {
    const value = await context();
    await mkdir(join(value.root, ".aira", "steering"), { recursive: true });
    await writeFile(architectureTarget(value.root), "human\n");
    const replacement = await plan(value, { replace: ["steering.architecture"] });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    const missing = await apply(value, replacement.plan);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues.map((issue) => issue.code)).toContain("materialization-replacement-unauthorized");
    const worker = await apply(value, replacement.plan, { authorization: {
      ...replacementAuthorization(replacement.plan), by: { kind: "worker", id: "worker", implementation: "test" },
    } });
    expect(worker.ok).toBe(false);
    if (!worker.ok) expect(worker.issues.map((issue) => issue.code)).toContain("materialization-worker-unauthorized");
  });

  test("rejects a changed authoritative HEAD and generation without writing", async () => {
    const value = await context();
    const materializationPlan = await plan(value);
    expect(materializationPlan.ok).toBe(true);
    if (!materializationPlan.ok) return;
    const security = revision("# Security\n", "1", undefined, "steering.security");
    await value.store.commit(publish(await value.store.loadRegistry("acme"), security, "operation_materialization_authority_change"), [security]);
    const applied = await apply(value, materializationPlan.plan);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.issues.map((issue) => issue.code)).toContain("materialization-authority-stale");
    await expect(lstat(architectureTarget(value.root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("revalidates authoritative HEAD immediately before rename", async () => {
    const value = await context();
    const materializationPlan = await plan(value);
    expect(materializationPlan.ok).toBe(true);
    if (!materializationPlan.ok) return;
    const security = revision("# Security\n", "1", undefined, "steering.security");
    const applied = await apply(value, materializationPlan.plan, { file_options: {
      failpoint: async (point) => {
        if (point === "before-target-publication")
          await value.store.commit(publish(await value.store.loadRegistry("acme"), security, "operation_materialization_race_authority"), [security]);
      },
    } });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.issues.map((issue) => issue.code)).toContain("materialization-authority-stale");
    await expect(lstat(architectureTarget(value.root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("revalidates an absent create target immediately before rename", async () => {
    const value = await context();
    const materializationPlan = await plan(value);
    expect(materializationPlan.ok).toBe(true);
    if (!materializationPlan.ok) return;
    const target = architectureTarget(value.root);
    const applied = await apply(value, materializationPlan.plan, { file_options: {
      failpoint: async (point) => {
        if (point === "before-target-publication") await writeFile(target, "intervening human edit\n");
      },
    } });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.issues.map((issue) => issue.code)).toContain("materialization-target-stale");
    expect(await readFile(target, "utf8")).toBe("intervening human edit\n");
  });

  test("uses crash-safe temp publication: a pre-publication failure leaves no partial target", async () => {
    const value = await context();
    const materializationPlan = await plan(value);
    expect(materializationPlan.ok).toBe(true);
    if (!materializationPlan.ok) return;
    const applied = await apply(value, materializationPlan.plan, { file_options: {
      failpoint: (point) => { if (point === "after-temp-fsync") throw new Error("stop before rename"); },
    } });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.result?.status).toBe("failed-before-write");
    await expect(lstat(architectureTarget(value.root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports a complete published file honestly when failure is injected after rename", async () => {
    const value = await context();
    const materializationPlan = await plan(value);
    expect(materializationPlan.ok).toBe(true);
    if (!materializationPlan.ok) return;
    const applied = await apply(value, materializationPlan.plan, { file_options: {
      failpoint: (point) => { if (point === "after-target-publication") throw new Error("stop after rename"); },
    } });
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.result?.status).toBe("partial");
      expect(applied.result?.partial_applied_files).toHaveLength(1);
    }
    const inspected = await inspectNativeSteering(value.root, { project: "acme" });
    expect(inspected.status).toBe("valid");
    expect(inspected.proposals).toHaveLength(1);
  });

  test("rejects a colliding same-directory temporary safely", async () => {
    const value = await context();
    await mkdir(join(value.root, ".aira", "steering"), { recursive: true });
    const materializationPlan = await plan(value);
    expect(materializationPlan.ok).toBe(true);
    if (!materializationPlan.ok) return;
    const token = "a".repeat(48);
    await writeFile(join(value.root, materializationTemporaryPath(".aira/steering/architecture.md", token)), "debris");
    const applied = await apply(value, materializationPlan.plan, { file_options: { token: () => token } });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.issues.map((issue) => issue.code)).toContain("materialization-path-unsafe");
    await expect(lstat(architectureTarget(value.root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("writes multiple files in deterministic order and reports partial publication", async () => {
    const architecture = revision();
    const security = revision("# Security\n", "1", undefined, "steering.security");
    const value = await context(architecture, security);
    const materializationPlan = await plan(value);
    expect(materializationPlan.ok).toBe(true);
    if (!materializationPlan.ok) return;
    expect(materializationPlan.plan.actions.map((action) => action.target_path)).toEqual([
      ".aira/steering/architecture.md", ".aira/steering/security.md",
    ]);
    let writes = 0;
    const applied = await apply(value, materializationPlan.plan, { file_options: {
      failpoint: (point) => {
        if (point === "after-temp-write" && ++writes === 2) throw new Error("second file stops");
      },
    } });
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.result?.status).toBe("partial");
      expect(applied.result?.created_files.map((file) => file.target_path)).toEqual([".aira/steering/architecture.md"]);
      expect(applied.result?.partial_applied_files.map((file) => file.target_path)).toEqual([".aira/steering/architecture.md"]);
    }
    expect(await readFile(architectureTarget(value.root), "utf8")).toContain("---");
    await expect(lstat(join(value.root, ".aira", "steering", "security.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(String((await value.store.loadRegistry("acme")).registry.generation)).toBe("0");
  });
});

describe("authority and application boundaries", () => {
  test("never advances Steering state or commits while materializing", async () => {
    const value = await context();
    const before = await value.store.loadRegistry("acme");
    const materializationPlan = await plan(value);
    expect(materializationPlan.ok).toBe(true);
    if (!materializationPlan.ok) return;
    const applied = await apply(value, materializationPlan.plan);
    expect(applied.ok).toBe(true);
    const after = await value.store.loadRegistry("acme");
    expect(after.head).toEqual(before.head);
    expect(after.registry).toEqual(before.registry);
    expect(after.revisions).toEqual(before.revisions);
  });

  test("does not create unrelated standard files", async () => {
    const value = await context();
    const materializationPlan = await plan(value);
    expect(materializationPlan.ok).toBe(true);
    if (!materializationPlan.ok) return;
    await apply(value, materializationPlan.plan);
    await expect(lstat(join(value.root, ".aira", "steering", "security.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("materialization modules do not own authority commits, templates, interoperability, Context, Pi, or CLI", async () => {
    const root = join(import.meta.dir, "../../src/steering-materialization");
    const source = (await Promise.all(["types.ts", "render.ts", "plan.ts", "apply.ts", "fs.ts", "index.ts"]
      .map((name) => readFile(join(root, name), "utf8")))).join("\n");
    expect(source).not.toMatch(/AGENTS\.md/);
    expect(source).not.toMatch(/template/i);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:\/pi\/|\/cli\/|context\/)/);
    expect(source).not.toMatch(/\.commit\s*\(/);
  });

  test("materialize then unchanged adoption does not manufacture a successor revision", async () => {
    const value = await context();
    await materializeArchitecture(value);
    const inspection = await inspectNativeSteering(value.root, { project: "acme" });
    const adoption = planSteeringAdoption({ inspection, registry: await value.store.loadRegistry("acme") });
    expect(adoption.ok).toBe(true);
    if (!adoption.ok) return;
    expect(adoption.plan.actions).toEqual([expect.objectContaining({ kind: "unchanged", resource: "steering.architecture" })]);
    const applied = await applySteeringAdoption({
      project_root: value.root,
      store: value.store,
      plan: adoption.plan,
      operation: "operation_materialized_source_noop_adoption",
      authorization: {
        schema: "aira.dev/steering-adoption-authorization/v1",
        project: "acme",
        plan: { id: adoption.plan.id, hash: adoption.plan.hash },
        by: { kind: "human", id: "local" },
        decided_at: "2026-08-26T12:00:00.000Z",
        channel: "api",
      },
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.result.status).toBe("no-op");
    const after = await value.store.loadRegistry("acme");
    expect(after.registry.resources[0]!.revisions).toHaveLength(1);
    expect(String(after.registry.generation)).toBe("0");
  });
});
