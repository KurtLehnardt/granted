import type { AssembledPackage } from "./package";

/**
 * WS-G / T7 — client-side signed export of the ALREADY-ASSEMBLED `AssembledPackage`
 * into the `.granted.json` envelope the browser autofill extension imports.
 *
 * This module is the APP side of the handoff; the extension's importer
 * (`extension/src/lib/envelope.ts`) implements the
 * IDENTICAL canonical-JSON + SHA-256 algorithm so the two sides agree
 * byte-for-byte on the digest without ever sharing code across the two npm
 * packages.
 *
 * Nothing here calls the network, a server route, or any storage. It is a PURE
 * re-serialization of data already rendered on the package screen — no new
 * fetch, no server retention (northstar §5.3). `sha256Hex` uses the standard
 * Web Crypto `crypto.subtle.digest`, which is available both in the browser
 * and under this repo's Node-based `tsx --test` runner (Node's global
 * `crypto.subtle`) — so the SAME function runs unit-tested here and shipped in
 * the browser, with no separate "Node-safe" branch to keep in sync.
 */

// ---------------------------------------------------------------------------
// Canonical JSON (spec §6.3 — MUST match the extension's importer byte-for-byte)
// ---------------------------------------------------------------------------

/**
 * Deterministic ("canonical") JSON serialization: object keys sorted ascending
 * by JS default string sort, no whitespace, arrays kept in their original
 * order. This is the ONE serialization both the app (export) and the
 * extension (import, re-verify) run over `payload` to compute the integrity
 * digest — any divergence between the two implementations would make every
 * exported package fail import verification, so this function's shape is a
 * frozen cross-package contract, not an implementation detail.
 *
 *   - object   -> `{` + each `JSON.stringify(key)+":"+canonicalize(value)`,
 *                 keys sorted ascending, joined by `,`, no spaces + `}`.
 *                 A key whose value is `undefined` is DROPPED (mirrors
 *                 `JSON.stringify`'s own default object behavior), so an
 *                 optional field that's absent canonicalizes identically to
 *                 one that was never set.
 *   - array    -> `[` + elements canonicalized IN ORDER, joined by `,` + `]`.
 *   - primitive -> `JSON.stringify(value)` (handles strings, numbers,
 *                 booleans, null verbatim).
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // Primitive (string | number | boolean | null) or a function/symbol that
    // JSON.stringify itself would reject/drop — deferred to JSON.stringify's
    // own behavior rather than reimplemented here.
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return "[" + value.map((el) => canonicalize(el)).join(",") + "]";
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) continue; // dropped, matching JSON.stringify's object semantics
    parts.push(JSON.stringify(key) + ":" + canonicalize(v));
  }
  return "{" + parts.join(",") + "}";
}

// ---------------------------------------------------------------------------
// SHA-256 digest (Web Crypto — browser AND Node's global `crypto.subtle`)
// ---------------------------------------------------------------------------

/** Lowercase-hex SHA-256 of the UTF-8 bytes of `canonicalJson`. */
export async function sha256Hex(canonicalJson: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// The export envelope (spec §6.3 — MUST match the extension's `GrantedExportEnvelope`)
// ---------------------------------------------------------------------------

/**
 * The signed export envelope handed to the extension as `.granted.json`.
 * `signature` is deliberately OMITTED here: under the current pure-client,
 * no-server-signing-key constraint there is no private key to sign with, so
 * this app never emits one. The field stays reserved on the type only so a
 * future signing phase can add it without a format change; this builder never
 * populates it. `digest` is tamper-EVIDENT (catches corruption/edits), not
 * cryptographic proof of origin — see spec §6.2's honest limitation.
 */
export interface GrantedExportEnvelope {
  format: "granted.autofill.package";
  version: 1;
  generated_at: string;
  opportunity_id: string;
  program_title: string;
  /** Canonical-JSON SHA-256 of `payload`, lowercase hex. Integrity / tamper-evidence. */
  digest: { alg: "SHA-256"; value: string };
  /** The WS-G / G5 AssembledPackage, re-validated by the extension on import. */
  payload: AssembledPackage;
}

/**
 * Build the export envelope from an already-assembled package. Pure aside
 * from the digest's `crypto.subtle` call and reading the current clock for
 * `generated_at` — no network, no server call, nothing retained.
 */
export async function buildEnvelope(pkg: AssembledPackage): Promise<GrantedExportEnvelope> {
  const digestValue = await sha256Hex(canonicalize(pkg));
  return {
    format: "granted.autofill.package",
    version: 1,
    generated_at: new Date().toISOString(),
    opportunity_id: pkg.opportunity_id,
    program_title: pkg.program_title,
    digest: { alg: "SHA-256", value: digestValue },
    payload: pkg,
  };
}

/** A safe `.granted.json` file name derived from the package's opportunity id. */
export function exportFileName(pkg: AssembledPackage): string {
  const safeId = pkg.opportunity_id.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safeId || "granted-package"}.granted.json`;
}

// ---------------------------------------------------------------------------
// Honest hand-off copy for the export affordance (mirrors AOR_HANDOFF / PACKAGE_INTRO)
// ---------------------------------------------------------------------------

/**
 * The honest copy shown next to the export button, mirroring the register of
 * `AOR_HANDOFF`/`PACKAGE_INTRO` in `./package.ts`. Exported so tests can
 * assert the honesty invariants directly against the source of truth.
 */
export const EXTENSION_EXPORT_COPY = {
  eyebrow: "Optional · browser autofill extension",
  headline: "Export for the browser autofill extension",
  body:
    "Download this exact draft as a .granted.json file to import into the Granted browser " +
    "extension. The extension fills the visible fields of the official grant portal's form in " +
    "your OWN authenticated session and stops before any submit or signature control; the file " +
    "only ever leaves this device when you choose to move it. You, or your organization's " +
    "Authorized Organization Representative (AOR), still review the filled-in form and submit it " +
    "yourselves, through the program's official portal.",
  downloadCta: "Download .granted.json",
  copyCta: "Copy to clipboard",
} as const;
