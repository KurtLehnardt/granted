/** @type {import('next').NextConfig} */

/**
 * Defense-in-depth security headers (security review LOW). There is no XSS sink
 * today (LLM output is JSON-parsed + React-escaped, no dangerouslySetInnerHTML),
 * but the app renders model-generated strings, so a CSP is a valuable second
 * line, and clickjacking protection matters on the authed surfaces.
 *
 * The CSP is deliberately protective on the axes that don't risk the app
 * (frame-ancestors/object-src/base-uri) while staying permissive where a strict
 * value would break Next.js (inline hydration bootstrap, dev HMR eval), Tailwind
 * (inline styles), Google avatar images, and the Supabase auth XHR. Tighten
 * script-src to a nonce/hash policy in a follow-up if the inline surface is
 * fully enumerated.
 */
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self' https:",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

export default {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
