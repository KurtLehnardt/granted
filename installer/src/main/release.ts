/**
 * Which release of Granted this installer installs, and checking GitHub for
 * a newer one. Free of any `electron` import (like ipcPure.ts and
 * openGranted.ts) so it's tested directly under plain Node.
 */
import type { InstallVersionPlan } from "../shared/ipc";
import { chooseInstallRef, parseLatestRelease, parseReleaseTag } from "./ipcPure";

// Baked in at build time from GRANTED_RELEASE_TAG (electron.vite.config.ts):
// the release workflow sets it to the tag being released. Empty in a
// development build, which installs main.
declare const __GRANTED_RELEASE_TAG__: string | undefined;

export const LATEST_RELEASE_API = "https://api.github.com/repos/KurtLehnardt/granted/releases/latest";

/** The release this installer was built for, or null (a development build). GRANTED_RELEASE_TAG overrides it (tests). */
export function pinnedReleaseTag(env: Record<string, string | undefined> = process.env): string | null {
  const baked = typeof __GRANTED_RELEASE_TAG__ === "string" ? __GRANTED_RELEASE_TAG__ : "";
  const tag = env["GRANTED_RELEASE_TAG"] || baked;
  return parseReleaseTag(tag) ? tag : null;
}

/** The newest published release's tag; `failed` if GitHub couldn't be asked (offline, rate-limited, …). */
export async function fetchLatestReleaseTag(url: string, timeoutMs: number): Promise<{ tag: string | null; failed: boolean }> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "granted-installer" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 404: no releases at all yet -- nothing newer, and not a failure.
    if (res.status === 404) return { tag: null, failed: false };
    if (!res.ok) return { tag: null, failed: true };
    return { tag: parseLatestRelease(await res.json()), failed: false };
  } catch {
    return { tag: null, failed: true };
  }
}

export interface VersionPlanner {
  /**
   * For the screen: decides which Granted to install, asking GitHub when
   * needed — at most once per run once that succeeds (the screen re-plans as
   * the box is ticked and unticked); a failed check is retried next time.
   */
  plan: (checkForUpdates: boolean) => Promise<InstallVersionPlan>;
  /**
   * For the install itself: the same decision from what the screen last
   * learned, never asking GitHub again — so what's installed is what the
   * screen said would be (a retry succeeding in between must not swap a
   * different release in after the user read the note).
   */
  current: (checkForUpdates: boolean) => InstallVersionPlan;
}

export function createVersionPlanner(opts: { pinned: string | null; latestUrl: string; timeoutMs?: number }): VersionPlanner {
  let latest: { tag: string | null; failed: boolean } | null = null;
  const decide = (checkForUpdates: boolean): InstallVersionPlan =>
    chooseInstallRef({
      pinned: opts.pinned,
      checkForUpdates,
      latest: checkForUpdates ? (latest?.tag ?? null) : null,
      // Never asked (the screen hadn't planned yet): treated as a failed check.
      checkFailed: checkForUpdates && (latest === null || latest.failed),
    });
  return {
    plan: async (checkForUpdates) => {
      if (opts.pinned && checkForUpdates && (!latest || latest.failed)) {
        latest = await fetchLatestReleaseTag(opts.latestUrl, opts.timeoutMs ?? 8000);
      }
      return decide(checkForUpdates);
    },
    current: decide,
  };
}
