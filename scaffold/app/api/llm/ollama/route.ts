import type { NextRequest } from "next/server";
import { handleOllamaActionPost, handleOllamaStatusGet } from "./handler";

// Never prerendered: Ollama's state is read per request.
export const dynamic = "force-dynamic";
// Spawns the Ollama daemon / installer: Node.js runtime only.
export const runtime = "nodejs";

export async function GET() {
  return handleOllamaStatusGet();
}

export async function POST(req: NextRequest) {
  return handleOllamaActionPost(req);
}
