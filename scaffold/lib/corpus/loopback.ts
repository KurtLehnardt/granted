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
 * Next fills X-Forwarded-For from the socket unless the client sent one. Browsers can't forge these
 * headers, which stops LAN pages, cross-site pages and DNS rebinding; a raw client can, so bind the
 * server to 127.0.0.1 on an untrusted network.
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
