import type { NextRequest } from "next/server";
import { handleLogsGet, handleLogsPost } from "./handler";

export const dynamic = "force-dynamic";

// Not wrapped in withErrorLogging: a failure while logging must not try to log itself.
export async function GET(req: NextRequest) {
  return handleLogsGet(req);
}

export async function POST(req: NextRequest) {
  return handleLogsPost(req);
}
