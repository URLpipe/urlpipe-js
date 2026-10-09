import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import Urlpipe, { ConfigurationError, Urlpipe as NamedUrlpipe, VERSION } from "../dist/esm/index.js";
import { QUOTA_HEADERS, startStub } from "./helpers/stub-server.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// A 1x1 PNG, and the first bytes of a JPEG and a WebP.
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP_BYTES = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x5a, 0xb8, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38]);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

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

function lastRequest() {
  return stub.requests.at(-1);
}

function assertCommonRequest(req, path) {
  assert.equal(req.method, "POST");
  assert.equal(req.path, path);
  assert.equal(req.headers.authorization, "Bearer test_key");
  assert.equal(req.headers["user-agent"], `urlpipe-js/${pkg.version}`);
  assert.match(req.headers["content-type"], /^application\/json/);
  assert.equal(req.body.url, "https://example.com");
  assert.equal(req.body.sync, true);
}

describe("construction", () => {
  test("default and named exports are the same client", () => {
    assert.equal(Urlpipe, NamedUrlpipe);
    assert.equal(VERSION, pkg.version);
  });

  test("reads the API key from URLPIPE_API_KEY", async () => {
    process.env.URLPIPE_API_KEY = "env_key";
    try {
      const envClient = new Urlpipe({ baseUrl: stub.url });
      stub.reply(200, "# Hi", QUOTA_HEADERS);
      await envClient.markdown("https://example.com");
      assert.equal(lastRequest().headers.authorization, "Bearer env_key");
    } finally {
      delete process.env.URLPIPE_API_KEY;
    }
  });

  test("throws a ConfigurationError without an API key", () => {
    delete process.env.URLPIPE_API_KEY;
    assert.throws(() => new Urlpipe(), (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /URLPIPE_API_KEY/);
      return true;
    });
  });

  test("uses an injected fetch", async () => {
    const calls = [];
    const injected = new Urlpipe({
      apiKey: "k",
      baseUrl: "https://api.invalid",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response("# Injected", { status: 200, headers: { "Content-Type": "text/plain" } });
      },
    });
    const res = await injected.markdown("https://example.com");
    assert.equal(res.data, "# Injected");
    assert.equal(calls[0].url, "https://api.invalid/markdown");
  });

  test("strips a trailing slash from baseUrl", async () => {
    const slashed = new Urlpipe({ apiKey: "k", baseUrl: stub.url + "/" });
    stub.reply(200, "ok");
    await slashed.html("https://example.com");
    assert.equal(lastRequest().path, "/html");
  });
});

describe("text operations", () => {
  for (const op of ["markdown", "html", "summarize"]) {
    test(`${op} posts to /${op} and returns the text`, async () => {
      stub.reply(200, `# ${op} body`, QUOTA_HEADERS);
      const res = await client[op]("https://example.com");
      assertCommonRequest(lastRequest(), `/${op}`);
      assert.equal(res.status, "completed");
      assert.equal(res.data, `# ${op} body`);
      assert.equal(res.token, "tok_123");
    });
  }

  test("a text body that looks like JSON stays a string", async () => {
    stub.reply(200, '{"not":"parsed"}', { "Content-Type": "application/json" });
    const res = await client.markdown("https://example.com");
    assert.equal(res.data, '{"not":"parsed"}');
  });
});

describe("JSON operations", () => {
  test("meta returns the metadata object", async () => {
    const meta = {
      final_url: "https://example.com/",
      canonical_url: "https://example.com/",
      title: "Example Domain",
      description: "An example",
      site_name: null,
      type: "website",
      language: "en",
      locale: "en",
      authors: [],
      published_at: null,
      modified_at: null,
      image: { url: "https://example.com/cover.jpg", width: 1200, height: 630, alt: null, type: null },
      video: null,
      favicon_url: "https://example.com/favicon.ico",
      icons: [{ url: "https://example.com/favicon.ico", rel: "icon", sizes: null, type: null }],
      logo_url: null,
      feeds: [],
      keywords: [],
      theme_color: null,
      generator: null,
      manifest_url: null,
      robots: { index: true, follow: true },
      open_graph: { title: "Example Domain", description: null, image: null, url: null, type: null, site_name: null, locale: null },
      twitter: { card: null, site: null, creator: null, title: null, description: null, image: null },
      alternates: [],
      oembed_url: null,
      structured_data_types: [],
    };
    stub.reply(200, meta, QUOTA_HEADERS);
    const res = await client.meta("https://example.com");
    assertCommonRequest(lastRequest(), "/meta");
    assert.deepEqual(res.data, meta);
  });

  test("keywords returns a list of strings", async () => {
    stub.reply(200, ["domain", "example"], QUOTA_HEADERS);
    const res = await client.keywords("https://example.com");
    assertCommonRequest(lastRequest(), "/keywords");
    assert.deepEqual(res.data, ["domain", "example"]);
  });

  test("console returns the entries", async () => {
    const entries = [
      { type: "error", text: "Failed to fetch" },
      { type: "warning", text: "Deprecated API" },
      { type: "exception", text: "TypeError: x is undefined" },
    ];
    stub.reply(200, entries, QUOTA_HEADERS);
    const res = await client.console("https://example.com");
    assertCommonRequest(lastRequest(), "/console");
    assert.deepEqual(res.data, entries);
  });

  test("technologies returns what the page is built with", async () => {
    const result = {
      final_url: "https://example.com/",
      technologies: [
        { name: "WordPress", slug: "wordpress", version: "6.4.2", confidence: 100, categories: [{ slug: "cms", name: "CMS" }],
          website: "https://wordpress.org", description: null, cpe: null, detected_by: ["meta"], implied_by: [] },
      ],
    };
    stub.reply(200, result, QUOTA_HEADERS);
    const res = await client.technologies("https://example.com");
    assertCommonRequest(lastRequest(), "/technologies");
    assert.deepEqual(res.data, result);
  });

  test("lighthouse sends device and include_audits, and no page_options", async () => {
    const report = { url: "https://example.com", fetchTime: "2026-01-01T00:00:00.000Z", device: "desktop", categories: {}, metrics: {} };
    stub.reply(200, report, QUOTA_HEADERS);
    const res = await client.lighthouse("https://example.com", { device: "desktop", includeAudits: true });
    const req = lastRequest();
    assertCommonRequest(req, "/lighthouse");
    assert.equal(req.body.device, "desktop");
    assert.equal(req.body.include_audits, true);
    assert.deepEqual(res.data, report);
  });

  test("scrape sends the operations and the options, and returns the scrape object", async () => {
    const result = {
      url: "https://example.com",
      final_url: "https://example.com/",
      operations: {
        markdown: { success: true, result: "# Example", cached: false },
        meta: { success: true, result: { title: "Example" }, cached: true },
      },
    };
    stub.reply(200, result, { ...QUOTA_HEADERS, "X-Cache": "partial", "X-Cache-Age": "60" });
    const res = await client.scrape("https://example.com", ["markdown", "meta", "screenshot", "lighthouse"], {
      device: "mobile",
      includeAudits: false,
      screenshotOptions: { format: "webp" },
      pageOptions: { block_ads: true },
    });
    const req = lastRequest();
    assertCommonRequest(req, "/scrape");
    assert.deepEqual(req.body.operations, ["markdown", "meta", "screenshot", "lighthouse"]);
    assert.equal(req.body.device, "mobile");
    assert.equal(req.body.include_audits, false);
    assert.deepEqual(req.body.screenshot_options, { format: "webp" });
    assert.deepEqual(req.body.page_options, { block_ads: true });
    assert.deepEqual(res.data, result);
    assert.equal(res.meta.cache, "partial");
    assert.equal(res.meta.cacheAge, 60);
  });
});

describe("options", () => {
  test("common options become snake_case body keys; maps pass through unchanged", async () => {
    stub.reply(200, "ok");
    await client.markdown("https://example.com", {
      maxAge: "3 days",
      labels: { client: "acme" },
      residential: true,
      reportTo: "https://hooks.example.com/urlpipe",
      pageOptions: { wait_for_selector: "#main", delay: 500, remove_selectors: [".ad"] },
    });
    assert.deepEqual(lastRequest().body, {
      url: "https://example.com",
      page_options: { wait_for_selector: "#main", delay: 500, remove_selectors: [".ad"] },
      max_age: "3 days",
      labels: { client: "acme" },
      residential: true,
      report_to: "https://hooks.example.com/urlpipe",
      sync: true,
    });
  });

  test("only the options given are sent", async () => {
    stub.reply(200, "ok");
    await client.markdown("https://example.com", { maxAge: 0 });
    assert.deepEqual(lastRequest().body, { url: "https://example.com", max_age: 0, sync: true });
  });

  test("extra params are merged into the body", async () => {
    stub.reply(200, "ok");
    await client.html("https://example.com", { extra: { future_option: "yes", nested: { a: 1 } } });
    const body = lastRequest().body;
    assert.equal(body.future_option, "yes");
    assert.deepEqual(body.nested, { a: 1 });
    assert.equal(body.url, "https://example.com");
  });

  test("extra is merged last and may override sync; the final body decides the mode", async () => {
    stub.reply(200, { token: "tok_x", status: "accepted", labels: {} });
    const res = await client.markdown("https://example.com", { maxAge: 5, extra: { sync: false, max_age: 10 } });
    assert.equal(lastRequest().body.sync, false);
    assert.equal(lastRequest().body.max_age, 10);
    assert.equal(res.status, "accepted");
    assert.equal(res.token, "tok_x");
  });

  test("idempotencyKey is sent as the Idempotency-Key header, not in the body", async () => {
    stub.reply(200, "ok");
    await client.markdown("https://example.com", { idempotencyKey: "my-key-1" });
    const req = lastRequest();
    assert.equal(req.headers["idempotency-key"], "my-key-1");
    assert.equal("idempotency_key" in req.body, false);
    assert.equal("idempotencyKey" in req.body, false);
  });

  test("a UUID v4 Idempotency-Key is generated when retries are on", async () => {
    stub.reply(200, "ok");
    await client.markdown("https://example.com");
    assert.match(lastRequest().headers["idempotency-key"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("with retries off, no Idempotency-Key is generated", async () => {
    const noRetry = new Urlpipe({ apiKey: "k", baseUrl: stub.url, maxRetries: 0 });
    stub.reply(200, "ok");
    await noRetry.markdown("https://example.com");
    assert.equal(lastRequest().headers["idempotency-key"], undefined);
  });
});

describe("response meta", () => {
  test("parses every header", async () => {
    stub.reply(200, "ok", {
      ...QUOTA_HEADERS,
      "X-Cache": "hit",
      "X-Cache-Age": "5400",
      "X-Processing-Time-Ms": "12",
      "X-Labels": '{"client":"acme","caf\\u00e9":"ol\\u00e9"}',
      "X-Final-Url": "https://www.example.com/en/",
      "Idempotent-Replayed": "true",
    });
    const res = await client.markdown("https://example.com");
    assert.deepEqual(res.meta, {
      cache: "hit",
      cacheAge: 5400,
      processingTimeMs: 12,
      quota: { cost: 1, limit: 1000, remaining: 943, overage: 0, resetsAt: "2026-08-31T23:59:59Z" },
      concurrencyLimit: 3,
      resultUrl: null,
      finalUrl: "https://www.example.com/en/",
      idempotentReplayed: true,
    });
    assert.deepEqual(res.labels, { client: "acme", café: "olé" });
  });

  test("keeps 'unlimited' as given", async () => {
    stub.reply(200, "ok", {
      ...QUOTA_HEADERS,
      "X-Quota-Limit": "unlimited",
      "X-Quota-Remaining": "unlimited",
      "X-Concurrency-Limit": "unlimited",
    });
    const res = await client.markdown("https://example.com");
    assert.equal(res.meta.quota.limit, "unlimited");
    assert.equal(res.meta.quota.remaining, "unlimited");
    assert.equal(res.meta.concurrencyLimit, "unlimited");
  });

  test("missing headers are null, never an exception", async () => {
    stub.reply(200, "ok", {});
    const res = await client.markdown("https://example.com");
    assert.deepEqual(res.meta, {
      cache: null,
      cacheAge: null,
      processingTimeMs: null,
      quota: { cost: null, limit: null, remaining: null, overage: null, resetsAt: null },
      concurrencyLimit: null,
      resultUrl: null,
      finalUrl: null,
      idempotentReplayed: false,
    });
    assert.equal(res.token, null);
    assert.deepEqual(res.labels, {});
  });

  test("a malformed X-Labels header gives empty labels", async () => {
    stub.reply(200, "ok", { "X-Labels": "{not json" });
    const res = await client.markdown("https://example.com");
    assert.deepEqual(res.labels, {});
  });
});

describe("screenshot", () => {
  const cases = [
    ["PNG", PNG_BYTES, "image/png"],
    ["JPEG", JPEG_BYTES, "image/jpeg"],
    ["WebP", WEBP_BYTES, "image/webp"],
    ["unknown bytes", Uint8Array.from([1, 2, 3, 4]), "image/png"],
  ];
  for (const [name, bytes, mime] of cases) {
    test(`decodes Base64 and detects ${name}`, async () => {
      stub.reply(200, b64(bytes) + "\n", { ...QUOTA_HEADERS, "X-Result-Url": "https://urlpipe.dev/r/abc.png" });
      const res = await client.screenshot("https://example.com", { screenshotOptions: { format: "webp", viewport_width: 390 } });
      const req = lastRequest();
      assertCommonRequest(req, "/screenshot");
      assert.deepEqual(req.body.screenshot_options, { format: "webp", viewport_width: 390 });
      assert.ok(res.data.bytes instanceof Uint8Array);
      assert.deepEqual(Array.from(res.data.bytes), Array.from(bytes));
      assert.equal(res.data.mimeType, mime);
      assert.equal(res.data.resultUrl, "https://urlpipe.dev/r/abc.png");
      assert.equal(res.meta.resultUrl, "https://urlpipe.dev/r/abc.png");
    });
  }

  test("decodes a larger image byte-for-byte", async () => {
    const bytes = new Uint8Array(100_003);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    bytes.set(PNG_BYTES.subarray(0, 8), 0);
    stub.reply(200, b64(bytes));
    const res = await client.screenshot("https://example.com");
    assert.equal(Buffer.compare(Buffer.from(res.data.bytes), Buffer.from(bytes)), 0);
    assert.equal(res.data.resultUrl, null);
  });
});

describe("async", () => {
  test("sync: false returns an accepted response with the token", async () => {
    stub.reply(200, { token: "tok_async", status: "accepted", labels: { client: "acme" } }, { "X-Result-Token": "tok_async", "X-Cache": "miss" });
    const res = await client.markdown("https://example.com", { sync: false, labels: { client: "acme" } });
    assert.equal(lastRequest().body.sync, false);
    assert.equal(res.status, "accepted");
    assert.equal(res.data, null);
    assert.equal(res.token, "tok_async");
    assert.deepEqual(res.labels, { client: "acme" });
    assert.equal(res.meta.cache, "miss");
  });

  test("an accepted response takes the token from the body when the header is absent", async () => {
    stub.reply(200, { token: "tok_body", status: "accepted", labels: {} });
    const res = await client.screenshot("https://example.com", { sync: false });
    assert.equal(res.status, "accepted");
    assert.equal(res.token, "tok_body");
    assert.deepEqual(res.labels, {});
  });
});
