import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { AnalysisFailedError, ServerError, Urlpipe, WaitTimeoutError } from "../dist/esm/index.js";
import { QUOTA_HEADERS, startStub } from "./helpers/stub-server.mjs";

const TIMEOUT_BODY = {
  error: "processing_timeout",
  message: "The analysis is taking longer than expected.",
  token: "tok_slow",
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let stub;
let client;

before(async () => {
  stub = await startStub();
});
after(() => stub.close());
beforeEach(() => {
  stub.reset();
  client = new Urlpipe({ apiKey: "test_key", baseUrl: stub.url });
});

describe("504 processing_timeout", () => {
  test("polls GET /result/:token and returns the completed result as one call", async () => {
    stub.reply(504, TIMEOUT_BODY);
    stub.reply(200, { title: "Example" }, { ...QUOTA_HEADERS, "X-Result-Token": "tok_slow", "X-Labels": '{"client":"acme"}' });
    const res = await client.meta("https://example.com", { labels: { client: "acme" } });
    assert.equal(stub.requests.length, 2);
    assert.equal(stub.requests[1].method, "GET");
    assert.equal(stub.requests[1].path, "/result/tok_slow");
    assert.equal(stub.requests[1].headers.authorization, "Bearer test_key");
    assert.equal(res.status, "completed");
    assert.deepEqual(res.data, { title: "Example" });
    assert.equal(res.token, "tok_slow");
    assert.deepEqual(res.labels, { client: "acme" });
  });

  test("the polled result is typed by the original operation (screenshot is decoded)", async () => {
    stub.reply(504, TIMEOUT_BODY);
    stub.reply(200, PNG.toString("base64"), { "X-Result-Url": "https://urlpipe.dev/r/x.png" });
    const res = await client.screenshot("https://example.com");
    assert.deepEqual(Array.from(res.data.bytes), Array.from(PNG));
    assert.equal(res.data.mimeType, "image/png");
    assert.equal(res.data.resultUrl, "https://urlpipe.dev/r/x.png");
  });

  test("throws WaitTimeoutError with the token once waitTimeout passes", async () => {
    const quick = new Urlpipe({ apiKey: "k", baseUrl: stub.url, waitTimeout: 50 });
    stub.reply(504, TIMEOUT_BODY);
    stub.always(202, { status: "processing", token: "tok_slow", labels: {} });
    await assert.rejects(quick.markdown("https://example.com"), (error) => {
      assert.ok(error instanceof WaitTimeoutError);
      assert.equal(error.token, "tok_slow");
      return true;
    });
    assert.ok(stub.requests.length >= 2);
  });

  test("a failure while polling is raised as that failure", async () => {
    stub.reply(504, TIMEOUT_BODY);
    stub.reply(422, { error: "The page could not be loaded." });
    await assert.rejects(client.markdown("https://example.com"), AnalysisFailedError);
  });
});

describe("result()", () => {
  test("200 → completed; JSON parsed without a hint", async () => {
    stub.reply(200, ["a", "b"], { "X-Result-Token": "tok_1" });
    const res = await client.result("tok_1");
    assert.equal(stub.requests[0].path, "/result/tok_1");
    assert.equal(res.status, "completed");
    assert.deepEqual(res.data, ["a", "b"]);
    assert.equal(res.token, "tok_1");
  });

  test("text stays text without a hint, so a screenshot stays Base64", async () => {
    stub.reply(200, PNG.toString("base64"));
    const res = await client.result("tok_1");
    assert.equal(res.data, PNG.toString("base64"));
  });

  test("with operation: 'screenshot' the image is decoded", async () => {
    stub.reply(200, PNG.toString("base64"));
    const res = await client.result("tok_1", { operation: "screenshot" });
    assert.deepEqual(Array.from(res.data.bytes), Array.from(PNG));
  });

  test("with operation: 'markdown' a JSON-looking body stays a string", async () => {
    stub.reply(200, '["x"]', { "Content-Type": "application/json" });
    const res = await client.result("tok_1", { operation: "markdown" });
    assert.equal(res.data, '["x"]');
  });

  test("202 → processing response, not an error", async () => {
    stub.reply(202, { status: "processing", token: "tok_1", labels: { client: "acme" } });
    const res = await client.result("tok_1");
    assert.equal(res.status, "processing");
    assert.equal(res.data, null);
    assert.equal(res.token, "tok_1");
    assert.deepEqual(res.labels, { client: "acme" });
  });

  test("504 processing_timeout → processing response, not an error", async () => {
    stub.reply(504, { error: "processing_timeout", token: "tok_1" }, { "X-Labels": '{"client":"acme"}' });
    const res = await client.result("tok_1");
    assert.equal(res.status, "processing");
    assert.equal(res.data, null);
    assert.equal(res.token, "tok_1");
    assert.deepEqual(res.labels, { client: "acme" });
    assert.equal(stub.requests.length, 1);
  });

  test("any other 504 → ServerError, not retried", async () => {
    stub.always(504, "Gateway Timeout");
    await assert.rejects(client.result("tok_1"), ServerError);
    assert.equal(stub.requests.length, 1);
  });

  test("the token is URL-encoded in the path", async () => {
    stub.reply(200, "ok");
    await client.result("a/b c");
    assert.equal(stub.requests[0].path, "/result/a%2Fb%20c");
  });

  test("GET /result carries no Idempotency-Key", async () => {
    stub.reply(200, "ok");
    await client.result("tok_1");
    assert.equal(stub.requests[0].headers["idempotency-key"], undefined);
  });
});

describe("wait()", () => {
  test("polls until the result is ready", async () => {
    stub.reply(202, { status: "processing", token: "tok_w" });
    stub.reply(504, { error: "processing_timeout", token: "tok_w" });
    stub.reply(200, "# Done", { "X-Result-Token": "tok_w" });
    const res = await client.wait("tok_w", { operation: "markdown", interval: 5 });
    assert.equal(stub.requests.length, 3);
    assert.equal(res.status, "completed");
    assert.equal(res.data, "# Done");
  });

  test("throws WaitTimeoutError with the token after the timeout", async () => {
    stub.always(202, { status: "processing", token: "tok_w" });
    await assert.rejects(client.wait("tok_w", { timeout: 30, interval: 10 }), (error) => {
      assert.ok(error instanceof WaitTimeoutError);
      assert.equal(error.token, "tok_w");
      return true;
    });
  });
});
