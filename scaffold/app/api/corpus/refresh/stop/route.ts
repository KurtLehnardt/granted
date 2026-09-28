import type { NextRequest } from "next/server";
import { handleRefreshStopPost } from "./handler";

export async function POST(req: NextRequest) {
  return handleRefreshStopPost(req);
}
