import { NextRequest } from "next/server";
import { handleMatchRequest } from "./handler";
import { withErrorLogging } from "@/lib/errorLog/withErrorLogging";

// Novel input streams, so bytes flow the whole time rather than arriving as a
// single blocking response. Granted runs locally with no platform execution
// ceiling, so a slow local-model search is free to take as long as it needs.

export const POST = withErrorLogging("search", async (req: NextRequest) => handleMatchRequest(req));
