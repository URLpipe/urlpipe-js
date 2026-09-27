// Optional smoke test against the real API. Skipped unless URLPIPE_API_KEY is set.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Urlpipe } from "../dist/esm/index.js";

const apiKey = process.env.URLPIPE_API_KEY;

test("live: markdown of https://example.com", { skip: apiKey ? false : "URLPIPE_API_KEY is not set" }, async () => {
  const client = new Urlpipe({ apiKey });
  const res = await client.markdown("https://example.com");
  assert.equal(res.status, "completed");
  assert.match(res.data, /Example Domain/);
  assert.ok(res.token);
});
