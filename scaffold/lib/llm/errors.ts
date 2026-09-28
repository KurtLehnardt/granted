import Anthropic from "@anthropic-ai/sdk";

// Shared provider-error handling for both the "Test key" probe (cloudModels.ts)
// and search-time errors from an actual match run (app/api/match/handler.ts).

// Redacts anything that looks like a secret before a provider's error message
// ever reaches the UI: the literal key we sent, plus any sk-/sk-ant- style
// token embedded in the message (e.g. a provider echoing back what it saw).
const SECRET_TOKEN_PATTERN = /\bsk-(?:ant-)?[A-Za-z0-9_-]{6,}\b/g;
const MAX_PROVIDER_MESSAGE_LENGTH = 300;

export function sanitizeProviderMessage(message: string, key?: string): string {
  let out = message;
  if (key && key.length >= 6) out = out.split(key).join("[redacted]");
  out = out.replace(SECRET_TOKEN_PATTERN, "[redacted]");
  out = out.trim();
  if (out.length > MAX_PROVIDER_MESSAGE_LENGTH) out = `${out.slice(0, MAX_PROVIDER_MESSAGE_LENGTH)}…`;
  return out;
}

export function anthropicRawMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body: any = (err as any).error;
  const bodyMessage = body?.error?.message ?? body?.message;
  return typeof bodyMessage === "string" ? bodyMessage : err.message;
}

/** Thrown by the OpenAI-compatible chat shim (lib/llm/client.ts) so callers can
 * tell a provider HTTP status apart from a network/programming error — mirrors
 * what `Anthropic.APIError.status` already gives us for the Anthropic path. */
export class ProviderHttpError extends Error {
  status: number;
  raw: string;
  constructor(status: number, raw: string, message?: string) {
    super(message ?? raw);
    this.name = "ProviderHttpError";
    this.status = status;
    this.raw = raw;
  }
}

/**
 * For a search-time failure from either the Anthropic SDK or the OpenAI-compat
 * shim: the sanitized provider message when it's a 4xx (the client's key/perms/
 * billing/etc. caused it — safe and useful to show), or undefined for 5xx /
 * network / unknown errors, which keep the caller's generic message.
 */
export function sanitizedProviderErrorFor4xx(err: unknown): string | undefined {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return sanitizeProviderMessage(anthropicRawMessage(err));
    }
    return undefined;
  }
  if (err instanceof ProviderHttpError) {
    if (err.status >= 400 && err.status < 500) {
      return sanitizeProviderMessage(err.raw);
    }
    return undefined;
  }
  return undefined;
}
