/**
 * Wraps an API route handler so no failure gets lost: a thrown error is
 * logged and answered with a plain 500 that carries its correlation id, and a
 * 5xx JSON answer the handler chose itself is logged and gets an `errorId`
 * added (unless it already has one). Anything else passes through untouched.
 *
 *   export const POST = withErrorLogging("match", (req: NextRequest) => handleMatchRequest(req));
 */
import { NextResponse } from "next/server";
import { logError, type LogErrorOptions } from "./server";

type Log = (area: string, err: unknown, opts?: LogErrorOptions) => string;

function pathOf(req: unknown): string | undefined {
  try {
    const url = (req as { url?: unknown } | undefined)?.url;
    return typeof url === "string" ? new URL(url, "http://localhost").pathname : undefined;
  } catch {
    return undefined;
  }
}

async function withIdOnFailure(area: string, res: Response, path: string | undefined, log: Log): Promise<Response> {
  if (res.status < 500) return res;
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
    log(area, `HTTP ${res.status}`, { status: res.status, path, stack: null });
    return res;
  }
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    log(area, `HTTP ${res.status}`, { status: res.status, path, stack: null });
    return res;
  }
  const obj = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (obj && typeof obj["errorId"] === "string") return res; // already logged by the handler
  const message = typeof obj?.["error"] === "string" ? (obj["error"] as string) : `HTTP ${res.status}`;
  const errorId = log(area, message, { status: res.status, path, stack: null });
  if (!obj) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return NextResponse.json({ ...obj, errorId }, { status: res.status, headers });
}

export function withErrorLogging<A extends unknown[]>(
  area: string,
  handler: (...args: A) => Response | Promise<Response>,
  log: Log = logError,
): (...args: A) => Promise<Response> {
  return async (...args: A): Promise<Response> => {
    const path = pathOf(args[0]);
    let res: Response;
    try {
      res = await handler(...args);
    } catch (err) {
      const errorId = log(area, err, { status: 500, path });
      console.error(`${area} failed [${errorId}]:`, err);
      return NextResponse.json({ error: "Something went wrong inside Granted. Please try again.", errorId }, { status: 500 });
    }
    try {
      return await withIdOnFailure(area, res, path, log);
    } catch {
      return res; // the handler's own answer, whatever happened while logging it
    }
  };
}
