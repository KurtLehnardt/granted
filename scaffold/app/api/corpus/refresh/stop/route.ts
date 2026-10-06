import type { NextRequest } from "next/server";
import { handleRefreshStopPost } from "./handler";
import { withErrorLogging } from "@/lib/errorLog/withErrorLogging";

export const POST = withErrorLogging("corpus-refresh", async (req: NextRequest) => handleRefreshStopPost(req));
