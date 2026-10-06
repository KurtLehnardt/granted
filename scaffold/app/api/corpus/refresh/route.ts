import type { NextRequest } from "next/server";
import { handleRefreshPost } from "./handler";
import { withErrorLogging } from "@/lib/errorLog/withErrorLogging";

export const POST = withErrorLogging("corpus-refresh", async (req: NextRequest) => handleRefreshPost(req));
