// Type-level tests: checked by `tsc -p tsconfig.test.json --noEmit`, never run.
import Urlpipe, {
  Urlpipe as NamedUrlpipe,
  QuotaExceededError,
  UrlpipeError,
  verifyWebhook,
  type AcceptedResponse,
  type CompletedResponse,
  type ConsoleEntry,
  type LighthouseResult,
  type Metadata,
  type ProcessingResponse,
  type ScrapeResult,
  type Extraction,
  type Pdf,
  type Screenshot,
  type TechnologiesResult,
  type WebhookPayload,
} from "../src/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(_value?: T): void {}

declare const client: Urlpipe;
const _named: NamedUrlpipe = client;

async function checks() {
  // Default (sync) calls resolve to completed responses with typed data.
  const md = await client.markdown("https://example.com");
  assertType<Equal<typeof md, CompletedResponse<string>>>();
  const text: string = md.data;

  const meta = await client.meta("https://example.com", { maxAge: "3 days" });
  const title: string | null = meta.data.title;
  assertType<Equal<typeof meta.data, Metadata>>();

  const shot = await client.screenshot("https://example.com", { screenshotOptions: { format: "webp" } });
  assertType<Equal<typeof shot.data, Screenshot>>();
  const bytes: Uint8Array = shot.data.bytes;

  const pdf = await client.pdf("https://example.com", { pdfOptions: { paper_size: "letter", landscape: true } });
  assertType<Equal<typeof pdf.data, Pdf>>();
  const pdfBytes: Uint8Array = pdf.data.bytes;

  const extracted = await client.extract(
    "https://example.com",
    [
      { name: "price", type: "number", description: "The current price" },
      { name: "sizes", type: "array", items: "string" },
      { name: "seller", type: "object", fields: [{ name: "name", type: "string" }] },
    ],
    { instructions: "Prices in euros." },
  );
  assertType<Equal<typeof extracted.data, Extraction>>();
  const queued = await client.extract("https://example.com", [{ name: "price", type: "number" }], { sync: false });
  assertType<Equal<typeof queued, AcceptedResponse>>();

  const kw = await client.keywords("https://example.com", { sync: true });
  assertType<Equal<typeof kw.data, string[]>>();

  const logs = await client.console("https://example.com");
  assertType<Equal<typeof logs.data, ConsoleEntry[]>>();

  const tech = await client.technologies("https://example.com");
  assertType<Equal<typeof tech.data, TechnologiesResult>>();
  const version: string | null | undefined = tech.data.technologies[0]?.version;

  const lh = await client.lighthouse("https://example.com", { device: "desktop", includeAudits: true });
  assertType<Equal<typeof lh.data, LighthouseResult>>();

  const scraped = await client.scrape("https://example.com", ["markdown", "meta"], { pageOptions: { block_ads: true } });
  assertType<Equal<typeof scraped.data, ScrapeResult>>();
  const success: boolean | undefined = scraped.data.operations.markdown?.success;

  // sync: false resolves to an accepted response.
  const accepted = await client.summarize("https://example.com", { sync: false });
  assertType<Equal<typeof accepted, AcceptedResponse>>();
  const nothing: null = accepted.data;

  // A non-literal sync gives the union.
  const flag = Math.random() > 0.5;
  const either = await client.html("https://example.com", { sync: flag });
  assertType<Equal<typeof either, CompletedResponse<string> | AcceptedResponse>>();

  // result() and wait() are typed by the operation hint.
  const fetched = await client.result("tok", { operation: "screenshot" });
  assertType<Equal<typeof fetched, CompletedResponse<Screenshot> | ProcessingResponse>>();
  if (fetched.status === "completed") {
    const b: Uint8Array = fetched.data.bytes;
  }
  const untyped = await client.wait("tok");
  assertType<Equal<typeof untyped.data, unknown>>();
  const waited = await client.wait("tok", { operation: "meta", timeout: 1000 });
  assertType<Equal<typeof waited.data, Metadata>>();

  // Lighthouse takes no page options.
  // @ts-expect-error pageOptions is not a lighthouse option
  await client.lighthouse("https://example.com", { pageOptions: { block_ads: true } });

  // @ts-expect-error unknown scrape operation
  await client.scrape("https://example.com", ["gif"]);

  // Webhooks.
  const payload: WebhookPayload = await verifyWebhook("{}", new Headers(), "whsec_x");
  const payload2: Promise<WebhookPayload> = verifyWebhook(new Uint8Array(), { "x-urlpipe-timestamp": "1" }, "whsec_x", { tolerance: 60 });

  // Errors.
  const error: unknown = new QuotaExceededError("x", { limit: 1 });
  if (error instanceof UrlpipeError) {
    const status: number | null = error.status;
    const code: string | null = error.code;
  }

  new Urlpipe({ apiKey: "k", baseUrl: "http://localhost", timeout: 1, maxRetries: 0, waitTimeout: 1, fetch: (u, i) => fetch(u, i) });

  return { text, title, bytes, success, nothing, payload, payload2 };
}

void checks;
