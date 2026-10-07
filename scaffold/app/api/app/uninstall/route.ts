import type { NextRequest } from "next/server";
import { handleUninstallGet, handleUninstallPost } from "./handler";
import { withErrorLogging } from "@/lib/errorLog/withErrorLogging";

export const dynamic = "force-dynamic";

export const GET = withErrorLogging("app-uninstall", async (req: NextRequest) => handleUninstallGet(req));

export const POST = withErrorLogging("app-uninstall", async (req: NextRequest) => handleUninstallPost(req));
