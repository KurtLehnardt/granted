import type { NextRequest } from "next/server";
import { handleModelsPost } from "./handler";

export async function POST(req: NextRequest) {
  return handleModelsPost(req);
}
