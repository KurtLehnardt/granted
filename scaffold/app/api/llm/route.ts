import { NextResponse } from "next/server";
import { isLocalLlm, defaultLocalModel } from "@/lib/llm/client";
import { listOllamaChatModels } from "@/lib/llm/ollamaInfo";

// Must be evaluated per-request, not baked into the build: this reflects
// whichever backend/Ollama models are live when the server is running, not
// whatever was true when `next build` ran (Next 14 otherwise statically
// prerenders a no-argument GET handler with no segment config).
export const dynamic = "force-dynamic";

/**
 * GET /api/llm — backend info for Settings' local-only model picker. Hosted
 * (Anthropic): `{ local: false }`, no Ollama call. Local: the active default
 * model plus the installed chat models (embedding models excluded) so the
 * dropdown only ever offers something actually runnable.
 */
export async function GET() {
  if (!isLocalLlm()) return NextResponse.json({ local: false });
  const models = await listOllamaChatModels();
  return NextResponse.json({ local: true, model: defaultLocalModel(), models });
}
