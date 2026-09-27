import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AnalysisFailedError,
  AuthenticationError,
  InvalidRequestError,
  QuotaExceededError,
  ServerError,
  Urlpipe,
} from "../dist/esm/index.js";
import { startStub } from "./helpers/stub-server.mjs";

let stub;
let client;

before(async () => {
  stub = await startStub();
});
after(() => stub.close());
beforeEach(() => {
  stub.reset();
  client = fastRetries(new Urlpipe({ apiKey: "test_key", baseUrl: stub.url }));
});

// The internal backoff hook: 1 s steps become 5 ms steps.
function fastRetries(c, baseMs = 5) {
  c._retryBaseMs = baseMs;
  return c;
}

describe("retries", () => {
  test("503 then 200 succeeds, and the retry reuses the same Idempotency-Key", async () => {
    stub.reply(503, "Service Unavailable");
    stub.reply(200, "# Hello");
    const res = await client.markdown("https://example.com");
    assert.equal(res.data, "# Hello");
    assert.equal(stub.requests.length, 2);
    const [first, second] = stub.requests.map((r) => r.headers["idempotency-key"]);
    assert.ok(first);
    assert.equal(second, first);
    assert.equal(stub.requests[1].raw, stub.requests[0].raw);
  });

  test("a caller's Idempotency-Key is the one reused on retry", async () => {
    stub.reply(502, "");
    stub.reply(200, "ok");
    await client.markdown("https://example.com", { idempotencyKey: "caller-key" });
    assert.deepEqual(stub.requests.map((r) => r.headers["idempotency-key"]), ["caller-key", "caller-key"]);
  });

  test("each call gets its own generated key", async () => {
    stub.reply(200, "a");
    stub.reply(200, "b");
    await client.markdown("https://example.com");
    await client.markdown("https://example.com");
    const [a, b] = stub.requests.map((r) => r.headers["idempotency-key"]);
    assert.notEqual(a, b);
  });

  test("gives up after maxRetries and raises the last error", async () => {
    stub.always(500, { error: "internal" });
    const once = fastRetries(new Urlpipe({ apiKey: "k", baseUrl: stub.url, maxRetries: 1 }));
    await assert.rejects(once.markdown("https://example.com"), ServerError);
    assert.equal(stub.requests.length, 2);
  });

  test("the default backoff starts at 1 s", () => {
    assert.equal(new Urlpipe({ apiKey: "k" })._retryBaseMs, 1000);
  });

  test("backoff doubles per attempt (1, 2, 4 … steps)", async () => {
    const c = fastRetries(new Urlpipe({ apiKey: "k", baseUrl: stub.url, maxRetries: 3 }), 40);
    stub.reply(503, "");
    stub.reply(502, "");
    stub.reply(500, "");
    stub.reply(200, "ok");
    const started = Date.now();
    const res = await c.markdown("https://example.com");
    assert.equal(res.data, "ok");
    assert.equal(stub.requests.length, 4);
    // 40 + 80 + 160 ms of waiting at least.
    assert.ok(Date.now() - started >= 280, `waited ${Date.now() - started} ms`);
  });

  test("an unknown 429 is not retried", async () => {
    stub.always(429, { error: "something_new" });
    await assert.rejects(client.markdown("https://example.com"), (e) => e.constructor.name === "UrlpipeError");
    assert.equal(stub.requests.length, 1);
  });

  test("rate_limited with no Retry-After and no retry_after waits one base step", async () => {
    stub.reply(429, { error: "rate_limited" });
    stub.reply(200, "ok");
    const res = await client.markdown("https://example.com");
    assert.equal(res.data, "ok");
    assert.equal(stub.requests.length, 2);
  });

  test("rate_limited falls back to the body's retry_after", async () => {
    stub.reply(429, { error: "rate_limited", retry_after: 0 });
    stub.reply(200, "ok");
    const started = Date.now();
    const res = await fastRetries(client, 5_000).markdown("https://example.com");
    assert.equal(res.data, "ok");
    assert.ok(Date.now() - started < 1000, "retry_after: 0 should retry at once");
  });

  test("422 is not retried", async () => {
    stub.always(422, { error: "The request timed out." });
    await assert.rejects(client.markdown("https://example.com"), AnalysisFailedError);
    assert.equal(stub.requests.length, 1);
  });

  test("422 invalid_url is not retried", async () => {
    stub.always(422, { error: "invalid_url" });
    await assert.rejects(client.markdown("https://example.com"), InvalidRequestError);
    assert.equal(stub.requests.length, 1);
  });

  test("401 is not retried", async () => {
    stub.always(401, "");
    await assert.rejects(client.markdown("https://example.com"), AuthenticationError);
    assert.equal(stub.requests.length, 1);
  });

  test("quota_exceeded is not retried", async () => {
    stub.always(429, { error: "quota_exceeded", limit: 1000, used: 1000, needed: 1, resets_at: "2026-10-01T00:00:00Z" });
    await assert.rejects(client.markdown("https://example.com"), QuotaExceededError);
    assert.equal(stub.requests.length, 1);
  });

  test("504 without processing_timeout is not retried", async () => {
    stub.always(504, "Gateway Timeout");
    await assert.rejects(client.markdown("https://example.com"), ServerError);
    assert.equal(stub.requests.length, 1);
  });

  test("rate_limited honours Retry-After, then succeeds", async () => {
    stub.reply(429, { error: "rate_limited", message: "Slow down.", retry_after: 0 }, { "Retry-After": "0" });
    stub.reply(200, "ok");
    const started = Date.now();
    const res = await client.markdown("https://example.com");
    assert.equal(res.data, "ok");
    assert.equal(stub.requests.length, 2);
    assert.ok(Date.now() - started < 400, "Retry-After: 0 should retry at once");
    assert.equal(stub.requests[1].headers["idempotency-key"], stub.requests[0].headers["idempotency-key"]);
  });

  test("concurrency_limit is retried with backoff", async () => {
    stub.reply(429, { error: "concurrency_limit", limit: 1, running: 1 });
    stub.reply(200, "ok");
    const res = await client.markdown("https://example.com");
    assert.equal(res.data, "ok");
    assert.equal(stub.requests.length, 2);
  });

  test("a dropped connection is retried with the same key", async () => {
    stub.replyRaw({ destroy: true });
    stub.reply(200, "ok");
    const res = await client.markdown("https://example.com");
    assert.equal(res.data, "ok");
    assert.equal(stub.requests.length, 2);
    assert.equal(stub.requests[1].headers["idempotency-key"], stub.requests[0].headers["idempotency-key"]);
  });

  test("GET /result is retried on 503 too", async () => {
    stub.reply(503, "");
    stub.reply(200, "ok");
    const res = await client.result("tok_1");
    assert.equal(res.data, "ok");
    assert.equal(stub.requests.length, 2);
  });
});
