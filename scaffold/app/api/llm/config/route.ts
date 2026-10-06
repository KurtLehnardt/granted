import type { NextRequest } from "next/server";
import { handleLlmConfigPost } from "./handler";
import { withErrorLogging } from "@/lib/errorLog/withErrorLogging";

export const POST = withErrorLogging("llm-config", async (req: NextRequest) => handleLlmConfigPost(req));
