import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import {
  appVersion,
  installInfo,
  readUpdateSettings,
  readUpdateStatus,
  startUpdater,
  writeUpdateSettings,
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
  /** The last update's outcome (update.ps1), if any. */
  status: UpdateStatus | null;
  releasesPage: string;
}

export type UpdateDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  appVersion: () => string;
  installInfo: () => ReturnType<typeof installInfo>;
  readUpdateSettings: typeof readUpdateSettings;
  writeUpdateSettings: (changes: Parameters<typeof writeUpdateSettings>[0]) => void;
  readUpdateStatus: () => UpdateStatus | null;
  fetchLatest: () => Promise<LatestRelease>;
  startUpdater: (ref: string, port: number) => void;
  now: () => number;
  port: () => number;
};

const REAL_DEPS: UpdateDeps = {
  isLoopbackRequest,
  appVersion: () => appVersion(),
  installInfo: () => installInfo(),
  readUpdateSettings: () => readUpdateSettings(),
  writeUpdateSettings: (changes) => writeUpdateSettings(changes),
  readUpdateStatus: () => readUpdateStatus(),
  fetchLatest: () => fetchLatestRelease(process.env["GRANTED_RELEASES_API"] || LATEST_RELEASE_API),
  startUpdater: (ref, port) => startUpdater(ref, port),
  now: () => Date.now(),
  port: () => Number(process.env["PORT"]) || 3000,
};

// One cached successful check per server run (see CHECK_CACHE_MS).
let cachedLatest: { result: LatestRelease; at: number } | null = null;
export function resetUpdateCacheForTests(): void {
  cachedLatest = null;
}

async function latestRelease(d: UpdateDeps, force: boolean): Promise<LatestRelease> {
  if (!force && cachedLatest && !cachedLatest.result.failed && d.now() - cachedLatest.at < CHECK_CACHE_MS) {
    return cachedLatest.result;
  }
  const result = await d.fetchLatest();
  cachedLatest = { result, at: d.now() };
  return result;
}

function isRunning(status: UpdateStatus | null, now: number): boolean {
  if (status?.state !== "running") return false;
  const at = status.at ? Date.parse(status.at) : NaN;
  return Number.isNaN(at) || now - at < RUNNING_STALE_MS;
}

/** Whether an automatic check is due now (pure: the auto-update decision). */
export function autoCheckDue(opts: { autoUpdate: boolean; canUpdate: boolean; lastAutoCheck: number | null; now: number }): boolean {
  if (!opts.autoUpdate || !opts.canUpdate) return false;
  return opts.lastAutoCheck === null || opts.now - opts.lastAutoCheck >= AUTO_CHECK_INTERVAL_MS;
}

async function info(d: UpdateDeps, check: boolean, force: boolean): Promise<AppUpdateInfo> {
  const version = d.appVersion();
  const install = d.installInfo();
  const latest = check ? await latestRelease(d, force) : { tag: null, failed: false };
  return {
    version,
    latest: latest.tag,
    updateAvailable: isNewerRelease(latest.tag, versionToTag(version)),
    checkFailed: latest.failed,
    canUpdate: install.canUpdate,
    reason: install.reason,
    autoUpdate: install.canUpdate && d.readUpdateSettings().autoUpdate,
    status: d.readUpdateStatus(),
    releasesPage: RELEASES_PAGE,
  };
}

/**
 * GET /api/app/update — this install's version, whether it can update
 * itself, and (with ?check=1, or ?check=force to skip the short cache) the
 * newest release on GitHub. ?check=0 never contacts GitHub (the page polling
 * for the restart after an update).
 */
export async function handleUpdateGet(
  req: { headers: { get(name: string): string | null }; url: string },
  deps: Partial<UpdateDeps> = {},
) {
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
 */
export async function handleUpdatePost(
  req: { headers: { get(name: string): string | null }; json?: () => Promise<unknown> },
  deps: Partial<UpdateDeps> = {},
) {
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
  if (!install.canUpdate) return NextResponse.json({ error: "This copy of Granted can't update itself", started: false }, { status: 409 });
  if (isRunning(d.readUpdateStatus(), d.now())) {
    return NextResponse.json({ error: "An update is already running", started: false }, { status: 409 });
  }

  if (body.action === "auto") {
    const settings = d.readUpdateSettings();
    if (!autoCheckDue({ autoUpdate: settings.autoUpdate, canUpdate: true, lastAutoCheck: settings.lastAutoCheck, now: d.now() })) {
      return NextResponse.json({ started: false });
    }
    d.writeUpdateSettings({ lastAutoCheck: d.now() });
  }

  const version = d.appVersion();
  const latest = await latestRelease(d, body.action === "install");
  if (latest.failed) return NextResponse.json({ error: "Couldn't check for updates — try again later", started: false }, { status: 502 });
  if (!latest.tag || !isNewerRelease(latest.tag, versionToTag(version))) {
    return NextResponse.json({ started: false, upToDate: true, version });
  }
  d.startUpdater(latest.tag, d.port());
  return NextResponse.json({ started: true, from: version, to: latest.tag }, { status: 202 });
}
