import { NextResponse } from "next/server";
import { isLocalLlm, defaultLocalModel } from "@/lib/llm/client";
import { listOllamaChatModels } from "@/lib/llm/ollamaInfo";

// Next 14 would otherwise prerender this at build time, freezing the backend/model list.
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isLocalLlm()) return NextResponse.json({ local: false });
  return NextResponse.json({ local: true, model: defaultLocalModel(), models: await listOllamaChatModels() });
}
