import type { NextRequest } from "next/server";
import { handleLocalEmbeddingsGet, handleLocalEmbeddingsPost } from "./handler";

// Never prerendered: status is read from disk per request.
export const dynamic = "force-dynamic";

export async function GET() {
  return handleLocalEmbeddingsGet();
}

export async function POST(req: NextRequest) {
  return handleLocalEmbeddingsPost(req);
}
