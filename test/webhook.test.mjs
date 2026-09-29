import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { WebhookVerificationError, verifyWebhook } from "../dist/esm/index.js";

const SECRET = "whsec_test_secret";
const OLD_SECRET = "whsec_old_secret";
const PAYLOAD = {
  token: "0Zx3",
  operation: "markdown",
  labels: { client: "acme" },
  success: true,
  result: "# Example Domain",
  result_url: null,
  final_url: "https://example.com/",
  error: null,
  meta: {
    cache: "miss",
    cache_age: null,
    processing_time_ms: 4182,
    quota: { cost: 1, limit: 1000, remaining: 943, overage: 0, resets_at: "2026-08-31T23:59:59Z", concurrency_limit: 3 },
  },
};
const BODY = JSON.stringify(PAYLOAD);

const now = () => String(Math.floor(Date.now() / 1000));
const sign = (secret, timestamp, body) => createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

function headersFor({ body = BODY, secret = SECRET, timestamp = now(), signature } = {}) {
  return {
    "X-URLpipe-Timestamp": timestamp,
    "X-URLpipe-Signature": signature ?? `v1=${sign(secret, timestamp, body)}`,
  };
}

async function rejectsWith(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WebhookVerificationError, `got ${error?.constructor?.name}`);
    assert.match(error.message, pattern);
    return true;
  });
}

describe("verifyWebhook", () => {
  test("returns the parsed payload for a valid delivery", async () => {
    const payload = await verifyWebhook(BODY, headersFor(), SECRET);
    assert.deepEqual(payload, PAYLOAD);
  });

  test("accepts the raw body as bytes and a Headers object", async () => {
    const headers = new Headers(headersFor());
    const payload = await verifyWebhook(new TextEncoder().encode(BODY), headers, SECRET);
    assert.equal(payload.token, "0Zx3");
  });

  test("reads plain-object headers case-insensitively", async () => {
    const h = headersFor();
    const lower = { "x-urlpipe-timestamp": h["X-URLpipe-Timestamp"], "x-urlpipe-signature": h["X-URLpipe-Signature"] };
    const payload = await verifyWebhook(BODY, lower, SECRET);
    assert.equal(payload.operation, "markdown");
  });

  test("rejects a tampered body", async () => {
    const headers = headersFor();
    await rejectsWith(verifyWebhook(BODY.replace("acme", "evil"), headers, SECRET), /No signature matches/);
  });

  test("rejects a re-serialised body (whitespace changes the bytes)", async () => {
    const headers = headersFor();
    await rejectsWith(verifyWebhook(JSON.stringify(PAYLOAD, null, 2), headers, SECRET), /No signature matches/);
  });

  test("rejects the wrong secret", async () => {
    await rejectsWith(verifyWebhook(BODY, headersFor(), "whsec_wrong"), /No signature matches/);
  });

  test("rejects a stale timestamp", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 301);
    await rejectsWith(verifyWebhook(BODY, headersFor({ timestamp }), SECRET), /tolerance/);
  });

  test("rejects a timestamp too far in the future", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) + 600);
    await rejectsWith(verifyWebhook(BODY, headersFor({ timestamp }), SECRET), /tolerance/);
  });

  test("a custom tolerance widens the window", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 1000);
    const payload = await verifyWebhook(BODY, headersFor({ timestamp }), SECRET, { tolerance: 3600 });
    assert.equal(payload.success, true);
  });

  test("accepts when only the second of two signatures matches (rotation)", async () => {
    const timestamp = now();
    const signature = `v1=${sign(OLD_SECRET, timestamp, BODY)},v1=${sign(SECRET, timestamp, BODY)}`;
    const payload = await verifyWebhook(BODY, headersFor({ timestamp, signature }), SECRET);
    assert.equal(payload.token, "0Zx3");
  });

  test("ignores unknown schemes", async () => {
    const timestamp = now();
    const signature = `v2=${"ab".repeat(32)}, v1=${sign(SECRET, timestamp, BODY)}`;
    const payload = await verifyWebhook(BODY, headersFor({ timestamp, signature }), SECRET);
    assert.equal(payload.token, "0Zx3");
  });

  test("an unknown scheme carrying the right digest is not accepted", async () => {
    const timestamp = now();
    const signature = `v2=${sign(SECRET, timestamp, BODY)}`;
    await rejectsWith(verifyWebhook(BODY, headersFor({ timestamp, signature }), SECRET), /no v1 signature/);
  });

  test("rejects missing headers", async () => {
    await rejectsWith(verifyWebhook(BODY, {}, SECRET), /Signature header is missing/);
    await rejectsWith(
      verifyWebhook(BODY, { "X-URLpipe-Signature": `v1=${sign(SECRET, now(), BODY)}` }, SECRET),
      /Timestamp header/,
    );
  });
});
