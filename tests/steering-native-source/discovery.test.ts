import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  inspectNativeSteering,
  nativeSteeringDiscoveryPolicy,
} from "../../src/steering-source";
import { putSource, sourceBytes, sourceMetadata, temporaryProject } from "./fixtures";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const remove of cleanup.splice(0)) await remove(); });

async function project() {
  const value = await temporaryProject();
  cleanup.push(value.cleanup);
  return value;
}

const allCodes = (inspection: Awaited<ReturnType<typeof inspectNativeSteering>>): string[] => [
  ...inspection.warnings,
  ...inspection.unsafe_paths,
  ...inspection.invalid_sources.flatMap((source) => source.issues),
].map((issue) => issue.code);

describe("native Steering discovery policy", () => {
  test("discovers standard and recursively bounded custom Markdown", async () => {
    const context = await project();
    await putSource(context.steering, "architecture.md");
    await putSource(context.steering, "custom/api/rest.md", sourceMetadata({
      id: "project.steering.api" as never,
      kind: "custom",
      custom_kind: "api-conventions" as never,
      title: "API conventions",
      labels: ["api"],
      rules: [],
    }));
    const inspection = await inspectNativeSteering(context.root, { project: "acme" });
    expect(inspection.status).toBe("valid");
    expect(inspection.complete).toBe(true);
    expect(inspection.proposals.map((entry) => String(entry.observation.identity.id))).toEqual([
      "project.steering.api",
      "steering.architecture",
    ]);
    expect(inspection.discovered_sources.map((entry) => entry.source_path)).toEqual([
      ".aira/steering/architecture.md",
      ".aira/steering/custom/api/rest.md",
    ]);
  });

  test("ordering is independent of physical creation and directory enumeration order", async () => {
    const first = await project(), second = await project();
    const resources = [
      ["operations.md", sourceMetadata({ id: "steering.operations" as never, kind: "operations", title: "Operations", labels: [], rules: [] })],
      ["architecture.md", sourceMetadata()],
      ["testing.md", sourceMetadata({ id: "steering.testing" as never, kind: "testing", title: "Testing", labels: [], rules: [] })],
    ] as const;
    for (const [name, metadata] of resources) await putSource(first.steering, name, metadata);
    for (const [name, metadata] of [...resources].reverse()) await putSource(second.steering, name, metadata);
    const left = await inspectNativeSteering(first.root, { project: "acme" });
    const right = await inspectNativeSteering(second.root, { project: "acme" });
    const normalized = (inspection: typeof left) => ({
      paths: inspection.discovered_sources.map((source) => source.source_path),
      proposals: inspection.proposals.map((proposal) => ({
        id: proposal.observation.identity.id,
        path: proposal.observation.source_path,
        source: proposal.observation.source.hash,
        body: proposal.observation.body.hash,
      })),
      warnings: inspection.warnings.map((warning) => warning.code),
    });
    expect(normalized(left)).toEqual(normalized(right));
  });

  test("duplicate logical identities across root and custom are explicit and never adoption-eligible", async () => {
    const context = await project();
    await putSource(context.steering, "architecture.md");
    await putSource(context.steering, "custom/system.md");
    const inspection = await inspectNativeSteering(context.root, { project: "acme" });
    expect(inspection.status).toBe("invalid");
    expect(inspection.proposals).toHaveLength(0);
    expect(inspection.duplicate_identities).toEqual([expect.objectContaining({
      resource_id: "steering.architecture",
      paths: [".aira/steering/architecture.md", ".aira/steering/custom/system.md"],
    })]);
    expect(inspection.invalid_sources).toHaveLength(2);
    expect(inspection.invalid_sources.every((source) => source.parsed !== undefined)).toBe(true);
  });

  test("unsupported extensions are observed as warnings but never read as sources", async () => {
    const context = await project();
    await writeFile(join(context.steering, "notes.txt"), Buffer.from([0xff, 0x00, 0xfe]));
    const inspection = await inspectNativeSteering(context.root, { project: "acme" });
    expect(inspection.status).toBe("valid");
    expect(inspection.discovered_sources).toEqual([]);
    expect(allCodes(inspection)).toContain("steering-source-unsupported-extension");
  });

  test("editor temporaries and AGENTS input are ignored without parsing", async () => {
    const context = await project();
    await writeFile(join(context.steering, "architecture.md~"), Buffer.from([0xff, 0x00]));
    await writeFile(join(context.steering, ".architecture.md.swp"), Buffer.from([0xff, 0x00]));
    await writeFile(join(context.steering, "AGENTS.md"), Buffer.from([0xff, 0x00]));
    await putSource(context.steering, "architecture.md");
    const inspection = await inspectNativeSteering(context.root, { project: "acme" });
    expect(inspection.status).toBe("valid");
    expect(inspection.discovered_sources.map((entry) => entry.source_path)).toEqual([".aira/steering/architecture.md"]);
    expect(inspection.warnings).toEqual([]);
  });

  test("missing Steering root is a complete read-only observation", async () => {
    const context = await project();
    // Remove only the source surface by pointing inspection at another existing project root.
    const empty = await temporaryProject(); cleanup.push(empty.cleanup);
    await rm(join(empty.root, ".aira"), { recursive: true, force: true });
    const inspection = await inspectNativeSteering(empty.root, { project: "acme" });
    expect(inspection.root_status).toBe("missing");
    expect(inspection.complete).toBe(true);
    expect(inspection.status).toBe("valid");
    expect(allCodes(inspection)).toContain("steering-source-root-missing");
    expect(context.root).not.toBe(empty.root);
  });
});

describe("bounded discovery", () => {
  test("fails closed when the recognized file count exceeds policy", async () => {
    const context = await project();
    const bytes = sourceBytes();
    for (let index = 0; index <= nativeSteeringDiscoveryPolicy.max_files; index++)
      await writeFile(join(context.steering, `resource-${index.toString().padStart(3, "0")}.md`), bytes);
    const inspection = await inspectNativeSteering(context.root, { project: "acme" });
    expect(inspection.complete).toBe(false);
    expect(inspection.proposals).toEqual([]);
    expect(allCodes(inspection)).toContain("steering-source-file-count-limit");
  });

  test("rejects an individual source larger than policy before reading it", async () => {
    const context = await project();
    await writeFile(join(context.steering, "large.md"), new Uint8Array(nativeSteeringDiscoveryPolicy.max_file_bytes + 1).fill(0x61));
    const inspection = await inspectNativeSteering(context.root, { project: "acme" });
    expect(inspection.proposals).toEqual([]);
    expect(allCodes(inspection)).toContain("steering-source-file-size-limit");
  });

  test("fails closed before reads when aggregate bytes exceed policy", async () => {
    const context = await project();
    const count = Math.floor(nativeSteeringDiscoveryPolicy.max_aggregate_bytes /
      nativeSteeringDiscoveryPolicy.max_file_bytes) + 1;
    const bytes = new Uint8Array(nativeSteeringDiscoveryPolicy.max_file_bytes).fill(0x61);
    for (let index = 0; index < count; index++) await writeFile(join(context.steering, `aggregate-${index}.md`), bytes);
    const inspection = await inspectNativeSteering(context.root, { project: "acme" });
    expect(inspection.complete).toBe(false);
    expect(inspection.discovered_sources).toEqual([]);
    expect(allCodes(inspection)).toContain("steering-source-aggregate-size-limit");
  });

  test("rejects custom recursion beyond the versioned depth", async () => {
    const context = await project();
    const deep = ["custom", ...Array.from({ length: nativeSteeringDiscoveryPolicy.custom_max_depth + 1 }, (_, index) => `d${index}`)].join("/");
    await mkdir(join(context.steering, deep), { recursive: true });
    await writeFile(join(context.steering, deep, "api.md"), sourceBytes(sourceMetadata({
      id: "project.steering.api" as never,
      kind: "custom",
      custom_kind: "api" as never,
      title: "API",
      labels: [],
      rules: [],
    })));
    const inspection = await inspectNativeSteering(context.root, { project: "acme" });
    expect(inspection.status).toBe("invalid");
    expect(allCodes(inspection)).toContain("steering-source-custom-depth-limit");
  });
});
