import { isObject } from "./util.js";

export interface UrlpipeErrorFields {
  status?: number | null;
  code?: string | null;
  body?: unknown;
  token?: string | null;
  cause?: unknown;
}

/** The base class of every error this library throws. */
export class UrlpipeError extends Error {
  /** The HTTP status, or `null` when no response arrived. */
  readonly status: number | null;
  /** The body's `error` value when it is a machine-readable code (`"invalid_url"`, `"quota_exceeded"`…). */
  readonly code: string | null;
  /** The response body: parsed JSON when it was JSON, the raw text otherwise. */
  readonly body: unknown;
  /** The request's token, when the response carried one. */
  readonly token: string | null;

  constructor(message: string, fields: UrlpipeErrorFields = {}) {
    super(message, fields.cause === undefined ? undefined : { cause: fields.cause });
    this.name = new.target.name;
    this.status = fields.status ?? null;
    this.code = fields.code ?? null;
    this.body = fields.body ?? null;
    this.token = fields.token ?? null;
  }
}

/** The client was misconfigured, e.g. no API key was given. */
export class ConfigurationError extends UrlpipeError {}

/** 401: the API key is missing or does not match an active project key. */
export class AuthenticationError extends UrlpipeError {}

/** 403 `email_unverified`: the key is fine; confirm the email address on the account. */
export class EmailUnverifiedError extends UrlpipeError {}

/** 422 with a parameter code (`invalid_url`, `invalid_max_age`, `invalid_options`, …, or a `report_to` refusal). */
export class InvalidRequestError extends UrlpipeError {}

/**
 * 422 where the page itself could not be analysed. The message is the API's
 * sentence. A /scrape whose every operation failed keeps the scrape object on `body`.
 */
export class AnalysisFailedError extends UrlpipeError {}

/** 404 `not_found`: no result for this token under this project. */
export class NotFoundError extends UrlpipeError {}

/** 410 `stale`: the result is older than the 30-day retention window. */
export class StaleResultError extends UrlpipeError {}

/** 429 `quota_exceeded`: the Free plan's monthly credits are spent. */
export class QuotaExceededError extends UrlpipeError {
  readonly limit: number | null;
  readonly used: number | null;
  readonly needed: number | null;
  readonly resetsAt: string | null;

  constructor(
    message: string,
    fields: UrlpipeErrorFields & { limit?: number | null; used?: number | null; needed?: number | null; resetsAt?: string | null },
  ) {
    super(message, fields);
    this.limit = fields.limit ?? null;
    this.used = fields.used ?? null;
    this.needed = fields.needed ?? null;
    this.resetsAt = fields.resetsAt ?? null;
  }
}

/** 429 `concurrency_limit`: as many of your requests are running as the plan allows. */
export class ConcurrencyLimitError extends UrlpipeError {
  readonly limit: number | string | null;
  readonly running: number | null;

  constructor(message: string, fields: UrlpipeErrorFields & { limit?: number | string | null; running?: number | null }) {
    super(message, fields);
    this.limit = fields.limit ?? null;
    this.running = fields.running ?? null;
  }
}

/** 429 `rate_limited`: requests are arriving too fast. */
export class RateLimitedError extends UrlpipeError {
  /** Seconds to wait, from `Retry-After`. */
  readonly retryAfter: number | null;

  constructor(message: string, fields: UrlpipeErrorFields & { retryAfter?: number | null }) {
    super(message, fields);
    this.retryAfter = fields.retryAfter ?? null;
  }
}

/** A 5xx from the API. */
export class ServerError extends UrlpipeError {}

/** No response arrived: the connection failed or the request timed out. */
export class APIConnectionError extends UrlpipeError {}

/** `wait()` (or a sync call that outlived the API's 60 s) ran past its deadline. The work may still finish: keep the `token`. */
export class WaitTimeoutError extends UrlpipeError {}

/** A webhook delivery failed verification. The message says why. */
export class WebhookVerificationError extends UrlpipeError {}

const INVALID_REQUEST_CODES = new Set([
  "invalid_url",
  "invalid_max_age",
  "invalid_options",
  "invalid_labels",
  "invalid_idempotency_key",
  "idempotency_key_reused",
]);

const CODE_SHAPE = /^[a-z][a-z0-9_]*$/;

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** For a /scrape body whose every operation failed: "Every operation failed: <op>: <error>; …". */
function scrapeFailureMessage(body: Record<string, unknown>): string | null {
  const operations = body.operations;
  if (!isObject(operations)) return null;
  const parts = Object.entries(operations).map(([op, entry]) => {
    const error = isObject(entry) && typeof entry.error === "string" ? entry.error : "failed";
    return `${op}: ${error}`;
  });
  return parts.length > 0 ? `Every operation failed: ${parts.join("; ")}` : null;
}

export function errorFromResponse(
  status: number,
  body: unknown,
  headers: { retryAfter: string | null; resultToken: string | null },
): UrlpipeError {
  const obj = isObject(body) ? body : {};
  const errorValue = typeof obj.error === "string" ? obj.error : null;
  const code = errorValue !== null && CODE_SHAPE.test(errorValue) ? errorValue : null;
  const token = typeof obj.token === "string" ? obj.token : headers.resultToken;
  const apiMessage = typeof obj.message === "string" ? obj.message : null;
  const fields: UrlpipeErrorFields = { status, code, body, token };
  // The body's message, else its error when that is a sentence (never a bare
  // code), else a default for the kind of error.
  const message = (fallback: string) => apiMessage ?? (code === null ? errorValue : null) ?? fallback;

  if (status === 401) {
    return new AuthenticationError(message("The API key is missing or invalid. Use a project API key from your URLpipe dashboard."), fields);
  }
  if (status === 403 && code === "email_unverified") {
    return new EmailUnverifiedError(
      message("Confirm the email address on your URLpipe account to start using this API key: follow the link we emailed you."),
      fields,
    );
  }
  if (status === 422) {
    if ((code !== null && INVALID_REQUEST_CODES.has(code)) || (errorValue !== null && errorValue.startsWith("report_to"))) {
      return new InvalidRequestError(message("The request was invalid."), fields);
    }
    // A /scrape body whose every operation failed, or a human sentence (the
    // page could not be analysed).
    const scrapeMessage = errorValue === null && apiMessage === null ? scrapeFailureMessage(obj) : null;
    return new AnalysisFailedError(scrapeMessage ?? message("The page could not be analysed."), fields);
  }
  if (status === 429) {
    if (code === "quota_exceeded") {
      return new QuotaExceededError(message("The monthly credit allowance is spent."), {
        ...fields,
        limit: numberOrNull(obj.limit),
        used: numberOrNull(obj.used),
        needed: numberOrNull(obj.needed),
        resetsAt: typeof obj.resets_at === "string" ? obj.resets_at : null,
      });
    }
    if (code === "concurrency_limit") {
      return new ConcurrencyLimitError(message("Too many requests are already running."), {
        ...fields,
        limit: typeof obj.limit === "number" || typeof obj.limit === "string" ? obj.limit : null,
        running: numberOrNull(obj.running),
      });
    }
    if (code === "rate_limited") {
      return new RateLimitedError(message("Too many requests. Slow down and retry."), {
        ...fields,
        retryAfter: parseRetryAfter(headers.retryAfter) ?? numberOrNull(obj.retry_after),
      });
    }
  }
  if (status === 404) return new NotFoundError(message("No result for this token under this project."), fields);
  if (status === 410) return new StaleResultError(message("This result is older than the 30-day retention window."), fields);
  if (status >= 500) return new ServerError(message(`The URLpipe API answered HTTP ${status}.`), fields);
  return new UrlpipeError(message(`The URLpipe API answered HTTP ${status}.`), fields);
}

/** `Retry-After` as seconds: an integer, or an HTTP date. */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}
