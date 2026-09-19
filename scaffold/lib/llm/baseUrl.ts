/**
 * Normalize an OpenAI-compatible base URL.
 *
 * Ollama, LM Studio, vLLM, and OpenAI itself all serve the OpenAI-compatible API
 * under a `/v1` path (`…/v1/chat/completions`, `…/v1/embeddings`). A very common
 * self-host mistake is pointing LLM_BASE_URL / EMBEDDINGS_BASE_URL at the bare
 * host — e.g. `http://localhost:11434` — which then 404s because the real
 * endpoint is `http://localhost:11434/v1/chat/completions`.
 *
 * This strips trailing slashes and, when the URL has NO path (a bare host, or
 * just "/"), appends "/v1". A URL that already carries a path (`…/v1`, or a
 * custom proxy path) is left untouched, and an unparseable value is returned
 * as-is so the caller's fetch surfaces a clear error.
 */
export function normalizeOpenAiBaseUrl(url: string | undefined): string {
  const trimmed = (url ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.pathname === "" || u.pathname === "/") return `${trimmed}/v1`;
  } catch {
    // Not a parseable absolute URL — leave it for the caller/fetch to report.
  }
  return trimmed;
}
