import Anthropic from "@anthropic-ai/sdk";
import { ProviderHttpError } from "./errors";

// Free-tier rate limiting for cloud calls: 429 retry-with-backoff (honoring
// Retry-After / Retry-After-Ms first) and a per-preset concurrency gate.
// Works against both the Anthropic SDK path and the OpenAI-compat shim,
// since both expose the same `messages.create(params, options)` shape.

export interface MessagesLike {
  messages: { create(params: any, options?: any): Promise<any> };
}

export interface RetryOptions {
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** Total wait across all retries, in ms. Default 60s. */
  capMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_CAP_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full jitter exponential backoff, capped at 30s per attempt. */
function backoffMs(attempt: number): number {
  const cap = Math.min(1000 * 2 ** attempt, 30_000);
  return Math.random() * cap;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const rec = headers as Record<string, unknown>;
  const value = rec[name] ?? rec[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function retryAfterMsFromAnthropicError(err: InstanceType<typeof Anthropic.APIError>): number | undefined {
  const headers = (err as any).headers;
  const ms = Number(headerValue(headers, "retry-after-ms"));
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const seconds = Number(headerValue(headers, "retry-after"));
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return undefined;
}

/** 429 status + the delay to wait before retrying, or undefined for a non-429 (not retryable here). */
function retryableDelayMs(err: unknown, attempt: number): number | undefined {
  if (err instanceof Anthropic.APIError) {
    if (err.status !== 429) return undefined;
    return retryAfterMsFromAnthropicError(err) ?? backoffMs(attempt);
  }
  if (err instanceof ProviderHttpError) {
    if (err.status !== 429) return undefined;
    return err.retryAfterMs ?? backoffMs(attempt);
  }
  return undefined;
}

/** Retries a 429 with backoff (Retry-After / Retry-After-Ms honored first),
 * up to `maxRetries` attempts and `capMs` total wait; any other error, or a
 * 429 past either cap, rejects immediately. */
export function withRetry429<T extends MessagesLike>(client: T, opts: RetryOptions = {}): T {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const capMs = opts.capMs ?? DEFAULT_CAP_MS;
  return {
    ...client,
    messages: {
      ...client.messages,
      async create(params: any, options?: any): Promise<any> {
        let waited = 0;
        for (let attempt = 0; ; attempt++) {
          try {
            return await client.messages.create(params, options);
          } catch (err) {
            const delayMs = retryableDelayMs(err, attempt);
            if (delayMs === undefined || attempt >= maxRetries || waited + delayMs > capMs) throw err;
            waited += delayMs;
            await sleep(delayMs);
          }
        }
      },
    },
  } as T;
}

/** Caps simultaneous in-flight `messages.create` calls at `limit` (queuing the
 * rest) — gentler on a free-tier provider's own concurrency limits. No-op
 * when `limit` is unset. */
export function withConcurrencyLimit<T extends MessagesLike>(client: T, limit?: number): T {
  if (!limit || limit < 1) return client;
  const maxActive = limit;
  let active = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < maxActive) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  function release(): void {
    const next = queue.shift();
    if (next) next();
    else active--;
  }

  return {
    ...client,
    messages: {
      ...client.messages,
      async create(params: any, options?: any): Promise<any> {
        await acquire();
        try {
          return await client.messages.create(params, options);
        } finally {
          release();
        }
      },
    },
  } as T;
}
