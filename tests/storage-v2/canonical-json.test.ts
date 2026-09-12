import { describe, expect, test } from "bun:test";
import { canonicalBytes, canonicalJSON, decodeCanonical, hashBytes, hashCanonical, encodeRecord } from "../../src/storage/file/canonical-json";
import { creation } from "./fixtures";
import { specSchema } from "../../src/spec/domain/schema";

describe("canonical storage bytes", () => {
  test("construction/key order and exact hashing", () => {
    const a = { z: 1, a: { y: true, b: "é" } }, b = { a: { b: "é", y: true }, z: 1 };
    expect(canonicalBytes(a)).toEqual(canonicalBytes(b)); expect(hashCanonical(a)).toBe(hashCanonical(b));
    expect(hashCanonical(a)).toBe(hashBytes(new TextEncoder().encode('{"a":{"b":"é","y":true},"z":1}')));
  });
  test("array order is significant", () => expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1])));
  test("feedback whitespace is significant", () => expect(hashCanonical({ feedback: " x\n" })).not.toBe(hashCanonical({ feedback: "x" })));
  test("Unicode remains exact, including combining characters and escaped lone surrogates", () => {
    for (const text of ["é", "e\u0301", "😊\u0000\r\n", "\ud800", "\u2028"]) expect(decodeCanonical(canonicalBytes(text), "STORE_INTEGRITY")).toBe(text);
    expect(hashCanonical("é")).not.toBe(hashCanonical("e\u0301"));
  });
  test.each([undefined, NaN, Infinity, -Infinity, -0, 1n, Symbol("x"), () => 1, new Date(), new Map(), new Set(), new Uint8Array(), /x/])("unsupported value %p", (value) => {
    expect(() => canonicalBytes({ value })).toThrow();
  });
  test("rejects sparse/decorated arrays, accessors, hidden and symbol keys, cycles", () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    for (const value of [new Array(3), Object.assign([1], { x: 2 }), { get a() { throw Error("must not invoke getter"); } },
      Object.defineProperty({}, "x", { value: 1 }), { [Symbol("x")]: 1 }, cycle]) expect(() => canonicalJSON(value)).toThrow();
  });
  test.each(['{ "a":1}', '{"a":1,"a":1}', '{"z":1,"a":2}', '1.0', '-0', '1e999', '\ufeff{}'])('reject noncanonical %p', (text) => {
    expect(() => decodeCanonical(new TextEncoder().encode(text), "STORE_CORRUPT_COMMIT")).toThrow();
  });
  test("invalid UTF-8 fails closed", () => expect(() => decodeCanonical(new Uint8Array([255]), "STORE_INTEGRITY")).toThrow());
  test("decode, strict validate, encode stable and detached", () => {
    const spec = creation().transaction.state.spec, encoded = encodeRecord(spec);
    const decoded = specSchema.parse(decodeCanonical(encoded.bytes, "STORE_INTEGRITY"));
    expect(canonicalBytes(decoded)).toEqual(encoded.bytes); expect(decoded).not.toBe(spec);
    expect(encoded.reference.hash).toBe(hashBytes(encoded.bytes));
  });
  test("canonical serialization is not schema validation", () => {
    const spec = { ...creation().transaction.state.spec, unexpected: 1 };
    expect(canonicalBytes(spec).length).toBeGreaterThan(0); expect(() => encodeRecord(spec)).toThrow();
  });
});
