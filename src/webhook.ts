import { WebhookVerificationError } from "./errors.js";
import type { WebhookPayload } from "./types.js";
import { getCrypto } from "./util.js";

export interface VerifyWebhookOptions {
  /** Maximum age (or clock skew into the future) of the timestamp, in seconds. Default 300. */
  tolerance?: number;
}

const TIMESTAMP_HEADER = "x-urlpipe-timestamp";
const SIGNATURE_HEADER = "x-urlpipe-signature";

function readHeader(headers: Headers | Record<string, string | string[] | undefined>, name: string): string | null {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (Array.isArray(value)) return value.join(",");
    return value ?? null;
  }
  return null;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies a signed webhook delivery and returns its parsed payload.
 *
 * Pass the RAW request body, exactly the bytes received. Parsing the JSON and
 * serialising it again changes the bytes and the signature with them.
 *
 * It uses Web Crypto, which is asynchronous, so it returns a Promise.
 *
 * @throws {WebhookVerificationError} with the reason when the delivery is not genuine or is too old.
 */
export async function verifyWebhook(
  rawBody: string | Uint8Array,
  headers: Headers | Record<string, string | string[] | undefined>,
  secret: string,
  { tolerance = 300 }: VerifyWebhookOptions = {},
): Promise<WebhookPayload> {
  if (!secret) throw new WebhookVerificationError("No webhook signing secret was given.");

  const timestamp = readHeader(headers, TIMESTAMP_HEADER)?.trim() ?? "";
  const signatureHeader = readHeader(headers, SIGNATURE_HEADER) ?? "";
  if (!signatureHeader) throw new WebhookVerificationError("The X-URLpipe-Signature header is missing.");
  if (!/^\d+$/.test(timestamp)) throw new WebhookVerificationError("The X-URLpipe-Timestamp header is missing or not a Unix timestamp.");

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > tolerance) throw new WebhookVerificationError(`The timestamp is outside the ${tolerance}-second tolerance.`);

  const candidates = signatureHeader
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3).toLowerCase());
  if (candidates.length === 0) throw new WebhookVerificationError("The X-URLpipe-Signature header has no v1 signature.");

  const encoder = new TextEncoder();
  const bodyBytes = typeof rawBody === "string" ? encoder.encode(rawBody) : rawBody;
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + bodyBytes.length);
  signed.set(prefix, 0);
  signed.set(bodyBytes, prefix.length);

  const { subtle } = await getCrypto();
  const key = await subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = toHex(await subtle.sign("HMAC", key, signed));

  let matched = false;
  for (const candidate of candidates) {
    // No early exit: every candidate is compared.
    if (constantTimeEqual(candidate, expected)) matched = true;
  }
  if (!matched) throw new WebhookVerificationError("No signature matches this body and secret.");

  const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
  try {
    return JSON.parse(text) as WebhookPayload;
  } catch {
    throw new WebhookVerificationError("The signature is valid but the body is not JSON.");
  }
}
