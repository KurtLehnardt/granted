import Anthropic from "@anthropic-ai/sdk";
import { ProviderHttpError, anthropicRawMessage, providerMessageFromBody } from "./errors";

/**
 * Why a search failed, in words the user can act on. app/api/match maps the
 * thrown error through `describeSearchError`; anything it doesn't recognize
 * keeps the old behavior (a provider 4xx's own message, else the generic
 * "The search didn't complete").
 */

export type LocalSetupKind = "ollama_unreachable" | "local_model_missing" | "no_chat_models";

/** Thrown by the pre-search check (lib/llm/localPreflight.ts) when Local can't run. */
export class LocalSetupError extends Error {
  kind: LocalSetupKind;
  model?: string;
  constructor(kind: LocalSetupKind, model?: string) {
    super(
      kind === "ollama_unreachable"
        ? OLLAMA_UNREACHABLE
        : kind === "no_chat_models"
          ? NO_CHAT_MODELS
          : localModelMissing(model ?? "the selected model"),
    );
    this.name = "LocalSetupError";
    this.kind = kind;
    this.model = model;
  }
}

export const OLLAMA_UNREACHABLE =
  "Granted couldn't reach Ollama, which runs your Local model — start it in Settings → Model (or switch to Cloud there).";

export const NO_CHAT_MODELS =
  "Ollama has no chat model installed (embedding models like nomic-embed-text can't run searches) — download one in Settings → Model.";

export function localModelMissing(model: string): string {
  return `The local model "${model}" isn't installed in Ollama — pick an installed model or download it in Settings → Model.`;
}

export function outOfCredits(provider: string): string {
  return `Your ${provider} account is out of credits — add credits, or switch to Local in Settings → Model.`;
}

export function keyRejected(provider: string): string {
  return `Your ${provider} API key was rejected (it's invalid or has been revoked) — update it in Settings → Model, or switch to Local there.`;
}

export function providerUnreachable(provider: string): string {
  return `Granted couldn't reach ${provider} — check your internet connection and try again, or switch to Local in Settings → Model.`;
}

const BILLING =
  /credit balance is too low|insufficient[_ ]quota|exceeded your current quota|insufficient (?:balance|credits?|funds)|out of credits|payment required|purchase credits/i;
// Not a bare "billing": rate-limit messages link billing pages too (Groq: "Upgrade ... at .../settings/billing").
const BAD_KEY =
  /invalid[ _-]?(?:x-)?api[ _-]?key|incorrect api key|api key (?:not valid|is invalid|was revoked|has been revoked)|authentication[_ ]error|invalid authentication|unauthorized|revoked/i;
const MODEL_NOT_FOUND = /model ["']?([^"'\s]+)["']? not found|not found, try pulling it first/i;
const CONN_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

/** `err` and every `.cause` below it (an "All scoring batches failed" wrapper keeps the original as its cause). */
function causeChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; cur != null && i < 6 && !out.includes(cur); i++) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

/** A failed connection (nothing listening, DNS, reset) as opposed to an HTTP error. */
export function isConnectionError(err: unknown): boolean {
  return causeChain(err).some((e: any) => {
    if (!e) return false;
    if (e instanceof Anthropic.APIConnectionError && !(e instanceof Anthropic.APIConnectionTimeoutError)) return true;
    if (typeof e.code === "string" && CONN_CODES.has(e.code)) return true;
    return e instanceof TypeError && /fetch failed|failed to fetch|network/i.test(e.message);
  });
}

/** The provider HTTP status + message, from the Anthropic SDK or the OpenAI-compatible shim. */
function providerFailure(err: unknown): { status: number; message: string } | undefined {
  for (const e of causeChain(err)) {
    if (e instanceof Anthropic.APIError && typeof e.status === "number") {
      return { status: e.status, message: anthropicRawMessage(e) ?? "" };
    }
    if (e instanceof ProviderHttpError) {
      return { status: e.status, message: providerMessageFromBody(e.raw) ?? e.raw ?? "" };
    }
  }
  return undefined;
}

export type SearchErrorContext = {
  /** The search ran on Local (Ollama). */
  local: boolean;
  /** The local model the search used. */
  model?: string;
  /** The cloud provider's name ("Anthropic", "OpenAI", ...). */
  provider?: string;
};

/** A specific, actionable message for a failed search, or undefined when the cause isn't recognized. */
export function describeSearchError(err: unknown, ctx: SearchErrorContext): string | undefined {
  const setup = causeChain(err).find((e): e is LocalSetupError => e instanceof LocalSetupError);
  if (setup) return setup.message;

  const failure = providerFailure(err);
  if (ctx.local) {
    if (failure && (MODEL_NOT_FOUND.test(failure.message) || (failure.status === 404 && /\bmodel\b/i.test(failure.message)))) {
      return localModelMissing(MODEL_NOT_FOUND.exec(failure.message)?.[1] ?? ctx.model ?? "the selected model");
    }
    if (!failure && isConnectionError(err)) return OLLAMA_UNREACHABLE;
    return undefined;
  }

  const provider = ctx.provider ?? "cloud provider";
  if (failure) {
    if (failure.status === 402 || BILLING.test(failure.message)) return outOfCredits(provider);
    if (failure.status === 401 || BAD_KEY.test(failure.message)) {
      return keyRejected(provider);
    }
    return undefined;
  }
  if (isConnectionError(err)) return providerUnreachable(provider);
  return undefined;
}

/** "Anthropic (Claude)" -> "Anthropic"; the bare names for the generic presets. */
export function shortProviderLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const short = label.replace(/\s*\(.*\)\s*$/, "").trim();
  if (/^other$/i.test(short)) return undefined;
  if (/proxy/i.test(short)) return "proxy";
  return short;
}
