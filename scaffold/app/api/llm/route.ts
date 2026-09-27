import { NextResponse } from "next/server";
import { isLocalLlm } from "@/lib/llm/client";
import { listOllamaChatModels } from "@/lib/llm/ollamaInfo";

/**
 * GET /api/llm — backend info for Settings' local-only model picker. Hosted
 * (Anthropic): `{ local: false }`, no Ollama call. Local: the active default
 * model plus the installed chat models (embedding models excluded) so the
 * dropdown only ever offers something actually runnable.
 */
export async function GET() {
  if (!isLocalLlm()) return NextResponse.json({ local: false });
  const models = await listOllamaChatModels();
  const model = process.env.LOCAL_LLM_MODEL || "gemma4:latest";
  return NextResponse.json({ local: true, model, models });
}
