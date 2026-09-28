import type { NextRequest } from "next/server";
import { handleLlmConfigPost } from "./handler";

export async function POST(req: NextRequest) {
  return handleLlmConfigPost(req);
}
