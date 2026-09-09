import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");

describe("Aira Pi package", () => {
  test("declares the extension, skill, exports, and Pi-owned peers", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    ) as {
      private?: boolean;
      keywords?: string[];
      exports?: Record<string, string>;
      pi?: { extensions?: string[]; skills?: string[] };
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    expect(manifest.private).toBe(true);
    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.pi).toEqual({
      extensions: ["./src/pi/extension.ts"],
      skills: ["./skills/aira"],
    });
    expect(manifest.exports).toMatchObject({
      ".": "./src/index.ts",
      "./core": "./src/core/index.ts",
      "./agent": "./src/agent/index.ts",
      "./pi": "./src/pi/index.ts",
    });

    for (const dependency of [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "typebox",
    ]) {
      expect(manifest.peerDependencies?.[dependency]).toBe("*");
      expect(manifest.dependencies?.[dependency]).toBeUndefined();
      expect(manifest.devDependencies?.[dependency]).toBeDefined();
    }

    for (const resource of [
      "src/pi/extension.ts",
      "skills/aira/SKILL.md",
      "src/core/index.ts",
    ]) {
      expect((await stat(path.join(root, resource))).isFile()).toBe(true);
    }
  });

  test("Pi discovers the package command and skill without a model", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "aira-pi-package-"));

    try {
      const child = Bun.spawn(
        [
          path.join(root, "node_modules", ".bin", "pi"),
          "--mode",
          "rpc",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "-e",
          ".",
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      child.stdin.write(
        `${JSON.stringify({ type: "get_commands", id: "package-smoke" })}\n`,
      );
      child.stdin.end();
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const response = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as any)
        .find((entry) => entry.id === "package-smoke");
      const names = response?.data?.commands?.map(
        (command: { name: string }) => command.name,
      );
      expect(names).toContain("aira");
      expect(names).toContain("skill:aira");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  test("bundled skill contains the handoff and safety rules", async () => {
    const skill = await readFile(
      path.join(root, "skills/aira/SKILL.md"),
      "utf8",
    );

    for (const instruction of [
      "aira_project",
      "self-contained brief",
      "Do not forward the conversation transcript",
      "Never auto-approve",
      "aira_continue",
      "manual intervention",
      "fresh bounded worker Pi session",
      "Do not start Aira while the user is brainstorming",
    ]) {
      expect(skill).toContain(instruction);
    }
  });
});
