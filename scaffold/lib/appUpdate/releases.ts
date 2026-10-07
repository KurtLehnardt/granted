/**
 * Granted's releases on GitHub, and comparing versions. The same rules as
 * the installer's (installer/src/main/ipcPure.ts): only a published, stable
 * vMAJOR.MINOR.PATCH release counts, and "newer" is numeric.
 */

export const LATEST_RELEASE_API = "https://api.github.com/repos/KurtLehnardt/granted/releases/latest";
export const RELEASES_PAGE = "https://github.com/KurtLehnardt/granted/releases/latest";

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function parseReleaseTag(tag: string | null | undefined): [number, number, number] | null {
  const m = RELEASE_TAG.exec(tag ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** "1.2.3" (package.json) -> "v1.2.3"; anything else -> null. */
export function versionToTag(version: string): string | null {
  const tag = `v${version}`;
  return parseReleaseTag(tag) ? tag : null;
}

/** Whether release tag `a` is newer than `b` (false if either isn't a release tag). */
export function isNewerRelease(a: string | null, b: string | null): boolean {
  const pa = parseReleaseTag(a);
  const pb = parseReleaseTag(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

/** GitHub's latest-release response -> its tag, if a published stable release. */
export function parseLatestRelease(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const r = body as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
  if (r.draft === true || r.prerelease === true || typeof r.tag_name !== "string") return null;
  return parseReleaseTag(r.tag_name) ? r.tag_name : null;
}

export interface LatestRelease {
  tag: string | null;
  /** GitHub couldn't be asked (offline, rate-limited, …). */
  failed: boolean;
}

/** The newest published release. 404 = no releases yet (not a failure). */
export async function fetchLatestRelease(
  url: string,
  timeoutMs = 8000,
  fetchImpl: typeof fetch = fetch,
): Promise<LatestRelease> {
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "granted-app" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (res.status === 404) return { tag: null, failed: false };
    if (!res.ok) return { tag: null, failed: true };
    return { tag: parseLatestRelease(await res.json()), failed: false };
  } catch {
    return { tag: null, failed: true };
  }
}
