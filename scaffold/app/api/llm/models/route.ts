import type { NextRequest } from "next/server";
import { handleModelsPost } from "./handler";
import { withErrorLogging } from "@/lib/errorLog/withErrorLogging";

export const POST = withErrorLogging("llm-provider", async (req: NextRequest) => handleModelsPost(req));
