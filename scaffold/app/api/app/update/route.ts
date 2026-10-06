import type { NextRequest } from "next/server";
import { handleUpdateGet, handleUpdatePost } from "./handler";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handleUpdateGet(req);
}

export async function POST(req: NextRequest) {
  return handleUpdatePost(req);
}
