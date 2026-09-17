import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import {
  buildSteeringSnapshot,
  canonicalSteeringSelectors,
  resolveSteering,
  steeringSnapshotSemanticBytes,
} from "../../../src/steering";
import {
  canonicalBytes as sharedCanonicalBytes,
  hashBytes as sharedHashBytes,
  hashCanonical as sharedHashCanonical,
} from "../../../src/canonical-json";
import {
  canonicalBytes as storageCanonicalBytes,
  hashCanonical as storageHashCanonical,
} from "../../../src/storage/file/canonical-json";
import { namedRule, policyBinding, request, revision, verifierBinding } from "./fixtures";

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values]; let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

describe("05C-3A deterministic snapshot encoding", () => {
  test("32 catalog/selection permutations produce identical payload bytes and IDs", () => {
    const bindings = canonicalSteeringSelectors([policyBinding("one"), verifierBinding()]);
    const a = revision("a", { rules: [namedRule("a", { ordered: true }, { authority: "enforceable", enforcement: bindings })] });
    const b = revision("b", { rules: [namedRule("b", { ordered: true }, { authority: "enforceable", enforcement: bindings })] });
    const input = request([a, b]);
    const baselineResult = buildSteeringSnapshot(resolveSteering(input));
    expect(baselineResult.ok).toBe(true);
    if (!baselineResult.ok) return;
    const baseline = baselineResult.value;
    for (let seed = 1; seed <= 32; seed++) {
      const result = buildSteeringSnapshot(resolveSteering({
        ...input,
        catalog: shuffled(input.catalog, seed),
        selections: shuffled(input.selections, seed + 10),
        available_enforcement: shuffled(input.available_enforcement, seed + 20),
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.id).toBe(baseline.id);
      expect(steeringSnapshotSemanticBytes(result.value)).toEqual(steeringSnapshotSemanticBytes(baseline));
    }
  });

  test("shared canonical primitive preserves the established storage bytes and SHA-256 representation", () => {
    for (const value of [null, "é", [1, "two"], { z: 1, a: { b: true } }]) {
      expect(sharedCanonicalBytes(value)).toEqual(storageCanonicalBytes(value));
      expect(sharedHashCanonical(value)).toBe(storageHashCanonical(value));
    }
    expect(String(sharedHashCanonical("abc"))).toBe("sha256:6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25");
    const encoder = new TextEncoder();
    expect(String(sharedHashBytes(encoder.encode(""))))
      .toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(String(sharedHashBytes(encoder.encode("abc"))))
      .toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(String(sharedHashBytes(encoder.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))))
      .toBe("sha256:248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });
});

test("05C-3A modules remain pure and snapshot construction never calls resolution or persistence", async () => {
  const directory = path.resolve(import.meta.dir, "../../../src/steering");
  for (const name of ["snapshot.ts", "dependency.ts", "staleness.ts"]) {
    const source = await readFile(path.join(directory, name), "utf8");
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        throw new Error(`dynamic import in ${name}`);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(imports.every((reference) => reference === "zod" || reference.startsWith("."))).toBe(true);
    expect(source).not.toMatch(/from\s+["']node:|storage\/file|BlobStore|SpecStore|SteeringStore|Date\.now|Math\.random/);
    if (name === "snapshot.ts") expect(source).not.toMatch(/\bresolveSteering\s*\(/);
  }
});
