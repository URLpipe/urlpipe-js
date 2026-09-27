const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) table[BASE64_ALPHABET.charCodeAt(i)] = i;
  // Accept the URL-safe alphabet too.
  table["-".charCodeAt(0)] = 62;
  table["_".charCodeAt(0)] = 63;
  return table;
})();

/** Decodes Base64 (standard or URL-safe, padded or not, whitespace ignored) without Buffer or atob. */
export function decodeBase64(input: string): Uint8Array {
  const out = new Uint8Array(Math.floor((input.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let length = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 61 /* = */) break;
    const value = c < 256 ? BASE64_LOOKUP[c]! : -1;
    if (value === -1) {
      if (c === 32 || c === 9 || c === 10 || c === 13) continue;
      throw new Error(`Invalid Base64 character at position ${i}.`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, length);
}

/** The image type from its magic bytes: PNG, JPEG or WebP, falling back to PNG. */
export function detectImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  ) {
    return "image/webp";
  }
  return "image/png";
}

type WebCrypto = {
  subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
  randomUUID?: () => string;
};

let cachedCrypto: WebCrypto | undefined;

/**
 * The Web Crypto API. It is a global everywhere this library runs except
 * Node 18, where it is loaded from node:crypto. The specifier is held in a
 * variable so bundlers for Workers and browsers leave it alone.
 */
export async function getCrypto(): Promise<WebCrypto> {
  if (cachedCrypto) return cachedCrypto;
  const global = (globalThis as { crypto?: WebCrypto }).crypto;
  if (global?.subtle) {
    cachedCrypto = global;
    return global;
  }
  const specifier = "node:crypto";
  const mod = (await import(specifier)) as { webcrypto?: WebCrypto };
  if (!mod.webcrypto?.subtle) throw new Error("No Web Crypto API is available in this runtime.");
  cachedCrypto = mod.webcrypto;
  return mod.webcrypto;
}

/** A random UUID v4. */
export async function uuidv4(): Promise<string> {
  const crypto = await getCrypto();
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
