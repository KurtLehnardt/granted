import type { NextRequest } from "next/server";
import { handleTestKeyPost } from "./handler";
import { withErrorLogging } from "@/lib/errorLog/withErrorLogging";

export const POST = withErrorLogging("llm-provider", async (req: NextRequest) => handleTestKeyPost(req));
