# Changelog

## 0.1.0

The first release of the URLpipe client for JavaScript and TypeScript.

- One method per operation: `markdown`, `html`, `summarize`, `screenshot`, `meta`, `keywords`, `console`, `lighthouse` and `scrape`, plus `result` and `wait` for tokens.
- Calls wait for the result by default; a sync call that outlives the API's 60-second window is polled to completion.
- Screenshots decoded to a `Uint8Array` with their MIME type and a keyless image link.
- Typed responses, with every response header parsed into `meta`.
- One error class per failure, all extending `UrlpipeError`.
- Automatic retries with an `Idempotency-Key` on every call, so a retry never runs or bills the work twice.
- `verifyWebhook` for signed webhook deliveries, built on Web Crypto.
- ESM and CommonJS builds, zero runtime dependencies; Node 18+, Bun, Deno and Cloudflare Workers.
