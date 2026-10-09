# @urlpipe/sdk

Turn any URL into clean Markdown, rendered HTML, a full-page screenshot, metadata, a summary, keywords, console errors, a Lighthouse audit or the technologies it is built with, from JavaScript or TypeScript. Pages are rendered in real Chrome, so JavaScript-heavy sites come back complete.

The official client for the [URLpipe API](https://urlpipe.dev/docs). TypeScript types included, zero runtime dependencies, and it runs anywhere `fetch` does: Node 18+, Bun, Deno and Cloudflare Workers.

## Install

```sh
npm install @urlpipe/sdk
```

## Quickstart

Get a project API key from your [URLpipe dashboard](https://urlpipe.dev) (the Free plan gives you 1,000 credits a month, no card needed) and put it in `URLPIPE_API_KEY`.

```ts
import Urlpipe from "@urlpipe/sdk";

const client = new Urlpipe(); // reads URLPIPE_API_KEY

const { data } = await client.markdown("https://example.com");
console.log(data); // "# Example Domain\n\n…"
```

CommonJS works too: `const { Urlpipe } = require("@urlpipe/sdk")`.

## The client

```ts
const client = new Urlpipe({
  apiKey: "…",                    // default: process.env.URLPIPE_API_KEY
  baseUrl: "https://urlpipe.dev", // default
  timeout: 90_000,                // per HTTP request, in ms
  maxRetries: 2,                  // see "Retries and idempotency"
  waitTimeout: 300_000,           // how long a slow sync call keeps polling, in ms
  fetch: myFetch,                 // optional: your own fetch implementation
});
```

Constructing a client with no API key throws a `ConfigurationError` straight away, not on the first request.

## Every method

Each method takes the URL first; everything else is optional. Calls wait for the result by default (`sync: true`), so `data` is the answer.

```ts
const md = await client.markdown("https://example.com");   // data: string
const html = await client.html("https://example.com");     // data: string, after JavaScript ran
const sum = await client.summarize("https://example.com"); // data: string (Markdown)

const shot = await client.screenshot("https://example.com", {
  screenshotOptions: { format: "webp", viewport_width: 390 },
});
shot.data.bytes;     // Uint8Array, already decoded from Base64
shot.data.mimeType;  // "image/webp"
shot.data.resultUrl; // a link to the image that needs no API key

const meta = await client.meta("https://example.com");
meta.data.title; // also description, image?.url, authors, published_at, favicon_url, feeds, …

const kw = await client.keywords("https://example.com");  // data: string[]
const logs = await client.console("https://example.com"); // data: [{ type: "error" | "warning" | "exception", text }]

const tech = await client.technologies("https://example.com");
tech.data.technologies; // [{ name: "WordPress", version: "6.4.2", confidence: 100, categories, detected_by, … }]

const audit = await client.lighthouse("https://example.com", { device: "desktop", includeAudits: true });
audit.data.categories.performance?.score;

// Several operations off one page visit:
const all = await client.scrape("https://example.com", ["markdown", "meta", "screenshot"]);
all.data.operations.markdown?.result; // each entry: { success, result, error, cached }
```

Saving a screenshot in Node: `await fs.promises.writeFile("page.png", shot.data.bytes)`. Inside a `scrape` result a screenshot stays the Base64 string the API sent.

### Options

Every analysis method takes these:

| Option | Sent as | |
|---|---|---|
| `sync` | `sync` | `true` by default here. `false` returns a token straight away. |
| `maxAge` | `max_age` | Seconds, or a duration like `"3 days"`. `0` bypasses the cache. |
| `labels` | `labels` | Your own `{ key: "value" }` tags, returned with the result. |
| `residential` | `residential` | Fetch the page from a residential exit. |
| `reportTo` | `report_to` | Webhook URL for async results. |
| `pageOptions` | `page_options` | Everything except `lighthouse`. |
| `idempotencyKey` | `Idempotency-Key` header | See below. |
| `extra` | merged into the body | For API parameters this version doesn't know yet. |

`screenshot` and `scrape` also take `screenshotOptions`; `lighthouse` and `scrape` take `device` and `includeAudits`. The `pageOptions` and `screenshotOptions` maps go to the API unchanged, so their keys keep the API's names: `{ block_cookie_banners: true }`, `{ full_page: false }`. See [page options](https://urlpipe.dev/docs/page-options) and [screenshot options](https://urlpipe.dev/docs/screenshot#options).

### The response

Every method resolves to:

```ts
{
  status: "completed" | "accepted" | "processing",
  data,   // typed per method; null unless completed
  token,  // for result() and wait()
  labels, // {} when the request had none
  meta: {
    cache,            // "hit" | "miss" | "partial"
    cacheAge,         // seconds, or null
    processingTimeMs,
    quota: { cost, limit, remaining, overage, resetsAt }, // limit/remaining may be "unlimited"
    concurrencyLimit,
    resultUrl,
    finalUrl,         // where the page ended up, after its redirects
    idempotentReplayed,
  },
}
```

A header the API didn't send is `null`, never an exception.

## Async and `wait`

For slow work (Lighthouse, big batches) send `sync: false`: you get a token back at once and the result arrives at your webhook, or whenever you ask for it.

```ts
const job = await client.lighthouse("https://example.com", { sync: false });
job.status; // "accepted"

const done = await client.wait(job.token!, { operation: "lighthouse" });
done.data.categories;
```

`wait(token, { operation, timeout, interval })` polls every 2 seconds until the result is ready, and throws `WaitTimeoutError` (carrying the token) if `timeout` passes first. `result(token, { operation })` fetches once: a result still running comes back with `status: "processing"`, not an error.

Pass `operation` so `data` is typed and decoded like the original call. Without it JSON is parsed and text stays text, so `wait(token)` for a screenshot gives you the Base64 string; `wait(token, { operation: "screenshot" })` gives you the bytes.

You rarely need `wait` for sync calls. The API holds a sync request for up to 60 seconds; when an analysis runs longer it answers with a token instead, and the client polls for the result for you (up to `waitTimeout`). Your `await` just takes longer.

## Webhooks

When webhook signing is on for your project, check every delivery before you trust it:

```ts
import { verifyWebhook, WebhookVerificationError } from "@urlpipe/sdk";

// Express: use express.raw() on this route, not express.json().
app.post("/webhooks/urlpipe", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const payload = await verifyWebhook(req.body, req.headers, process.env.URLPIPE_WEBHOOK_SECRET!);
    // payload: { token, operation, labels, success, result, result_url, final_url, error, meta }
    res.sendStatus(200);
  } catch (error) {
    if (error instanceof WebhookVerificationError) return res.sendStatus(401);
    throw error;
  }
});
```

- Give it the **raw body** (a string or `Uint8Array`), exactly as received. Parsed and re-serialised JSON has different bytes and fails the check.
- `headers` can be a `Headers` object (Workers, Deno, Bun, Next.js) or a plain object such as Node's `req.headers`.
- It is **async** and returns a Promise, because it uses Web Crypto (`crypto.subtle`) so it runs on every runtime.
- It accepts the delivery when any `v1=` signature matches, so a secret rotation never drops a delivery, and rejects timestamps more than `tolerance` seconds away (default 300): `verifyWebhook(body, headers, secret, { tolerance: 600 })`.
- The payload keeps the API's own key names.

## Errors

Every error extends `UrlpipeError`, which carries `status`, `code`, `message`, `body` and `token`.

| Error | When |
|---|---|
| `AuthenticationError` | 401: the API key is missing or wrong. |
| `EmailUnverifiedError` | 403: confirm the email address on your account. |
| `InvalidRequestError` | 422 with a parameter code: `invalid_url`, `invalid_max_age`, `invalid_options`, `invalid_labels`, `invalid_idempotency_key`, `idempotency_key_reused`, or a `report_to` we won't deliver to. |
| `AnalysisFailedError` | 422: the page couldn't be analysed. The message says why. For a `scrape` where every operation failed, the message lists each one (`Every operation failed: markdown: …; meta: …`) and `body` holds the scrape object. |
| `QuotaExceededError` | 429: the Free plan's credits are spent. Has `limit`, `used`, `needed`, `resetsAt`. |
| `ConcurrencyLimitError` | 429: as many requests are running as your plan allows. Has `limit`, `running`. |
| `RateLimitedError` | 429: slow down. Has `retryAfter` (seconds). |
| `NotFoundError` | 404: no result for that token. |
| `StaleResultError` | 410: the result is past the 30-day retention window. |
| `ServerError` | Any other 5xx. |
| `APIConnectionError` | No response: network failure or `timeout`. |
| `WaitTimeoutError` | `wait` ran out of time. Has `token`: the work may still finish. |
| `WebhookVerificationError` | `verifyWebhook` rejected a delivery. |

```ts
import { QuotaExceededError, AnalysisFailedError } from "@urlpipe/sdk";

try {
  await client.summarize(url);
} catch (error) {
  if (error instanceof QuotaExceededError) console.log(`Credits reset at ${error.resetsAt}`);
  else if (error instanceof AnalysisFailedError) console.log(error.message); // "The request timed out."
  else throw error;
}
```

Failed analyses and cached results cost nothing.

## Retries and idempotency

The client retries up to `maxRetries` times (default 2) on connection errors, HTTP 500, 502 and 503, and `concurrency_limit`, waiting 1 s, 2 s, 4 s and so on (up to 60 s) between attempts. On `rate_limited` it waits out `Retry-After` (up to 60 s). It never retries 401, 403, 404, 410, 422, `quota_exceeded` or any other 429: those won't change by asking again.

A retry is always safe, even when the first attempt reached the server and only the answer got lost. Every call that may be retried carries an `Idempotency-Key`, generated per call when you don't pass one and reused for that call's retries, so the API answers a retry with the first request's result instead of running (and billing) the work twice. Pass your own `idempotencyKey` to extend that across processes, for example a job that may run twice. See [retries & duplicates](https://urlpipe.dev/docs/retries).

## Links

- Documentation: https://urlpipe.dev/docs
- Pricing: https://urlpipe.dev/pricing
- MCP server, for AI agents: https://github.com/URLpipe/mcp

## License

MIT © Aliat Partner S.L.
