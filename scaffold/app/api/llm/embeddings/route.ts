import type { NextRequest } from "next/server";
import { handleSearchModelDownloadPost, handleSearchStatusGet } from "./handler";
import { withErrorLogging } from "@/lib/errorLog/withErrorLogging";

// Never prerendered: status is read per request.
export const dynamic = "force-dynamic";
// The built-in model runs on onnxruntime-node, which needs the Node.js runtime.
export const runtime = "nodejs";

export const GET = withErrorLogging("builtin-model", async () => handleSearchStatusGet());

export const POST = withErrorLogging("builtin-model", async (req: NextRequest) => handleSearchModelDownloadPost(req));
