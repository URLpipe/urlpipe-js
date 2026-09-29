/** A string→string map attached to a request and returned with its result. */
export type Labels = Record<string, string>;

/**
 * `page_options`: how the page is prepared before it is read. Sent to the API
 * exactly as given, so keys use the API's snake_case names.
 * See https://urlpipe.dev/docs/page-options
 */
export interface PageOptions {
  wait_for_selector?: string;
  delay?: number;
  block_ads?: boolean;
  block_cookie_banners?: boolean;
  remove_selectors?: string[];
  [key: string]: unknown;
}

/**
 * `screenshot_options`: size, format and look of a screenshot. Sent to the API
 * exactly as given, so keys use the API's snake_case names.
 * See https://urlpipe.dev/docs/screenshot#options
 */
export interface ScreenshotOptions {
  full_page?: boolean;
  full_page_max_height?: number;
  viewport_width?: number;
  viewport_height?: number;
  device_scale_factor?: number;
  selector?: string;
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  omit_background?: boolean;
  dark_mode?: boolean;
  hide_selectors?: string[];
  styles?: string;
  [key: string]: unknown;
}

/** Options every analysis method takes. */
export interface RequestOptions {
  /**
   * Wait for the result (`true`, the default here) or return a token at once
   * (`false`). The HTTP API itself defaults to async; this library does not.
   */
  sync?: boolean;
  /** How fresh a cached result must be: seconds, or a duration like `"3 days"`. `0` bypasses the cache. */
  maxAge?: number | string;
  /** Your own keys for this request, returned with its result. */
  labels?: Labels;
  /** Fetch the page from a residential exit. */
  residential?: boolean;
  /** Webhook URL the result is POSTed to (async requests). */
  reportTo?: string;
  /**
   * Sent as the `Idempotency-Key` header. When omitted and retries are on,
   * the client generates one per call so a retry never runs the work twice.
   */
  idempotencyKey?: string;
  /** Extra body parameters, merged into the JSON body as given. */
  extra?: Record<string, unknown>;
}

/** Options for markdown, html, summarize, meta, keywords and console. */
export interface PageRequestOptions extends RequestOptions {
  pageOptions?: PageOptions;
}

export interface ScreenshotRequestOptions extends PageRequestOptions {
  screenshotOptions?: ScreenshotOptions;
}

export type LighthouseDevice = "mobile" | "desktop";

export interface LighthouseRequestOptions extends RequestOptions {
  device?: LighthouseDevice;
  includeAudits?: boolean;
}

export interface ScrapeRequestOptions extends PageRequestOptions {
  device?: LighthouseDevice;
  includeAudits?: boolean;
  screenshotOptions?: ScreenshotOptions;
}

export type ScrapeOperation =
  | "html"
  | "markdown"
  | "meta"
  | "summarize"
  | "keywords"
  | "screenshot"
  | "console"
  | "lighthouse";

/** A decoded screenshot. */
export interface Screenshot {
  /** The image itself. */
  bytes: Uint8Array;
  /** `image/png`, `image/jpeg` or `image/webp`, read from the image's own bytes. */
  mimeType: string;
  /** A link to the image that needs no API key (from `X-Result-Url`), or `null`. */
  resultUrl: string | null;
}

/** One author of the page. */
export interface MetadataAuthor {
  name: string;
  url: string | null;
  profiles: string[];
}

/** The page's share image, with what the page declares about it. */
export interface MetadataImage {
  url: string;
  width: number | null;
  height: number | null;
  alt: string | null;
  type: string | null;
}

/** The page's video. */
export interface MetadataVideo {
  url: string;
  type: string | null;
  width: number | null;
  height: number | null;
}

/** An icon the page declares. */
export interface MetadataIcon {
  url: string;
  rel: string;
  sizes: string | null;
  type: string | null;
}

/** An RSS, Atom or JSON feed. */
export interface MetadataFeed {
  url: string;
  type: string | null;
  title: string | null;
}

/** The page in another language. */
export interface MetadataAlternate {
  hreflang: string;
  url: string;
}

/**
 * The body of `/meta`. Keys are the API's own, and every one is always present:
 * a value the page doesn't declare is `null` or an empty list. URLs are absolute,
 * dates ISO 8601.
 */
export interface Metadata {
  /** Where the page ended up, after its redirects; relative URLs are resolved against it. */
  final_url: string | null;
  canonical_url: string | null;
  title: string | null;
  description: string | null;
  site_name: string | null;
  type: string | null;
  language: string | null;
  locale: string | null;
  authors: MetadataAuthor[];
  published_at: string | null;
  modified_at: string | null;
  image: MetadataImage | null;
  video: MetadataVideo | null;
  favicon_url: string | null;
  icons: MetadataIcon[];
  logo_url: string | null;
  feeds: MetadataFeed[];
  keywords: string[];
  theme_color: string | null;
  generator: string | null;
  manifest_url: string | null;
  robots: { index: boolean; follow: boolean };
  open_graph: {
    title: string | null;
    description: string | null;
    image: string | null;
    url: string | null;
    type: string | null;
    site_name: string | null;
    locale: string | null;
  };
  twitter: {
    card: string | null;
    site: string | null;
    creator: string | null;
    title: string | null;
    description: string | null;
    image: string | null;
  };
  alternates: MetadataAlternate[];
  oembed_url: string | null;
  structured_data_types: string[];
  [key: string]: unknown;
}

export interface ConsoleEntry {
  type: "error" | "warning" | "exception";
  text: string;
}

/** The body of `/lighthouse`. Keys are the API's own. */
export interface LighthouseResult {
  url: string;
  fetchTime: string;
  device: string;
  categories: Record<string, { score: number | null; title: string } | null>;
  metrics: Record<string, unknown>;
  audits?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ScrapeOperationResult {
  success: boolean;
  /** The operation's usual result. A screenshot here stays a Base64 string. */
  result: unknown;
  error?: string | null;
  cached?: boolean;
}

/** The body of `/scrape`. */
export interface ScrapeResult {
  url: string;
  /** Where the page ended up, after its redirects. */
  final_url: string | null;
  /** One entry per operation requested. */
  operations: { [K in ScrapeOperation]?: ScrapeOperationResult };
}

/** What `data` holds, per operation. */
export interface OperationData {
  markdown: string;
  html: string;
  summarize: string;
  screenshot: Screenshot;
  meta: Metadata;
  keywords: string[];
  console: ConsoleEntry[];
  lighthouse: LighthouseResult;
  scrape: ScrapeResult;
}

export type Operation = keyof OperationData;

/** Quota figures from the `X-Quota-*` headers. */
export interface Quota {
  cost: number | null;
  /** A number, or `"unlimited"`. */
  limit: number | string | null;
  /** A number, or `"unlimited"`. */
  remaining: number | string | null;
  overage: number | null;
  resetsAt: string | null;
}

/** Parsed response headers. A missing header is `null`. */
export interface ResponseMeta {
  /** `"hit"`, `"miss"` or (scrape only) `"partial"`. */
  cache: string | null;
  cacheAge: number | null;
  processingTimeMs: number | null;
  quota: Quota;
  /** A number, or `"unlimited"`. */
  concurrencyLimit: number | string | null;
  resultUrl: string | null;
  /** Where the page ended up, after its redirects (from `X-Final-Url`), or `null`. */
  finalUrl: string | null;
  /** `true` when this answer replays an earlier request with the same Idempotency-Key. */
  idempotentReplayed: boolean;
}

interface BaseResponse {
  /** The request's token, for `result()` and `wait()`. */
  token: string | null;
  /** The request's labels; `{}` when it had none. */
  labels: Labels;
  meta: ResponseMeta;
}

export interface CompletedResponse<T> extends BaseResponse {
  status: "completed";
  data: T;
}

export interface AcceptedResponse extends BaseResponse {
  status: "accepted";
  data: null;
}

export interface ProcessingResponse extends BaseResponse {
  status: "processing";
  data: null;
}

export type UrlpipeResponse<T> = CompletedResponse<T> | AcceptedResponse | ProcessingResponse;

/**
 * The response type an analysis call resolves to: `{ sync: false }` gives an
 * accepted response, the default (or `sync: true`) a completed one.
 */
export type ResponseFor<O, T> = [SyncOption<O>] extends [false]
  ? AcceptedResponse
  : [SyncOption<O>] extends [true | undefined]
    ? CompletedResponse<T>
    : CompletedResponse<T> | AcceptedResponse;

type SyncOption<O> = "sync" extends keyof O ? O[keyof O & "sync"] : undefined;

/** The `data` type `result()` / `wait()` produce for an optional operation hint. */
export type DataFor<Op extends Operation | undefined> = Op extends Operation ? OperationData[Op] : unknown;

export interface ResultOptions<Op extends Operation | undefined = undefined> {
  /**
   * The operation that produced the token, so `data` is typed and decoded as
   * that operation's result (a screenshot is decoded only with this hint).
   */
  operation?: Op;
}

export interface WaitOptions<Op extends Operation | undefined = undefined> extends ResultOptions<Op> {
  /** Give up after this many milliseconds. Defaults to the client's `waitTimeout`. */
  timeout?: number;
  /** Milliseconds between polls. Default 2000. */
  interval?: number;
}

/** A verified webhook delivery. Keys are the API's own. */
export interface WebhookPayload {
  token: string;
  operation: string;
  labels: Labels;
  success: boolean;
  result: unknown;
  result_url: string | null;
  /** Where the page ended up, after its redirects. */
  final_url: string | null;
  error: string | null;
  meta: {
    cache: string | null;
    cache_age: number | null;
    processing_time_ms: number | null;
    quota: {
      cost: number | null;
      limit: number | string | null;
      remaining: number | string | null;
      overage: number | null;
      resets_at: string | null;
      concurrency_limit: number | string | null;
    };
  };
  [key: string]: unknown;
}
