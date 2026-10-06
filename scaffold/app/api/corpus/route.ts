import { NextResponse } from "next/server";
import { buildCorpusStatus } from "./handler";
import { withErrorLogging } from "@/lib/errorLog/withErrorLogging";

export const dynamic = "force-dynamic";

export const GET = withErrorLogging("corpus", async () => NextResponse.json(buildCorpusStatus()));
