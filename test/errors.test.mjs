import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  APIConnectionError,
  AnalysisFailedError,
  AuthenticationError,
  ConcurrencyLimitError,
  EmailUnverifiedError,
  InvalidRequestError,
  NotFoundError,
  QuotaExceededError,
  RateLimitedError,
  ServerError,
  StaleResultError,
  Urlpipe,
  UrlpipeError,
} from "../dist/esm/index.js";
import { startStub } from "./helpers/stub-server.mjs";

let stub;
let client;

const NEXT_PLAN = { name: "Starter", monthly_price_cents: 1900, monthly_credits: 20000, max_concurrent_requests: 3 };

before(async () => {
  stub = await startStub();
});
after(() => stub.close());
beforeEach(() => {
  stub.reset();
  // No retries: each test asserts on one response.
  client = new Urlpipe({ apiKey: "test_key", baseUrl: stub.url, maxRetries: 0 });
});

async function expectError(promise, ErrorClass, check = () => {}) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ErrorClass, `expected ${ErrorClass.name}, got ${error?.constructor?.name}: ${error?.message}`);
    assert.ok(error instanceof UrlpipeError);
    assert.equal(error.name, ErrorClass.name);
    check(error);
    return true;
  });
}

describe("error mapping", () => {
  test("401 → AuthenticationError, even with an empty body", async () => {
    stub.reply(401, "");
    await expectError(client.markdown("https://example.com"), AuthenticationError, (e) => {
      assert.equal(e.status, 401);
      assert.match(e.message, /API key/);
    });
  });

  test("401 with a JSON body keeps it", async () => {
    stub.reply(401, { error: "unauthorized", message: "Invalid API key." });
    await expectError(client.markdown("https://example.com"), AuthenticationError, (e) => {
      assert.equal(e.code, "unauthorized");
      assert.equal(e.message, "Invalid API key.");
      assert.deepEqual(e.body, { error: "unauthorized", message: "Invalid API key." });
    });
  });

  test("403 email_unverified → EmailUnverifiedError", async () => {
    stub.reply(403, { error: "email_unverified", message: "Confirm the email address on your account." });
    await expectError(client.markdown("https://example.com"), EmailUnverifiedError, (e) => {
      assert.equal(e.status, 403);
      assert.equal(e.code, "email_unverified");
      assert.equal(e.message, "Confirm the email address on your account.");
    });
  });

  test("a bare code never becomes the message: the kind's default sentence is used", async () => {
    stub.reply(403, { error: "email_unverified" });
    await expectError(client.markdown("https://example.com"), EmailUnverifiedError, (e) => {
      assert.equal(e.code, "email_unverified");
      assert.match(e.message, /^Confirm the email address on your URLpipe account/);
    });
    stub.reply(404, { error: "not_found" });
    await expectError(client.result("tok"), NotFoundError, (e) => {
      assert.equal(e.message, "No result for this token under this project.");
    });
    stub.reply(422, { error: "invalid_url" });
    await expectError(client.markdown("https://example.com"), InvalidRequestError, (e) => {
      assert.equal(e.message, "The request was invalid.");
    });
    stub.reply(403, "");
    await expectError(client.markdown("https://example.com"), UrlpipeError, (e) => {
      assert.ok(e.message.length > 0);
    });
  });

  test("403 other than email_unverified → base UrlpipeError", async () => {
    stub.reply(403, { error: "forbidden", message: "Nope." });
    await expectError(client.markdown("https://example.com"), UrlpipeError, (e) => {
      assert.equal(e.constructor, UrlpipeError);
      assert.equal(e.status, 403);
      assert.equal(e.code, "forbidden");
    });
  });

  test("429 with an unknown or missing error → base UrlpipeError", async () => {
    stub.reply(429, { error: "something_new" });
    await expectError(client.markdown("https://example.com"), UrlpipeError, (e) => {
      assert.equal(e.constructor, UrlpipeError);
      assert.equal(e.code, "something_new");
    });
    stub.reply(429, "Too Many Requests");
    await expectError(client.markdown("https://example.com"), UrlpipeError, (e) => {
      assert.equal(e.constructor, UrlpipeError);
      assert.equal(e.status, 429);
    });
  });

  test("404 and 410 map by status whatever the body", async () => {
    stub.reply(404, "Not Found", { "Content-Type": "text/html" });
    await expectError(client.result("tok"), NotFoundError);
    stub.reply(410, { error: "gone_somewhere" });
    await expectError(client.result("tok"), StaleResultError);
  });

  test("the error token falls back to the X-Result-Token header", async () => {
    stub.reply(422, { error: "The request timed out." }, { "X-Result-Token": "tok_header" });
    await expectError(client.markdown("https://example.com"), AnalysisFailedError, (e) => {
      assert.equal(e.token, "tok_header");
    });
  });

  for (const code of [
    "invalid_url",
    "invalid_max_age",
    "invalid_options",
    "invalid_labels",
    "invalid_idempotency_key",
    "idempotency_key_reused",
  ]) {
    test(`422 ${code} → InvalidRequestError`, async () => {
      stub.reply(422, { error: code, message: `About ${code}.` });
      await expectError(client.markdown("https://example.com"), InvalidRequestError, (e) => {
        assert.equal(e.status, 422);
        assert.equal(e.code, code);
        assert.equal(e.message, `About ${code}.`);
      });
    });
  }

  test("422 starting with report_to → InvalidRequestError", async () => {
    const sentence = "report_to must be a public http or https URL on the default port.";
    stub.reply(422, { error: sentence });
    await expectError(client.markdown("https://example.com", { reportTo: "https://127.0.0.1/x" }), InvalidRequestError, (e) => {
      assert.equal(e.message, sentence);
    });
  });

  test("422 with a sentence → AnalysisFailedError carrying the sentence", async () => {
    stub.reply(422, { error: "The request timed out." }, { "X-Result-Token": "tok_fail" });
    await expectError(client.markdown("https://example.com"), AnalysisFailedError, (e) => {
      assert.equal(e.status, 422);
      assert.equal(e.message, "The request timed out.");
      assert.equal(e.code, null);
    });
  });

  test("422 /scrape where every operation failed keeps the scrape object on body", async () => {
    const body = {
      url: "https://example.com",
      operations: {
        markdown: { success: false, result: null, error: "The requested page was not found.", cached: false },
        meta: { success: false, result: null, error: "The request timed out.", cached: false },
      },
    };
    stub.reply(422, body);
    await expectError(client.scrape("https://example.com", ["markdown", "meta"]), AnalysisFailedError, (e) => {
      assert.deepEqual(e.body, body);
      assert.equal(e.message, "Every operation failed: markdown: The requested page was not found.; meta: The request timed out.");
      assert.equal(e.code, null);
    });
  });

  test("429 quota_exceeded → QuotaExceededError with its fields", async () => {
    stub.reply(429, {
      error: "quota_exceeded",
      message: "Your Free plan includes 1000 credits per month.",
      limit: 1000,
      used: 990,
      needed: 17,
      resets_at: "2026-10-01T00:00:00Z",
      next_plan: NEXT_PLAN,
      upgrade_url: "https://urlpipe.dev/app/billing/plans",
    });
    await expectError(client.summarize("https://example.com"), QuotaExceededError, (e) => {
      assert.equal(e.status, 429);
      assert.equal(e.code, "quota_exceeded");
      assert.equal(e.limit, 1000);
      assert.equal(e.used, 990);
      assert.equal(e.needed, 17);
      assert.equal(e.resetsAt, "2026-10-01T00:00:00Z");
      assert.deepEqual(e.nextPlan, NEXT_PLAN);
      assert.equal(e.upgradeUrl, "https://urlpipe.dev/app/billing/plans");
    });
  });

  test("429 quota_exceeded without next_plan or upgrade_url → both null", async () => {
    stub.reply(429, { error: "quota_exceeded", limit: 1000, used: 1000, needed: 1, resets_at: "2026-10-01T00:00:00Z" });
    await expectError(client.markdown("https://example.com"), QuotaExceededError, (e) => {
      assert.equal(e.nextPlan, null);
      assert.equal(e.upgradeUrl, null);
    });
  });

  test("429 concurrency_limit → ConcurrencyLimitError with limit, running, nextPlan and upgradeUrl", async () => {
    stub.reply(429, {
      error: "concurrency_limit",
      message: "3 are already running.",
      limit: 3,
      running: 3,
      next_plan: NEXT_PLAN,
      upgrade_url: "https://urlpipe.dev/app/billing/plans",
    });
    await expectError(client.markdown("https://example.com"), ConcurrencyLimitError, (e) => {
      assert.equal(e.limit, 3);
      assert.equal(e.running, 3);
      assert.deepEqual(e.nextPlan, NEXT_PLAN);
      assert.equal(e.upgradeUrl, "https://urlpipe.dev/app/billing/plans");
    });
  });

  test("429 concurrency_limit without next_plan or upgrade_url → both null", async () => {
    stub.reply(429, { error: "concurrency_limit", limit: 3, running: 3 });
    await expectError(client.markdown("https://example.com"), ConcurrencyLimitError, (e) => {
      assert.equal(e.nextPlan, null);
      assert.equal(e.upgradeUrl, null);
    });
  });

  test("429 rate_limited → RateLimitedError with retryAfter from Retry-After", async () => {
    stub.reply(429, { error: "rate_limited", message: "Slow down.", retry_after: 99 }, { "Retry-After": "12" });
    await expectError(client.markdown("https://example.com"), RateLimitedError, (e) => {
      assert.equal(e.retryAfter, 12);
      assert.equal(e.message, "Slow down.");
    });
  });

  test("429 rate_limited without Retry-After falls back to the body's retry_after", async () => {
    stub.reply(429, { error: "rate_limited", retry_after: 7 });
    await expectError(client.markdown("https://example.com"), RateLimitedError, (e) => {
      assert.equal(e.retryAfter, 7);
    });
  });

  test("404 not_found → NotFoundError", async () => {
    stub.reply(404, { error: "not_found" });
    await expectError(client.result("tok_missing"), NotFoundError, (e) => {
      assert.equal(e.status, 404);
      assert.equal(e.code, "not_found");
    });
  });

  test("410 stale → StaleResultError", async () => {
    stub.reply(410, { error: "stale", message: "This result is older than the 30-day retention window. Run a new analysis." });
    await expectError(client.result("tok_old"), StaleResultError, (e) => {
      assert.equal(e.status, 410);
      assert.equal(e.code, "stale");
      assert.match(e.message, /30-day/);
    });
  });

  for (const status of [500, 502, 503, 504]) {
    test(`${status} → ServerError`, async () => {
      stub.reply(status, "<html>Bad gateway</html>", { "Content-Type": "text/html" });
      await expectError(client.markdown("https://example.com"), ServerError, (e) => {
        assert.equal(e.status, status);
        assert.equal(e.body, "<html>Bad gateway</html>");
      });
    });
  }

  test("a body that is not JSON never masks the error", async () => {
    stub.reply(422, "{broken json", { "Content-Type": "application/json" });
    await expectError(client.markdown("https://example.com"), AnalysisFailedError, (e) => {
      assert.equal(e.status, 422);
      assert.equal(e.body, "{broken json");
    });
  });

  test("the error carries the body's token, ahead of the header", async () => {
    stub.reply(422, { error: "The page could not be loaded.", token: "tok_err" }, { "X-Result-Token": "tok_header" });
    await expectError(client.markdown("https://example.com"), AnalysisFailedError, (e) => {
      assert.equal(e.token, "tok_err");
    });
  });

  test("an unreachable server → APIConnectionError", async () => {
    const closed = await startStub();
    const url = closed.url;
    await closed.close();
    const offline = new Urlpipe({ apiKey: "k", baseUrl: url, maxRetries: 0 });
    await expectError(offline.markdown("https://example.com"), APIConnectionError, (e) => {
      assert.equal(e.status, null);
      assert.ok(e.cause);
    });
  });

  test("a request past the timeout → APIConnectionError", async () => {
    stub.replyRaw({ status: 200, body: "late", headers: { "Content-Type": "text/plain" }, delay: 500 });
    const impatient = new Urlpipe({ apiKey: "k", baseUrl: stub.url, maxRetries: 0, timeout: 50 });
    await expectError(impatient.markdown("https://example.com"), APIConnectionError, (e) => {
      assert.match(e.message, /timed out after 50 ms/);
    });
  });
});
