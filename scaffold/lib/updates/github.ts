/**
 * lib/updates/github.ts — fetches the latest commit on GitHub's `main` branch
 * for the update-check route (app/api/updates) to compare against the local
 * checkout. Public, unauthenticated GitHub REST endpoint — no token needed,
 * so this works for every clone without any setup.
 */
export type RemoteCommitResult = { sha: string } | { error: string };

const COMMITS_URL = "https://api.github.com/repos/KurtLehnardt/granted/commits/main";

/**
 * Never throws: a non-ok response (403 rate-limit, 404, 5xx), a network
 * failure, a timeout, or a malformed/unexpected body all resolve to
 * `{error}` rather than rejecting — the caller treats a failed check as
 * data, not an HTTP error.
 */
export async function fetchRemoteCommit(fetchImpl: typeof fetch = fetch): Promise<RemoteCommitResult> {
  let res: Response;
  try {
    res = await fetchImpl(COMMITS_URL, {
      headers: { "User-Agent": "granted-update-check", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError") return { error: "Timed out contacting GitHub." };
    return { error: `Couldn't reach GitHub: ${e?.message ?? "network error"}` };
  }

  if (!res.ok) return { error: `GitHub returned ${res.status}` };

  let body: any;
  try {
    body = await res.json();
  } catch {
    return { error: "Unexpected response from GitHub." };
  }

  if (typeof body?.sha !== "string" || !body.sha) return { error: "Unexpected response from GitHub." };
  return { sha: body.sha };
}
