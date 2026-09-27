// The CommonJS build loads with require() and exposes the same API.
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("require('urlpipe') exposes the client, its default and the errors", () => {
  const urlpipe = require("../dist/cjs/index.js");
  assert.equal(typeof urlpipe.Urlpipe, "function");
  assert.equal(urlpipe.default, urlpipe.Urlpipe);
  assert.equal(typeof urlpipe.verifyWebhook, "function");
  const error = new urlpipe.RateLimitedError("slow", { status: 429, retryAfter: 3 });
  assert.ok(error instanceof urlpipe.UrlpipeError);
  assert.equal(error.retryAfter, 3);
  assert.equal(error.name, "RateLimitedError");
  const client = new urlpipe.Urlpipe({ apiKey: "k" });
  assert.equal(client.baseUrl, "https://urlpipe.dev");
  assert.equal(client.timeout, 90000);
  assert.equal(client.maxRetries, 2);
  assert.equal(client.waitTimeout, 300000);
});
