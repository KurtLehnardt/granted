/** True for 127.0.0.0/8, ::1, and IPv4-mapped-IPv6 loopback addresses. */
export function isLoopbackIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  return v === "::1" || v === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(v) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(v);
}

function firstForwardedHop(xff: string | null): string | null {
  const first = xff?.split(",")[0]?.trim();
  return first || null;
}

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/**
 * Loopback check for a request that triggers a real network refresh. This
 * app is self-hosted with no reverse proxy in front (no Vercel), and `next
 * dev`/`next start` bind all interfaces by default, so none of these signals
 * are individually unforgeable — a raw (non-browser) client can set
 * X-Forwarded-For, Host, Origin and Sec-Fetch-Site to whatever it likes. All
 * three checks below have to agree before a request is treated as local:
 *
 *  - X-Forwarded-For's first hop is a loopback address. On this Next.js
 *    version `req.ip` is never populated (NextRequestAdapter leaves it
 *    unset), and Next only fills X-Forwarded-For from the real socket when
 *    the client didn't already send one — a real LAN client that doesn't
 *    forge this header lands here with its true address.
 *  - Host's hostname is localhost, 127.x, or [::1] — defeats DNS rebinding
 *    (a page served from evil.example can't make the browser send a Host
 *    other than evil.example) and plain LAN-IP access.
 *  - Sec-Fetch-Site is same-origin/none (set by the browser itself and not
 *    script-overridable), or Origin matches Host.
 *
 * This still does not stop a non-browser client that forges all of
 * X-Forwarded-For, Host and Origin/Sec-Fetch-Site at once — only a browser's
 * own same-origin fetch is protected against forgery on the last check. The
 * residual risk is a deliberate attacker with raw network access to this
 * process; binding `next dev`/`next start` to 127.0.0.1 closes it entirely.
 */
export function isLoopbackRequest(req: { headers: { get(name: string): string | null } }): boolean {
  const hop = firstForwardedHop(req.headers.get("x-forwarded-for"));
  if (!hop || !isLoopbackIp(hop)) return false;

  const host = req.headers.get("host");
  if (!isLoopbackHost(host)) return false;

  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite === "same-origin" || secFetchSite === "none") return true;

  const origin = req.headers.get("origin");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
