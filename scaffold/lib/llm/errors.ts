import Anthropic from "@anthropic-ai/sdk";

// Shared provider-error handling for both the "Test key" probe (cloudModels.ts)
// and search-time errors from an actual match run (app/api/match/handler.ts).

// Redacts anything that looks like a secret before a provider's error message
// ever reaches the UI: the literal key we sent, plus any sk-/sk-ant- style
// token embedded in the message (e.g. a provider echoing back what it saw).
const SECRET_TOKEN_PATTERN = /\bsk-(?:ant-)?[A-Za-z0-9_-]{6,}\b/g;
const MAX_PROVIDER_MESSAGE_LENGTH = 300;
const HTML_PATTERN = /^\s*<|<html\b/i;

export function redactKey(text: string, key?: string): string {
  return key && key.length >= 6 ? text.split(key).join("[redacted]") : text;
}

export function sanitizeProviderMessage(message: string, key?: string): string {
  let out = redactKey(message, key);
  out = out.replace(SECRET_TOKEN_PATTERN, "[redacted]");
  out = out.trim();
  if (out.length > MAX_PROVIDER_MESSAGE_LENGTH) out = `${out.slice(0, MAX_PROVIDER_MESSAGE_LENGTH)}…`;
  return out;
}

/** The human-readable message from a provider's error body (JSON `error.message`
 * or `message`, incl. Gemini's array-wrapped shape, or plain text). Undefined for
 * an empty body, an HTML error page, or JSON with no message. */
export function providerMessageFromBody(text: string): string | undefined {
  if (!text || HTML_PATTERN.test(text)) return undefined;
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return text;
  }
  const e = Array.isArray(json) ? json[0] : json;
  const msg = e?.error?.message ?? e?.error ?? e?.message;
  return typeof msg === "string" && msg ? msg : undefined;
}

export function anthropicRawMessage(err: InstanceType<typeof Anthropic.APIError>): string | undefined {
  const body: any = (err as any).error;
  const bodyMessage = body?.error?.message ?? body?.message;
  const raw = typeof bodyMessage === "string" ? bodyMessage : err.message;
  return raw && !HTML_PATTERN.test(raw.replace(/^\d{3}\s+/, "")) ? raw : undefined;
}

/** Thrown by the OpenAI-compatible chat shim (lib/llm/client.ts) so callers can
 * tell a provider HTTP status apart from a network/programming error — mirrors
 * what `Anthropic.APIError.status` already gives us for the Anthropic path. */
export class ProviderHttpError extends Error {
  status: number;
  raw: string;
  /** Parsed Retry-After-Ms or Retry-After (seconds, converted to ms) from the response, when present. */
  retryAfterMs?: number;
  constructor(status: number, raw: string, message?: string, retryAfterMs?: number) {
    super(message ?? raw);
    this.name = "ProviderHttpError";
    this.status = status;
    this.raw = raw;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Retry-After-Ms (preferred) or Retry-After (seconds) from a fetch Response's headers. */
export function retryAfterMsFromResponse(res: { headers?: { get(name: string): string | null } }): number | undefined {
  if (!res.headers) return undefined;
  const msHeader = res.headers.get("retry-after-ms");
  if (msHeader) {
    const ms = Number(msHeader);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  const secondsHeader = res.headers.get("retry-after");
  if (secondsHeader) {
    const seconds = Number(secondsHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return undefined;
}

/**
 * For a search-time failure from either the Anthropic SDK or the OpenAI-compat
 * shim: the sanitized provider message when it's a 4xx (the client's key/perms/
 * billing/etc. caused it — safe and useful to show), or undefined for 5xx /
 * network / unknown errors, which keep the caller's generic message.
 */
export function sanitizedProviderErrorFor4xx(err: unknown): string | undefined {
  let raw: string | undefined;
  if (err instanceof Anthropic.APIError) {
    if (typeof err.status === "number" && err.status >= 400 && err.status < 500) raw = anthropicRawMessage(err);
  } else if (err instanceof ProviderHttpError) {
    if (err.status >= 400 && err.status < 500) raw = providerMessageFromBody(err.raw);
  }
  return raw ? sanitizeProviderMessage(raw) : undefined;
}

/**
 * For server-side logging of a rejected batch (any status, not just 4xx): the
 * provider HTTP status when known, plus a sanitized message safe to log — never
 * the raw error, which could echo back request/response bodies.
 */
export function describeErrorForLog(err: unknown): { status?: number; message: string } {
  let status: number | undefined;
  let raw: string;
  if (err instanceof Anthropic.APIError) {
    status = typeof err.status === "number" ? err.status : undefined;
    raw = anthropicRawMessage(err) ?? err.message;
  } else if (err instanceof ProviderHttpError) {
    status = err.status;
    raw = providerMessageFromBody(err.raw) ?? err.message;
  } else if (err instanceof Error) {
    raw = err.message;
  } else {
    raw = String(err);
  }
  return { status, message: sanitizeProviderMessage(raw) };
}
