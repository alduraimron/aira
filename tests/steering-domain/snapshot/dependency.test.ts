import { describe, expect, test } from "bun:test";
import {
  STEERING_DEPENDENCY_SCHEMA,
  bindSteeringDependency,
  steeringDependencySchema,
  validateSteeringDependency,
} from "../../../src/steering";
import { hash, namedRule, policyBinding, revision, snapshot } from "./fixtures";

const implementationSubject = { kind: "implementation-attempt" as const, attempt: "attempt_one" as const };

describe("05C-3A immutable Steering dependency binding", () => {
  test("whole-snapshot mode pins both snapshot ID and semantic hash", () => {
    const value = snapshot([revision("root")]);
    const result = bindSteeringDependency(value, {
      phase: "implementation",
      subject: implementationSubject,
      dependency: { mode: "whole-snapshot" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      schema: STEERING_DEPENDENCY_SCHEMA,
      project: "acme",
      snapshot: { id: value.id, hash: value.content.hash },
      phase: "implementation",
      dependency: { mode: "whole-snapshot" },
    });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.snapshot)).toBe(true);
  });

  test("declared mode supports exact resource, rule, semantic-key, and enforcement observations", () => {
    const binding = policyBinding("one");
    const root = revision("root", { rules: [namedRule("root", "protected", {
      authority: "enforceable", enforcement: [binding],
    })] });
    const value = snapshot([root]);
    const rule = { resource: root.identity, rule: root.rules[0]!.id };
    for (const dependency of [
      { mode: "declared" as const, resources: [root.identity], semantic_keys: [], rules: [], enforcement: [] },
      { mode: "declared" as const, resources: [], semantic_keys: [root.rules[0]!.semantics.key], rules: [], enforcement: [] },
      { mode: "declared" as const, resources: [], semantic_keys: [], rules: [rule], enforcement: [] },
      { mode: "declared" as const, resources: [], semantic_keys: [], rules: [], enforcement: [binding] },
    ]) {
      const result = bindSteeringDependency(value, { phase: "implementation", subject: implementationSubject, dependency });
      expect(result.ok).toBe(true);
      if (result.ok) expect(validateSteeringDependency(result.value, value)).toEqual([]);
    }
  });

  test("fine-grained mode fails closed for empty or unobserved declarations", () => {
    const value = snapshot([revision("root")]);
    const empty = bindSteeringDependency(value, {
      phase: "implementation", subject: implementationSubject,
      dependency: { mode: "declared", resources: [], semantic_keys: [], rules: [], enforcement: [] },
    });
    expect(empty).toMatchObject({ ok: false, issues: expect.arrayContaining([
      expect.objectContaining({ code: "steering-dependency-required-input-missing" }),
    ]) });
    const missing = bindSteeringDependency(value, {
      phase: "implementation", subject: implementationSubject,
      dependency: { mode: "declared", resources: [], semantic_keys: ["topic.missing" as never], rules: [], enforcement: [] },
    });
    expect(missing).toMatchObject({ ok: false, issues: expect.arrayContaining([
      expect.objectContaining({ code: "steering-dependency-observation-not-in-snapshot" }),
    ]) });
  });

  test("canonical planning artifacts bind through existing exact artifact references", () => {
    const root = revision("product-guidance");
    const value = snapshot([root], { action: { phase: "product", paths: { status: "known", paths: [] } } });
    const result = bindSteeringDependency(value, {
      phase: "product",
      subject: { kind: "planning-artifact", artifact: { kind: "product", revision: "rev_product", hash: hash(9) } },
      dependency: { mode: "whole-snapshot" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.subject.kind).toBe("planning-artifact");
      if (result.value.subject.kind === "planning-artifact") {
        expect(result.value.subject.artifact.kind).toBe("product");
        expect(result.value.subject.artifact.revision).toBe("rev_product" as never);
        expect(result.value.subject.artifact.hash).toBe(hash(9));
      }
    }
  });

  test("planning phase mismatch is rejected and execution/verification/review subjects remain representable", () => {
    const product = snapshot([revision("product-guidance")], { action: { phase: "product" } });
    expect(bindSteeringDependency(product, {
      phase: "product",
      subject: { kind: "planning-artifact", artifact: { kind: "requirements", revision: "rev_requirements", hash: hash(8) } },
      dependency: { mode: "whole-snapshot" },
    })).toMatchObject({ ok: false, issues: [{ code: "steering-dependency-subject-phase-mismatch" }] });

    for (const candidate of [
      { schema: STEERING_DEPENDENCY_SCHEMA, project: "acme", snapshot: { id: product.id, hash: product.content.hash },
        phase: "implementation", subject: { kind: "implementation-attempt", attempt: "attempt_one" }, dependency: { mode: "whole-snapshot" } },
      { schema: STEERING_DEPENDENCY_SCHEMA, project: "acme", snapshot: { id: product.id, hash: product.content.hash },
        phase: "verification", subject: { kind: "verification-evidence", evidence: "evidence_one" }, dependency: { mode: "whole-snapshot" } },
      { schema: STEERING_DEPENDENCY_SCHEMA, project: "acme", snapshot: { id: product.id, hash: product.content.hash },
        phase: "review", subject: { kind: "review-operation", operation: "operation_review" }, dependency: { mode: "whole-snapshot" } },
    ]) expect(steeringDependencySchema.safeParse(candidate).success).toBe(true);
  });

  test("relevance scope must overlap an observed resolved scope", () => {
    const root = revision("scoped", { scope: { kind: "path", selectors: [{ kind: "tree", path: "src/auth" }] } });
    const value = snapshot([root]);
    const result = bindSteeringDependency(value, {
      phase: "implementation", subject: implementationSubject,
      relevance: { scope: { kind: "path", selectors: [{ kind: "tree", path: "src/payments" }] } },
      dependency: { mode: "whole-snapshot" },
    });
    expect(result).toMatchObject({ ok: false, issues: [{ code: "steering-dependency-relevance-unproven" }] });
  });
});
