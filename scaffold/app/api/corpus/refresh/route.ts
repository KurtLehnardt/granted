import type { NextRequest } from "next/server";
import { handleRefreshPost } from "./handler";

export async function POST(req: NextRequest) {
  return handleRefreshPost(req);
}
