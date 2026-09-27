import { NextResponse } from "next/server";
import { buildCorpusStatus } from "./handler";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(buildCorpusStatus());
}
