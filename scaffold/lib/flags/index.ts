/**
 * Public entry point for the CON-03 feature-flag registry. Import from `@/lib/flags`, not from
 * the individual files in this directory.
 *
 * Example:
 *   import { isFlagEnabled } from "@/lib/flags";
 *   if (isFlagEnabled("r1_interview")) { ... }
 *
 * See registry.ts for the flag list + how to add one, accessor.ts for how resolution works
 * (default OFF, env override, optional config override), and env.ts for why the env reads are
 * written out statically.
 */
export type { FlagName, FlagDefinition } from "./registry";
export { FLAG_REGISTRY } from "./registry";
export { isFlagEnabled, isFlagExplicitlyDisabled, getAllFlags, FLAG_DEFAULT } from "./accessor";
