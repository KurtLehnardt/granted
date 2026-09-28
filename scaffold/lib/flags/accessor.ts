import { FLAG_REGISTRY, type FlagName } from "./registry";
import { readRawOverrides } from "./env";

/**
 * Server + client feature-flag accessor — the single source of truth for "is this flag on."
 *
 * Import `isFlagEnabled` / `getAllFlags` from a Server Component, a Route Handler, or a Client
 * Component alike; the same function runs in both places and reads the same
 * `NEXT_PUBLIC_*`-prefixed env vars, which Next.js makes available both server-side (plain
 * `process.env` at runtime) and client-side (inlined into the bundle at build time). There is no
 * separate client-only config or hydration step — that's what keeps this one source of truth
 * rather than two things that can drift.
 *
 * Every flag defaults OFF, in every environment, including production. This is intentionally a
 * single universal default rather than a per-environment default table: the invariant "every flag
 * defaults off in production" then holds by construction instead of by convention, and a team
 * cannot accidentally ship a flag that defaults on in prod by only thinking about dev.
 *
 * To turn a flag on in a given environment, set its env var there (e.g. in `.env.local` for local
 * dev, or in the environment's platform config for preview/staging). See `registry.ts` for the
 * env var name per flag.
 */
export const FLAG_DEFAULT = false as const;

const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * Parses a raw override string into a boolean. Returns `undefined` (meaning: no usable override,
 * fall back to the default) for an unset var or an unrecognized value — an override is never
 * silently misread as "on" or "off"; a typo'd value degrades to the safe default instead.
 */
function parseOverride(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

/**
 * Is `name` enabled?
 *
 * @param name - a registered flag from `FLAG_REGISTRY`.
 * @param configOverrides - optional explicit overrides, keyed by flag name, that take precedence
 *   over the env var. This is the "config" half of "overridable per-env (env var/config)" — it
 *   exists for callers that need to force a value outside of env vars (tests, local scripts, a
 *   future admin/config source) without touching `process.env` globally. Most call sites should
 *   omit this and rely on the env var alone.
 */
export function isFlagEnabled(
  name: FlagName,
  configOverrides?: Partial<Record<FlagName, string | undefined>>
): boolean {
  return resolveOverride(name, configOverrides) ?? FLAG_DEFAULT;
}

/** Set to an explicit off value, as opposed to unset — for a caller with its own non-default default. */
export function isFlagExplicitlyDisabled(
  name: FlagName,
  configOverrides?: Partial<Record<FlagName, string | undefined>>
): boolean {
  return resolveOverride(name, configOverrides) === false;
}

function resolveOverride(
  name: FlagName,
  configOverrides?: Partial<Record<FlagName, string | undefined>>
): boolean | undefined {
  const raw =
    configOverrides && Object.prototype.hasOwnProperty.call(configOverrides, name)
      ? configOverrides[name]
      : readRawOverrides()[name];
  return parseOverride(raw);
}

/** Every registered flag's current resolved value. Useful for a debug panel or a single log line. */
export function getAllFlags(
  configOverrides?: Partial<Record<FlagName, string | undefined>>
): Record<FlagName, boolean> {
  const names = Object.keys(FLAG_REGISTRY) as FlagName[];
  return Object.fromEntries(names.map((name) => [name, isFlagEnabled(name, configOverrides)])) as Record<
    FlagName,
    boolean
  >;
}
