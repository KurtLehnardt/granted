/** @type {import('next').NextConfig} */

/**
 * Defense-in-depth security headers (security review LOW). Model output is
 * JSON-parsed and React-escaped, and the app's single dangerouslySetInnerHTML
 * is app/welcome/page.tsx's JSON-LD block — a JSON.stringify of a constant
 * object, with no user or model input anywhere near it. So there is no known
 * XSS sink, but the app does render model-generated strings, which makes a CSP
 * a valuable second line, and clickjacking protection matters on the authed
 * surfaces.
 *
 * The CSP is protective on the axes that don't risk the app
 * (frame-ancestors/object-src/base-uri) and stays permissive only where a
 * strict value would break Next.js (its inline hydration bootstrap) or
 * Tailwind (inline styles). Two deliberate choices beyond that:
 *
 *   * 'unsafe-eval' is added to script-src ONLY in development mode
 *     (NODE_ENV === "development") so that Next.js's HMR, error overlay,
 *     and React hydration work correctly during local development. In
 *     production builds (npm run build + npm run start), the directive is
 *     absent and end users receive the stricter policy.
 *
 *     One thing in the production bundle does touch `new Function`, and it
 *     was measured in a real Chromium against this policy rather than
 *     assumed: Zod 4 probes for eval with `new F("")` (util.ts's
 *     `allowsEval`) to decide whether to JIT-compile object validators. The
 *     probe is inside a try/catch, so the block is swallowed and
 *     `$ZodObjectJIT` falls back to its ordinary parse path — nothing
 *     breaks, nothing is logged to the console (verified: the full e2e
 *     journey suite passes against a production build under this exact
 *     policy), and the only cost is the fast path on client-side contract
 *     parsing, which is microseconds next to the model call that produced
 *     the data. It does file one `securitypolicyviolation` report per page
 *     load; `z.config({ jitless: true })` before the first schema is built
 *     is how to silence that if a report-uri is ever added.
 *   * connect-src is 'self' only. Every fetch in app/ and components/ goes to
 *     this app's own /api/* routes (checked across both trees). The calls that
 *     do leave the machine — Anthropic, OpenAI, Ollama, Exa — are made by
 *     those route handlers on the server, where CSP doesn't apply. The old
 *     `https:` here was for a Supabase auth XHR, and Supabase has since been
 *     removed from the codebase entirely.
 *
 * img-src still allows https: for remote avatar images. Tighten script-src to
 * a nonce/hash policy in a follow-up if the inline surface is fully enumerated.
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
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "connect-src 'self'",
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
  experimental: {
    // The built-in search model (lib/embeddings/builtin.ts) runs on onnxruntime-node, a native
    // addon: Next.js 14 must load these from node_modules at runtime rather than bundle them.
    serverComponentsExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "onnxruntime-common", "sharp"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
