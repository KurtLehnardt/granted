import type { NextRequest } from "next/server";
import { handleOllamaActionPost, handleOllamaStatusGet } from "./handler";
import { withErrorLogging } from "@/lib/errorLog/withErrorLogging";

// Never prerendered: Ollama's state is read per request.
export const dynamic = "force-dynamic";
// Spawns the Ollama daemon / installer: Node.js runtime only.
export const runtime = "nodejs";

export const GET = withErrorLogging("ollama", async () => handleOllamaStatusGet());

export const POST = withErrorLogging("ollama", async (req: NextRequest) => handleOllamaActionPost(req));
