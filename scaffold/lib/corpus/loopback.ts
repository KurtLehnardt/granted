/** True for 127.0.0.0/8, ::1, and IPv4-mapped-IPv6 loopback addresses. */
export function isLoopbackIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  return v === "::1" || v === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(v) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(v);
}

/**
 * Best-effort loopback check for a request. Reads the same proxy headers as
 * `lib/security/rateLimit.ts`'s `clientKey`. With NO proxy/IP info at all —
 * the normal shape of a direct local request in this self-hosted, no-Vercel
 * app — it's treated as loopback; a real reverse proxy in front of this app
 * is expected to set one of these headers.
 */
export function isLoopbackRequest(req: { headers: { get(name: string): string | null }; ip?: string }): boolean {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    return !!first && isLoopbackIp(first);
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return isLoopbackIp(xri.trim());
  if (req.ip) return isLoopbackIp(req.ip);
  return true;
}
