import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { logError } from "@/lib/errorLog/server";
import {
  appVersion,
  installInfo,
  readUpdateSettings,
  readUpdateStatus,
  startUpdater,
  writeUpdateSettings,
  writeUpdateStatus,
  type CannotUpdateReason,
  type UpdateStatus,
} from "@/lib/appUpdate/install";
import {
  fetchLatestRelease,
  isNewerRelease,
  LATEST_RELEASE_API,
  RELEASES_PAGE,
  versionToTag,
  type LatestRelease,
} from "@/lib/appUpdate/releases";

/** How often an automatic check runs at most (each time Granted is opened, but not more often than this). */
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A "running" update older than this is treated as dead (its window was closed, the PC restarted…). */
const RUNNING_STALE_MS = 20 * 60 * 1000;
/** A successful check is reused for this long, so opening Settings doesn't ask GitHub every time. */
const CHECK_CACHE_MS = 10 * 60 * 1000;

export interface AppUpdateInfo {
  version: string;
  latest: string | null;
  updateAvailable: boolean;
  checkFailed: boolean;
  canUpdate: boolean;
  reason: CannotUpdateReason | null;
  autoUpdate: boolean;
  /** The last update's outcome (the updater), if any. */
  status: UpdateStatus | null;
  releasesPage: string;
}

type Req = { headers: { get(name: string): string | null } };

export type UpdateDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  appVersion: () => string;
  installInfo: () => ReturnType<typeof installInfo>;
  readUpdateSettings: typeof readUpdateSettings;
  writeUpdateSettings: (changes: Parameters<typeof writeUpdateSettings>[0]) => void;
  readUpdateStatus: () => UpdateStatus | null;
  writeUpdateStatus: (status: UpdateStatus) => void;
  fetchLatest: () => Promise<LatestRelease>;
  /** `script` is installInfo().script — the updater this install may run. */
  startUpdater: (ref: string, port: number, script: string) => Promise<void>;
  now: () => number;
  /** The port Granted is serving on — where the updater starts it again. */
  port: (req: Req) => number;
};

/**
 * The port this request came in on (the page's own — whatever started the
 * server), else PORT (the tray sets it), else Next's default.
 */
export function requestPort(req: Req, env: Record<string, string | undefined> = process.env): number {
  const host = req.headers.get("host");
  const m = host ? /:(\d+)$/.exec(host) : null;
  const fromHost = m ? Number(m[1]) : NaN;
  if (Number.isInteger(fromHost) && fromHost > 0 && fromHost < 65536) return fromHost;
  return Number(env["PORT"]) || 3000;
}

const REAL_DEPS: UpdateDeps = {
  isLoopbackRequest,
  appVersion: () => appVersion(),
  installInfo: () => installInfo(),
  readUpdateSettings: () => readUpdateSettings(),
  writeUpdateSettings: (changes) => writeUpdateSettings(changes),
  readUpdateStatus: () => readUpdateStatus(),
  writeUpdateStatus: (status) => writeUpdateStatus(status),
  fetchLatest: () => fetchLatestRelease(process.env["GRANTED_RELEASES_API"] || LATEST_RELEASE_API),
  startUpdater: (ref, port, script) => startUpdater(ref, port, script),
  now: () => Date.now(),
  port: (req) => requestPort(req),
};

// One cached successful check per server run (see CHECK_CACHE_MS), and one
// update being started at a time within this server.
let cachedLatest: { result: LatestRelease; at: number } | null = null;
let starting = false;
export function resetUpdateCacheForTests(): void {
  cachedLatest = null;
  starting = false;
}

async function latestRelease(d: UpdateDeps, force: boolean): Promise<LatestRelease> {
  if (!force && cachedLatest && !cachedLatest.result.failed && d.now() - cachedLatest.at < CHECK_CACHE_MS) {
    return cachedLatest.result;
  }
  const result = await d.fetchLatest();
  cachedLatest = { result, at: d.now() };
  return result;
}

/** An update is under way (a missing or garbled timestamp counts as stale, never as forever). */
function isRunning(status: UpdateStatus | null, now: number): boolean {
  if (status?.state !== "running") return false;
  const at = status.at ? Date.parse(status.at) : NaN;
  return !Number.isNaN(at) && now - at < RUNNING_STALE_MS;
}

/** Whether an automatic check is due now (pure: the auto-update decision). */
export function autoCheckDue(opts: { autoUpdate: boolean; canUpdate: boolean; lastAutoCheck: number | null; now: number }): boolean {
  if (!opts.autoUpdate || !opts.canUpdate) return false;
  return opts.lastAutoCheck === null || opts.now - opts.lastAutoCheck >= AUTO_CHECK_INTERVAL_MS;
}

/**
 * An update that failed (the updater wrote "error") goes to the error log —
 * once per failure, however often the page asks.
 */
function logUpdateFailure(status: UpdateStatus | null): void {
  if (status?.state !== "error") return;
  logError("app-update", status.message ?? `The update to ${status.to ?? "a new version"} didn't finish.`, {
    once: `update-status:${status.to ?? ""}:${status.at ?? ""}`,
    stack: null,
  });
}

async function info(d: UpdateDeps, check: boolean, force: boolean): Promise<AppUpdateInfo> {
  const version = d.appVersion();
  const install = d.installInfo();
  const latest = check ? await latestRelease(d, force) : { tag: null, failed: false };
  // Only a check the user asked for: automatic ones fail quietly whenever the computer is offline.
  if (latest.failed && force) logError("app-update", "Couldn't reach GitHub to check for updates.", { stack: null });
  const status = d.readUpdateStatus();
  logUpdateFailure(status);
  return {
    version,
    latest: latest.tag,
    updateAvailable: isNewerRelease(latest.tag, versionToTag(version)),
    checkFailed: latest.failed,
    canUpdate: install.canUpdate,
    reason: install.reason,
    autoUpdate: install.canUpdate && d.readUpdateSettings().autoUpdate,
    status,
    releasesPage: RELEASES_PAGE,
  };
}

/**
 * GET /api/app/update — this install's version, whether it can update
 * itself, and (with ?check=1, or ?check=force to skip the short cache) the
 * newest release on GitHub. ?check=0 never contacts GitHub (the page polling
 * for the restart after an update).
 */
export async function handleUpdateGet(req: Req & { url: string }, deps: Partial<UpdateDeps> = {}) {
  const d = { ...REAL_DEPS, ...deps };
  if (!d.isLoopbackRequest(req)) return NextResponse.json({ error: "Only available from this computer" }, { status: 403 });
  const check = new URL(req.url).searchParams.get("check");
  return NextResponse.json(await info(d, check !== "0", check === "force"));
}

/**
 * POST /api/app/update:
 *   { action: "install" }               update to the newest release now
 *   { action: "settings", autoUpdate }  turn automatic updates on/off
 *   { action: "auto" }                  sent when Granted opens: update now
 *                                       if automatic updates are on, a check
 *                                       is due, and a newer release exists
 * A started update answers 202 { started, from, to, startedAt }: the page
 * waits for that version, ignoring any status older than startedAt.
 */
export async function handleUpdatePost(req: Req & { json?: () => Promise<unknown> }, deps: Partial<UpdateDeps> = {}) {
  const d = { ...REAL_DEPS, ...deps };
  if (!d.isLoopbackRequest(req)) return NextResponse.json({ error: "Only available from this computer" }, { status: 403 });
  const body = ((await req.json?.().catch(() => null)) ?? {}) as { action?: unknown; autoUpdate?: unknown };
  const install = d.installInfo();

  if (body.action === "settings") {
    if (typeof body.autoUpdate !== "boolean") return NextResponse.json({ error: "autoUpdate must be true or false" }, { status: 400 });
    if (!install.canUpdate) return NextResponse.json({ error: "This copy of Granted can't update itself" }, { status: 409 });
    d.writeUpdateSettings({ autoUpdate: body.autoUpdate });
    return NextResponse.json({ autoUpdate: body.autoUpdate });
  }

  if (body.action !== "install" && body.action !== "auto") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  const auto = body.action === "auto";
  // Sent on every page load: quietly nothing, rather than an error, for a
  // copy that can't update itself (a developer checkout, another platform).
  // `script` is what the updater is started from below, so it is required
  // here — the same guard, for the same reason, as the uninstall handler's.
  if (!install.canUpdate || !install.script) {
    return auto
      ? NextResponse.json({ started: false })
      : NextResponse.json({ error: "This copy of Granted can't update itself", started: false }, { status: 409 });
  }
  if (starting || isRunning(d.readUpdateStatus(), d.now())) {
    return auto
      ? NextResponse.json({ started: false })
      : NextResponse.json({ error: "An update is already running", started: false }, { status: 409 });
  }

  if (auto) {
    const settings = d.readUpdateSettings();
    if (!autoCheckDue({ autoUpdate: settings.autoUpdate, canUpdate: true, lastAutoCheck: settings.lastAutoCheck, now: d.now() })) {
      return NextResponse.json({ started: false });
    }
    d.writeUpdateSettings({ lastAutoCheck: d.now() });
  }

  starting = true;
  try {
    const version = d.appVersion();
    const latest = await latestRelease(d, !auto);
    if (latest.failed) {
      return auto
        ? NextResponse.json({ started: false })
        : NextResponse.json(
            { error: "Couldn't check for updates — try again later", started: false, errorId: logError("app-update", "Couldn't reach GitHub to check for updates.", { stack: null }) },
            { status: 502 },
          );
    }
    if (!latest.tag || !isNewerRelease(latest.tag, versionToTag(version))) {
      return NextResponse.json({ started: false, upToDate: true, version });
    }
    // Automatic updates don't retry a release that already failed here — that
    // would stop and restart Granted every few hours for the same error. The
    // button still retries; a newer release is tried again.
    const last = d.readUpdateStatus();
    if (auto && last?.state === "error" && last.to === latest.tag) {
      return NextResponse.json({ started: false, lastFailed: latest.tag });
    }
    // "running" BEFORE launching: the updater takes seconds to start and write
    // it, and a second click (or the automatic check) must not start another.
    const startedAt = new Date(d.now()).toISOString();
    d.writeUpdateStatus({ state: "running", from: version, to: latest.tag, message: null, at: startedAt });
    try {
      await d.startUpdater(latest.tag, d.port(req), install.script);
    } catch (err) {
      const message = `Couldn't start the update: ${err instanceof Error ? err.message : String(err)}`;
      d.writeUpdateStatus({ state: "error", from: version, to: latest.tag, message, at: new Date(d.now()).toISOString() });
      const errorId = logError("app-update", err, { path: "/api/app/update" });
      return NextResponse.json({ error: message, started: false, errorId }, { status: 500 });
    }
    return NextResponse.json({ started: true, from: version, to: latest.tag, startedAt }, { status: 202 });
  } finally {
    starting = false;
  }
}
