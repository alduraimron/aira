import { contentHashSchema, type ContentHash } from "./spec/domain/primitives";

/**
 * Aira canonical JSON v1.
 *
 * Object keys use UTF-16 code-unit order (the ECMAScript default sort order),
 * finite numbers use ECMAScript JSON rendering, strings remain exact, and the
 * byte encoding is UTF-8 without a BOM or insignificant whitespace. Lone
 * surrogates are escaped by JSON.stringify before UTF-8 encoding.
 *
 * This provider-neutral primitive is shared by pure identity construction and
 * storage adapters. It is deliberately distinct from the domain `canonical()`
 * comparison helper.
 */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

const reject = (message: string): never => { throw new CanonicalJsonError(message); };

export function canonicalJSON(value: unknown): string {
  const active = new Set<object>();
  function encode(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number") {
      if (!Number.isFinite(v) || Object.is(v, -0)) return reject("Unsupported JSON number (including negative zero)");
      return JSON.stringify(v);
    }
    if (typeof v !== "object") return reject("Unsupported JSON value");
    if (active.has(v)) return reject("Cyclic JSON value");
    const prototype = Object.getPrototypeOf(v);
    if (Array.isArray(v) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      return reject("JSON requires plain data objects/arrays");
    if (Object.getOwnPropertySymbols(v).length) return reject("Symbol keys are unsupported");
    active.add(v);
    const keys = Object.getOwnPropertyNames(v);
    for (const key of keys) {
      if (Array.isArray(v) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable)
        return reject("Accessors/non-enumerable JSON properties are unsupported");
    }
    let result: string;
    if (Array.isArray(v)) {
      if (keys.length !== v.length + 1 || Array.from({ length: v.length }, (_, i) => String(i)).some((key) => !Object.hasOwn(v, key)))
        return reject("Sparse or decorated arrays are unsupported");
      result = `[${v.map(encode).join(",")}]`;
    } else {
      result = `{${keys.sort().map((key) => `${JSON.stringify(key)}:${encode((v as Record<string, unknown>)[key])}`).join(",")}}`;
    }
    active.delete(v);
    return result;
  }
  return encode(value);
}

export const canonicalBytes = (value: unknown): Uint8Array => new TextEncoder().encode(canonicalJSON(value));

// FIPS 180-4 SHA-256 constants. Keeping hashing here avoids making the pure
// snapshot domain depend on a filesystem adapter or a runtime-specific crypto API.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotateRight = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** Synchronous provider-neutral SHA-256 over exact caller bytes. */
export function hashBytes(bytes: Uint8Array): ContentHash {
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.length] = 0x80;
  let bitLength = BigInt(bytes.length) * 8n;
  for (let index = 0; index < 8; index++) {
    message[paddedLength - 1 - index] = Number(bitLength & 0xffn);
    bitLength >>= 8n;
  }

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index++) {
      const start = offset + index * 4;
      words[index] = ((message[start]! << 24) | (message[start + 1]! << 16) |
        (message[start + 2]! << 8) | message[start + 3]!) >>> 0;
    }
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15]!, y = words[index - 2]!;
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let index = 0; index < 64; index++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + SHA256_K[index]! + words[index]!) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const hex = [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word.toString(16).padStart(8, "0")).join("");
  return contentHashSchema.parse(`sha256:${hex}`);
}

export const hashCanonical = (value: unknown): ContentHash => hashBytes(canonicalBytes(value));
