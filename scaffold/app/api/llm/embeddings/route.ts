import type { NextRequest } from "next/server";
import { handleSearchModelDownloadPost, handleSearchStatusGet } from "./handler";

// Never prerendered: status is read per request.
export const dynamic = "force-dynamic";
// The built-in model runs on onnxruntime-node, which needs the Node.js runtime.
export const runtime = "nodejs";

export async function GET() {
  return handleSearchStatusGet();
}

export async function POST(req: NextRequest) {
  return handleSearchModelDownloadPost(req);
}
