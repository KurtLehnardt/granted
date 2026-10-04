import type { NextRequest } from "next/server";
import { handleUpdatesGet } from "./handler";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handleUpdatesGet(req);
}
