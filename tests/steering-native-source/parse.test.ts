import { describe, expect, test } from "bun:test";
import { stringify } from "yaml";
import { hashBytes } from "../../src/canonical-json";
import {
  parseNativeSteeringSource,
  STEERING_SOURCE_CONTENT_ENCODING,
  STEERING_SOURCE_SCHEMA,
} from "../../src/steering-source";
import { digest, encoder, sourceBytes, sourceMetadata, sourceRule } from "./fixtures";

const path = ".aira/steering/architecture.md";
const parse = (bytes: Uint8Array, sourcePath = path) => parseNativeSteeringSource({
  project: "acme",
  source_path: sourcePath,
  bytes,
});

function issueCodes(result: ReturnType<typeof parse>): string[] {
  return result.ok ? result.warnings.map((issue) => issue.code) : result.issues.map((issue) => issue.code);
}

describe("native Steering source parsing", () => {
  test("parses a standard resource into existing domain semantics", () => {
    const bytes = sourceBytes();
    const result = parse(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.source_schema).toBe(STEERING_SOURCE_SCHEMA);
    expect({ ...result.observation.identity, id: String(result.observation.identity.id) })
      .toEqual({ id: "steering.architecture", kind: "architecture" });
    expect(String(result.proposal.identity.id)).toBe("steering.architecture");
    expect(result.proposal.default_authority).toBe("normative");
    expect(String(result.proposal.rules[0]!.semantics.key)).toBe("topic.architecture.data-access");
    expect(result.proposal.content_encoding).toBe(STEERING_SOURCE_CONTENT_ENCODING);
    expect("revision" in result.proposal.identity).toBe(false);
    expect("created" in result.proposal).toBe(false);
  });

  test("parses a custom resource only from the bounded custom surface", () => {
    const metadata = sourceMetadata({
      id: "project.steering.api" as never,
      kind: "custom",
      custom_kind: "api-conventions" as never,
      title: "API conventions",
      rules: [],
    });
    const result = parse(sourceBytes(metadata), ".aira/steering/custom/guidance/api.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.kind).toBe("custom");
    expect(String(result.proposal.custom_kind)).toBe("api-conventions");
    expect(result.observation.source_path).toBe(".aira/steering/custom/guidance/api.md");
  });

  test("extracts exact body bytes without trimming or newline normalization", () => {
    const body = "\r\n# Architecture\r\n\r\n```text\r\n  exact  \r\n```\r\n";
    const bytes = sourceBytes(sourceMetadata(), body, "\r\n");
    const result = parse(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body_bytes).toEqual(encoder.encode(body));
    expect(result.observation.body.bytes).toBe(encoder.encode(body).length);
    expect(result.observation.body.hash).toBe(hashBytes(encoder.encode(body)));
    expect(result.proposal.rules[0]!.source?.content_hash).toBe(result.observation.body.hash);
  });

  test("hashes complete file bytes separately from exact body bytes", () => {
    const bytes = sourceBytes();
    const result = parse(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.source.hash).toBe(hashBytes(bytes));
    expect(result.observation.body.hash).toBe(hashBytes(result.body_bytes));
    expect(result.observation.source.hash).not.toBe(result.observation.body.hash);
    expect(result.source_bytes).toEqual(bytes);
  });

  test("logical identity is independent of filename", () => {
    const result = parse(sourceBytes(), ".aira/steering/system-shape.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.observation.identity.id)).toBe("steering.architecture");
    expect(result.observation.source_path).toBe(".aira/steering/system-shape.md");
  });

  test("conventional filename disagreement is a warning and never reinterprets identity", () => {
    const metadata = sourceMetadata({ id: "steering.product" as never, kind: "product", rules: [], title: "Product" });
    const result = parse(sourceBytes(metadata));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.proposal.identity.id)).toBe("steering.product");
    expect(result.warnings.map((issue) => issue.code)).toEqual(["steering-source-conventional-name-mismatch"]);
  });

  test("preserves template/import attribution while retaining project source provenance", () => {
    const metadata = sourceMetadata({
      provenance: {
        authorship: "adopted",
        adopted_from: {
          kind: "steering-revision",
          revision: { id: "template.steering.architecture", revision: "7", hash: digest(7) },
        },
      } as never,
    });
    const result = parse(sourceBytes(metadata, "edited project guidance\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.provenance.kind).toBe("native-project-source");
    expect(result.proposal.provenance.kind).toBe("project");
    expect(result.proposal.provenance).toEqual(expect.objectContaining({ authorship: "adopted" }));
    expect(result.proposal.content.hash).not.toBe(digest(7));
  });
});

describe("strict source metadata", () => {
  test("rejects unsupported source schema", () => {
    const result = parse(sourceBytes(sourceMetadata({ schema: "aira.dev/steering-source/v2" as never })));
    expect(issueCodes(result)).toContain("steering-source-schema-unsupported");
  });

  test("rejects unknown fields rather than stripping typos", () => {
    const metadata = { ...sourceMetadata(), autority: "normative" };
    const result = parse(sourceBytes(metadata));
    expect(issueCodes(result)).toContain("steering-source-unknown-field");
  });

  test("rejects invalid kind and authority", () => {
    expect(issueCodes(parse(sourceBytes(sourceMetadata({ kind: "platform" as never })))))
      .toContain("steering-source-kind-invalid");
    expect(issueCodes(parse(sourceBytes(sourceMetadata({ authority: "mandatory" as never })))))
      .toContain("steering-source-authority-invalid");
  });

  test("rejects malformed structured rules", () => {
    const invalid = sourceRule({ id: "architecture-rule", semantics: { key: "data-access", effect: "require", value: true } });
    const result = parse(sourceBytes(sourceMetadata({ rules: [invalid] as never })));
    expect(issueCodes(result)).toContain("steering-source-rule-invalid");
  });

  test("bounds structured rule count before domain conversion", () => {
    const rules = Array.from({ length: 257 }, (_, index) => sourceRule({
      id: `rule.architecture.rule-${index}`,
      semantics: { key: `topic.architecture.rule-${index}`, effect: "require", value: index },
    }));
    const result = parse(sourceBytes(sourceMetadata({ rules: rules as never })));
    expect(issueCodes(result)).toContain("steering-source-rule-count-limit");
  });

  test("does not turn enforceable prose into a machine rule", () => {
    const result = parse(sourceBytes(sourceMetadata({
      authority: "enforceable",
      override_policy: "sealed",
      enforcement: [],
      rules: [],
    }), "# Security\n\nThe AI MUST obey this prose.\n"));
    expect(issueCodes(result)).toContain("steering-source-authority-invalid");
  });

  test("accepts enforceable rules only with recognized exact bindings", () => {
    const binding = {
      kind: "verifier",
      verifier: { id: "V1", revision: "rev_verifier", hash: digest() },
      use: "required",
    };
    const rule = sourceRule({
      id: "rule.security.static-analysis",
      authority: "enforceable",
      semantics: { key: "topic.security.static-analysis", effect: "require", value: true },
      override_policy: "sealed",
      enforcement: [binding],
    });
    const metadata = sourceMetadata({
      id: "steering.security" as never,
      kind: "security",
      authority: "enforceable",
      override_policy: "sealed",
      enforcement: [{ ...binding, verifier: { ...binding.verifier } }] as never,
      rules: [rule] as never,
      title: "Security",
      labels: ["security"],
    });
    const result = parse(sourceBytes(metadata), ".aira/steering/security.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.rules[0]!.enforcement[0]!.kind).toBe("verifier");
  });

  test("rejects YAML duplicate keys, aliases, and custom tags", () => {
    const base = stringify({ aira: sourceMetadata() }, { lineWidth: 0 });
    const duplicate = encoder.encode(`---\n${base}aira:\n  schema: ${STEERING_SOURCE_SCHEMA}\n---\nbody`);
    expect(issueCodes(parse(duplicate))).toContain("steering-source-yaml-invalid");

    const alias = encoder.encode("---\naira: &meta\n  schema: aira.dev/steering-source/v1\ncopy: *meta\n---\nbody");
    expect(issueCodes(parse(alias))).toContain("steering-source-yaml-feature-forbidden");

    const tagged = encoder.encode("---\naira: !project {}\n---\nbody");
    expect(issueCodes(parse(tagged))).toContain("steering-source-yaml-feature-forbidden");
  });
});

describe("exact byte and encoding semantics", () => {
  test("trailing newline and whitespace changes change body and complete hashes", () => {
    const first = parse(sourceBytes(sourceMetadata(), "body"));
    const newline = parse(sourceBytes(sourceMetadata(), "body\n"));
    const whitespace = parse(sourceBytes(sourceMetadata(), "body "));
    expect(first.ok && newline.ok && whitespace.ok).toBe(true);
    if (!first.ok || !newline.ok || !whitespace.ok) return;
    expect(new Set([first.observation.body.hash, newline.observation.body.hash, whitespace.observation.body.hash]).size).toBe(3);
    expect(new Set([first.observation.source.hash, newline.observation.source.hash, whitespace.observation.source.hash]).size).toBe(3);
  });

  test("strict UTF-8 round trips without Unicode normalization", () => {
    const body = "# Café\n\nمرحبا 👋 e\u0301\n";
    const result = parse(sourceBytes(sourceMetadata(), body));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.body_bytes)).toBe(body);
    expect(result.body_bytes).toEqual(encoder.encode(body));
  });

  test("rejects invalid UTF-8 and a UTF-8 BOM", () => {
    const valid = sourceBytes();
    const invalid = Uint8Array.from([...valid, 0xc3, 0x28]);
    expect(issueCodes(parse(invalid))).toContain("steering-source-encoding-invalid");
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...valid]);
    expect(issueCodes(parse(bom))).toContain("steering-source-encoding-invalid");
  });

  test("CRLF delimiters and body remain exact", () => {
    const body = "# Architecture\r\nline 1\r\nline 2\r\n";
    const result = parse(sourceBytes(sourceMetadata(), body, "\r\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body_bytes).toEqual(encoder.encode(body));
    expect(result.observation.body.hash).toBe(hashBytes(encoder.encode(body)));
  });

  test("requires exact frontmatter framing and bounds line-range sources", () => {
    expect(issueCodes(parse(encoder.encode("# no frontmatter\n")))).toContain("steering-source-framing-invalid");
    const rule = sourceRule({ source: { location: { kind: "line-range", start: 2, end: 4 } } });
    const result = parse(sourceBytes(sourceMetadata({ rules: [rule] as never }), "one line"));
    expect(issueCodes(result)).toContain("steering-source-rule-location-invalid");
  });
});
