import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

describe("AGENTS import architecture boundaries", () => {
  test("keeps raw guidance import outside prose interpretation, Context, workers, and materialization", async () => {
    const directory = join(root, "src/steering-agents-import");
    const source = (await Promise.all(["types.ts", "mapping.ts", "plan.ts", "apply.ts", "index.ts"]
      .map((name) => readFile(join(directory, name), "utf8")))).join("\n");
    expect(source).not.toContain("resolveSteering");
    expect(source).not.toContain("semantic_key");
    expect(source).not.toContain("TextDecoder");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:context|\/pi\/|\/cli\/|materialization)/);
    expect(source).not.toMatch(/writeFile|mkdir\(|rename\(|unlink\(/);
    expect(source).not.toMatch(/\bLLM\b|openai|anthropic/i);
    expect(source).toContain("SteeringStore");
    expect(source).toContain("agentsObservationBytes");
  });

  test("publishes the dedicated import surface without adding a package dependency", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(manifest.exports?.["./steering-agents-import"]).toBe("./src/steering-agents-import/index.ts");
    expect(manifest.dependencies).toEqual({ yaml: "^2.8.1", zod: "^4.1.5" });
  });
});
