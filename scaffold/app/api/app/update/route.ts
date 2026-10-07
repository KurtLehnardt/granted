import type { NextRequest } from "next/server";
import { handleUpdateGet, handleUpdatePost } from "./handler";
import { withErrorLogging } from "@/lib/errorLog/withErrorLogging";

export const dynamic = "force-dynamic";

export const GET = withErrorLogging("app-update", async (req: NextRequest) => handleUpdateGet(req));

export const POST = withErrorLogging("app-update", async (req: NextRequest) => handleUpdatePost(req));
