/** True for 127.0.0.0/8, ::1, and IPv4-mapped-IPv6 loopback addresses. */
export function isLoopbackIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  return v === "::1" || v === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(v) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(v);
}

/**
 * Loopback check for a request that triggers a real network refresh —
 * unlike `lib/security/rateLimit.ts`'s best-effort `clientKey`, this guards
 * an action worth spoofing, so it deliberately does NOT trust client-set
 * X-Forwarded-For / X-Real-IP: `next dev`/`next start` bind all interfaces
 * by default and, with no reverse proxy in front (this app is self-hosted,
 * no Vercel), Next.js only fills those headers from the real socket when the
 * client didn't already send one (`??=`) — a raw request from another host
 * on the LAN can set either to claim `127.0.0.1` and sail through.
 *
 * Instead this trusts only signals a page's own script cannot forge:
 *  - `Sec-Fetch-Site`, which the browser itself attaches to every
 *    fetch/XHR and a page cannot override — anything the browser marked as
 *    cross-site (another origin's tab POSTing here) is rejected outright.
 *  - `Origin`, checked against `Host` when both are present.
 *  - `req.ip`, when the platform (not client headers) supplies it.
 * A request with none of these — no Sec-Fetch-Site, no Origin/Host mismatch
 * signal, no platform IP — has no trustworthy evidence of origin at all, and
 * is now denied rather than assumed local. The only real caller,
 * SettingsForm's same-origin `fetch("/api/corpus/refresh")`, always carries
 * `Sec-Fetch-Site: same-origin`.
 */
export function isLoopbackRequest(req: { headers: { get(name: string): string | null }; ip?: string }): boolean {
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") return false;

  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  let originMatchesHost = false;
  if (origin && host) {
    try {
      originMatchesHost = new URL(origin).host === host;
    } catch {
      return false;
    }
    if (!originMatchesHost) return false;
  }

  if (req.ip) return isLoopbackIp(req.ip);
  return secFetchSite === "same-origin" || originMatchesHost;
}
