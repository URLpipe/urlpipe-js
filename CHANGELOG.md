# Changelog

## Unreleased

- `meta.finalUrl` is the address the page ended on, after its redirects (the `X-Final-Url` header). `Metadata`, `ScrapeResult` and `WebhookPayload` carry it as `final_url` too.
- `meta` returns the fixed shape of `/meta`, and `Metadata` types every key: `canonical_url`, `title`, `description`, `site_name`, `type`, `language`, `locale`, `authors`, `published_at`, `modified_at`, `image`, `video`, `favicon_url`, `icons`, `logo_url`, `feeds`, `keywords`, `theme_color`, `generator`, `manifest_url`, `robots`, `open_graph`, `twitter`, `alternates`, `oembed_url`, `structured_data_types` — always present, `null` or empty when the page declares nothing. `main_image_url`, `author_name`, `publication_date`, `feed_url` and `additional_author_information` are gone: read `image.url`, `authors`, `published_at` and `feeds`.

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
