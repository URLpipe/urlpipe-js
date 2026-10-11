import {
  APIConnectionError,
  ConcurrencyLimitError,
  ConfigurationError,
  RateLimitedError,
  ServerError,
  UrlpipeError,
  WaitTimeoutError,
  errorFromResponse,
} from "./errors.js";
import type {
  AcceptedResponse,
  CompletedResponse,
  DataFor,
  ExtractField,
  ExtractRequestOptions,
  Labels,
  LighthouseRequestOptions,
  Operation,
  OperationData,
  PageRequestOptions,
  PdfRequestOptions,
  ProcessingResponse,
  ResponseFor,
  ResponseMeta,
  ResultOptions,
  ScrapeOperation,
  ScrapeRequestOptions,
  ScreenshotRequestOptions,
  UrlpipeResponse,
  WaitOptions,
} from "./types.js";
import { decodeBase64, detectImageMime, isObject, sleep, uuidv4 } from "./util.js";
import { VERSION } from "./version.js";

export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** A project API key. Falls back to the `URLPIPE_API_KEY` environment variable. */
  apiKey?: string;
  /** Default `https://urlpipe.dev`. */
  baseUrl?: string;
  /** Per-HTTP-request timeout in milliseconds. Default 90000 (the API holds a sync request up to 60 s). */
  timeout?: number;
  /** Automatic retries for connection errors, 429 rate/concurrency limits and 500/502/503. Default 2. */
  maxRetries?: number;
  /** How long a call keeps polling for a result that outlived the sync window, in milliseconds. Default 300000. */
  waitTimeout?: number;
  /**
   * Your program's product token, such as `"my-app/1.2"`. It goes in front of
   * the client's own, so requests identify both: `my-app/1.2 urlpipe-js/<version>`.
   */
  userAgent?: string;
  /** A `fetch` implementation to use instead of the global one. */
  fetch?: FetchFunction;
}

const DEFAULT_BASE_URL = "https://urlpipe.dev";
const DEFAULT_TIMEOUT = 90_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_WAIT_TIMEOUT = 300_000;
const DEFAULT_POLL_INTERVAL = 2_000;
const MAX_RETRY_DELAY = 60_000;
const USER_AGENT = `urlpipe-js/${VERSION}`;

const TEXT_OPERATIONS = new Set<Operation>(["markdown", "html", "summarize"]);

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

function readEnvApiKey(): string | undefined {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.URLPIPE_API_KEY || undefined;
  } catch {
    // Deno without --allow-env throws here.
    return undefined;
  }
}

function intOrNull(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/** A number when the value is numeric, the string as given otherwise (e.g. `"unlimited"`). */
function numberOrString(value: string | null): number | string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function parseLabels(value: string | null): Labels | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? (parsed as Labels) : null;
  } catch {
    return null;
  }
}

function parseMeta(headers: Headers): ResponseMeta {
  return {
    cache: headers.get("x-cache"),
    cacheAge: intOrNull(headers.get("x-cache-age")),
    processingTimeMs: intOrNull(headers.get("x-processing-time-ms")),
    quota: {
      cost: intOrNull(headers.get("x-quota-cost")),
      limit: numberOrString(headers.get("x-quota-limit")),
      remaining: numberOrString(headers.get("x-quota-remaining")),
      overage: intOrNull(headers.get("x-quota-overage")),
      resetsAt: headers.get("x-quota-reset"),
    },
    concurrencyLimit: numberOrString(headers.get("x-concurrency-limit")),
    resultUrl: headers.get("x-result-url"),
    finalUrl: headers.get("x-final-url"),
    idempotentReplayed: headers.get("idempotent-replayed")?.trim().toLowerCase() === "true",
  };
}

function parseBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseJsonResult(text: string, raw: RawResponse): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new UrlpipeError("The URLpipe API sent a result that is not valid JSON.", {
      status: raw.status,
      body: text,
      token: raw.headers.get("x-result-token"),
      cause,
    });
  }
}

function parseData(operation: Operation | undefined, raw: RawResponse): unknown {
  if (operation === undefined) {
    const contentType = raw.headers.get("content-type") ?? "";
    return contentType.includes("json") ? parseBody(raw.text) : raw.text;
  }
  if (TEXT_OPERATIONS.has(operation)) return raw.text;
  if (operation === "screenshot") {
    const bytes = decodeBase64(raw.text.trim());
    return { bytes, mimeType: detectImageMime(bytes), resultUrl: raw.headers.get("x-result-url") };
  }
  if (operation === "pdf") {
    return { bytes: decodeBase64(raw.text.trim()), mimeType: "application/pdf", resultUrl: raw.headers.get("x-result-url") };
  }
  return parseJsonResult(raw.text, raw);
}

function tokenAndLabels(raw: RawResponse): { token: string | null; labels: Labels } {
  const body = parseBody(raw.text);
  const obj = isObject(body) ? body : {};
  return {
    token: raw.headers.get("x-result-token") ?? (typeof obj.token === "string" ? obj.token : null),
    labels: parseLabels(raw.headers.get("x-labels")) ?? (isObject(obj.labels) ? (obj.labels as Labels) : {}),
  };
}

/** The URLpipe API client. */
export class Urlpipe {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly waitTimeout: number;
  /** @internal The first backoff step in ms (1000). Tests shrink it. */
  _retryBaseMs = 1000;
  readonly #apiKey: string;
  readonly #userAgent: string;
  readonly #fetch: FetchFunction;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? readEnvApiKey();
    if (!apiKey) {
      throw new ConfigurationError(
        "No URLpipe API key. Pass { apiKey } or set the URLPIPE_API_KEY environment variable to a project API key from your dashboard.",
      );
    }
    const fetchFn =
      options.fetch ??
      (typeof globalThis.fetch === "function" ? (input: string, init: RequestInit) => globalThis.fetch(input, init) : undefined);
    if (!fetchFn) {
      throw new ConfigurationError("No fetch function. Use Node 18 or later, or pass { fetch }.");
    }
    this.#apiKey = apiKey;
    const product = options.userAgent?.trim();
    this.#userAgent = product ? `${product} ${USER_AGENT}` : USER_AGENT;
    this.#fetch = fetchFn;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.waitTimeout = options.waitTimeout ?? DEFAULT_WAIT_TIMEOUT;
  }

  /** The page as Markdown. */
  markdown<O extends PageRequestOptions = {}>(url: string, options?: O): Promise<ResponseFor<O, string>> {
    return this.#analyze("markdown", url, options) as Promise<ResponseFor<O, string>>;
  }

  /** The rendered HTML, after JavaScript ran. */
  html<O extends PageRequestOptions = {}>(url: string, options?: O): Promise<ResponseFor<O, string>> {
    return this.#analyze("html", url, options) as Promise<ResponseFor<O, string>>;
  }

  /** A summary of the page, as Markdown. */
  summarize<O extends PageRequestOptions = {}>(url: string, options?: O): Promise<ResponseFor<O, string>> {
    return this.#analyze("summarize", url, options) as Promise<ResponseFor<O, string>>;
  }

  /** A screenshot, decoded to bytes. */
  screenshot<O extends ScreenshotRequestOptions = {}>(
    url: string,
    options?: O,
  ): Promise<ResponseFor<O, OperationData["screenshot"]>> {
    return this.#analyze("screenshot", url, options) as Promise<ResponseFor<O, OperationData["screenshot"]>>;
  }

  /** The whole rendered page as a PDF, decoded to bytes. */
  pdf<O extends PdfRequestOptions = {}>(url: string, options?: O): Promise<ResponseFor<O, OperationData["pdf"]>> {
    return this.#analyze("pdf", url, options) as Promise<ResponseFor<O, OperationData["pdf"]>>;
  }

  /** Title, description, language, images, author and more. */
  meta<O extends PageRequestOptions = {}>(url: string, options?: O): Promise<ResponseFor<O, OperationData["meta"]>> {
    return this.#analyze("meta", url, options) as Promise<ResponseFor<O, OperationData["meta"]>>;
  }

  /** The page's keywords. */
  keywords<O extends PageRequestOptions = {}>(url: string, options?: O): Promise<ResponseFor<O, string[]>> {
    return this.#analyze("keywords", url, options) as Promise<ResponseFor<O, string[]>>;
  }

  /**
   * Data from the page in the schema `fields` describes: one key per field,
   * in order, `null` where the page gives no value.
   */
  extract<O extends ExtractRequestOptions = {}>(
    url: string,
    fields: readonly ExtractField[],
    options?: O,
  ): Promise<ResponseFor<O, OperationData["extract"]>> {
    return this.#analyze("extract", url, { ...options, fields }) as Promise<ResponseFor<O, OperationData["extract"]>>;
  }

  /** Console errors, warnings and uncaught exceptions the page produced. */
  console<O extends PageRequestOptions = {}>(url: string, options?: O): Promise<ResponseFor<O, OperationData["console"]>> {
    return this.#analyze("console", url, options) as Promise<ResponseFor<O, OperationData["console"]>>;
  }

  /** What the page is built with: its CMS, frameworks, analytics, CDN, with versions. */
  technologies<O extends PageRequestOptions = {}>(url: string, options?: O): Promise<ResponseFor<O, OperationData["technologies"]>> {
    return this.#analyze("technologies", url, options) as Promise<ResponseFor<O, OperationData["technologies"]>>;
  }

  /** A Lighthouse audit. */
  lighthouse<O extends LighthouseRequestOptions = {}>(
    url: string,
    options?: O,
  ): Promise<ResponseFor<O, OperationData["lighthouse"]>> {
    return this.#analyze("lighthouse", url, options) as Promise<ResponseFor<O, OperationData["lighthouse"]>>;
  }

  /** Several operations off one page visit. */
  scrape<O extends ScrapeRequestOptions = {}>(
    url: string,
    operations: readonly ScrapeOperation[],
    options?: O,
  ): Promise<ResponseFor<O, OperationData["scrape"]>> {
    return this.#analyze("scrape", url, options, operations) as Promise<ResponseFor<O, OperationData["scrape"]>>;
  }

  /**
   * Fetches a result by token, once. A result still running comes back as a
   * `"processing"` response, not an error. Pass `{ operation }` to have `data`
   * typed and decoded as that operation's result: without it JSON is parsed
   * and text stays text, so a screenshot or a PDF stays Base64.
   */
  async result<Op extends Operation | undefined = undefined>(
    token: string,
    options: ResultOptions<Op> = {},
  ): Promise<CompletedResponse<DataFor<Op>> | ProcessingResponse> {
    // A 504 processing_timeout here means the work is still running, like a 202.
    const raw = await this.#request("GET", `/result/${encodeURIComponent(token)}`, undefined, undefined, true);
    const meta = parseMeta(raw.headers);
    const { token: responseToken, labels } = tokenAndLabels(raw);
    if (raw.status === 202 || raw.status === 504) {
      return { status: "processing", data: null, token: responseToken ?? token, labels, meta };
    }
    return {
      status: "completed",
      data: parseData(options.operation, raw) as DataFor<Op>,
      token: raw.headers.get("x-result-token") ?? token,
      labels: parseLabels(raw.headers.get("x-labels")) ?? {},
      meta,
    };
  }

  /**
   * Polls a token until its result is ready. Throws `WaitTimeoutError` (with
   * the token) when `timeout` passes first, or the result's own error if the
   * analysis failed.
   */
  async wait<Op extends Operation | undefined = undefined>(
    token: string,
    options: WaitOptions<Op> = {},
  ): Promise<CompletedResponse<DataFor<Op>>> {
    const timeout = options.timeout ?? this.waitTimeout;
    const interval = options.interval ?? DEFAULT_POLL_INTERVAL;
    const deadline = Date.now() + timeout;
    for (;;) {
      const response = await this.result(token, { operation: options.operation } as ResultOptions<Op>);
      if (response.status === "completed") return response;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new WaitTimeoutError(`The result for token ${token} was not ready within ${timeout} ms. It may still finish: fetch it later with result(token).`, {
          token,
        });
      }
      await sleep(Math.min(interval, remaining));
    }
  }

  async #analyze(
    operation: Operation,
    url: string,
    options: ScrapeRequestOptions & LighthouseRequestOptions = {},
    operations?: readonly ScrapeOperation[],
  ): Promise<UrlpipeResponse<unknown>> {
    const body: Record<string, unknown> = { url };
    if (operations !== undefined) body.operations = operations;
    if (options.pageOptions !== undefined) body.page_options = options.pageOptions;
    if (options.screenshotOptions !== undefined) body.screenshot_options = options.screenshotOptions;
    if (options.pdfOptions !== undefined) body.pdf_options = options.pdfOptions;
    if (options.fields !== undefined) body.fields = options.fields;
    if (options.instructions !== undefined) body.instructions = options.instructions;
    if (options.device !== undefined) body.device = options.device;
    if (options.includeAudits !== undefined) body.include_audits = options.includeAudits;
    if (options.maxAge !== undefined) body.max_age = options.maxAge;
    if (options.labels !== undefined) body.labels = options.labels;
    if (options.residential !== undefined) body.residential = options.residential;
    if (options.reportTo !== undefined) body.report_to = options.reportTo;
    body.sync = options.sync ?? true;
    // extra is merged last and may override anything, sync included.
    if (options.extra) Object.assign(body, options.extra);
    const sync = body.sync !== false && body.sync !== "false";

    // A retry must never run or bill the work twice: every request that may
    // be retried carries a key, reused across that call's retries.
    const idempotencyKey = options.idempotencyKey ?? (this.maxRetries > 0 ? await uuidv4() : undefined);

    let raw: RawResponse;
    try {
      raw = await this.#request("POST", `/${operation}`, body, idempotencyKey);
    } catch (error) {
      // The API gave up holding the connection, not on the work: poll for it.
      if (error instanceof ServerError && error.code === "processing_timeout" && error.token) {
        return this.wait(error.token, { operation, timeout: this.waitTimeout });
      }
      throw error;
    }

    const meta = parseMeta(raw.headers);
    if (!sync) {
      const { token, labels } = tokenAndLabels(raw);
      const accepted: AcceptedResponse = { status: "accepted", data: null, token, labels, meta };
      return accepted;
    }
    return {
      status: "completed",
      data: parseData(operation, raw),
      token: raw.headers.get("x-result-token"),
      labels: parseLabels(raw.headers.get("x-labels")) ?? {},
      meta,
    };
  }

  /** One logical request, retried as the retry policy allows. Resolves with a 2xx; throws otherwise. */
  async #request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    allowProcessingTimeout = false,
  ): Promise<RawResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      "User-Agent": this.#userAgent,
      Accept: "application/json, text/plain, */*",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      let error: UrlpipeError;
      try {
        const raw = await this.#send(this.baseUrl + path, init);
        if (raw.status >= 200 && raw.status < 300) return raw;
        const errorBody = parseBody(raw.text);
        if (allowProcessingTimeout && raw.status === 504 && isObject(errorBody) && errorBody.error === "processing_timeout") {
          return raw;
        }
        error = errorFromResponse(raw.status, errorBody, {
          retryAfter: raw.headers.get("retry-after"),
          resultToken: raw.headers.get("x-result-token"),
        });
      } catch (caught) {
        if (!(caught instanceof APIConnectionError)) throw caught;
        error = caught;
      }
      const delay = attempt < this.maxRetries ? retryDelay(error, attempt, this._retryBaseMs) : null;
      if (delay === null) throw error;
      await sleep(delay);
    }
  }

  async #send(url: string, init: RequestInit): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.#fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text };
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new APIConnectionError(`The request to ${url} timed out after ${this.timeout} ms.`, { cause });
      }
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new APIConnectionError(`Could not reach the URLpipe API at ${url}: ${reason}`, { cause });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Milliseconds to wait before retrying, or `null` when this error is not retried.
 * Backoff is 1 s, 2 s, 4 s … capped at 60 s; `rate_limited` waits out Retry-After.
 */
function retryDelay(error: UrlpipeError, attempt: number, baseMs: number): number | null {
  const backoff = Math.min(baseMs * 2 ** attempt, MAX_RETRY_DELAY);
  if (error instanceof RateLimitedError) {
    return error.retryAfter === null ? Math.min(baseMs, MAX_RETRY_DELAY) : Math.min(error.retryAfter * 1000, MAX_RETRY_DELAY);
  }
  if (error instanceof APIConnectionError || error instanceof ConcurrencyLimitError) return backoff;
  if (error instanceof ServerError && (error.status === 500 || error.status === 502 || error.status === 503)) return backoff;
  return null;
}
