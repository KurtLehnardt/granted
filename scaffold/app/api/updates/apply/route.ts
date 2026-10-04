import type { NextRequest } from "next/server";
import { handleUpdatesApplyPost } from "./handler";

export async function POST(req: NextRequest) {
  return handleUpdatesApplyPost(req);
}
