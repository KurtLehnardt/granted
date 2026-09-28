import type { NextRequest } from "next/server";
import { handleTestKeyPost } from "./handler";

export async function POST(req: NextRequest) {
  return handleTestKeyPost(req);
}
