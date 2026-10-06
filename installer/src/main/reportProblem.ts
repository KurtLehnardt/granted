/**
 * The installer's "Report this problem": the pre-filled GitHub issue link
 * for an error it showed, sanitized with this computer's home folder, user
 * name and (once Granted is installed) the values in scaffold/.env.local.
 * Free of any `electron` import (like release.ts) so it's tested under plain
 * Node; ipc.ts opens the link with shell.openExternal.
 */
import { readFileSync } from "node:fs";
import { arch, homedir, release, userInfo } from "node:os";
import { join } from "node:path";
import { buildInstallerIssueUrl, envFileSecrets, type SanitizeContext } from "../shared/reportProblem";

export const MAX_REPORTED_MESSAGE = 4000;

export interface ReportDeps {
  version: string;
  scaffoldDir: string;
  platform?: string;
  home?: string;
  user?: string;
  readFile?: (path: string) => string;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function installerSanitizeContext(d: ReportDeps): SanitizeContext {
  const read = d.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  return {
    home: d.home ?? safe(() => homedir(), null),
    user: d.user ?? safe(() => userInfo().username, null),
    secrets: safe(() => envFileSecrets(read(join(d.scaffoldDir, ".env.local"))), []),
  };
}

/** The link for an error shown on `where` (a screen name). Anything odd from the renderer is coerced, never trusted. */
export function installerIssueUrl(message: unknown, where: unknown, d: ReportDeps): string {
  const text = typeof message === "string" ? message.slice(0, MAX_REPORTED_MESSAGE) : "";
  const screen = typeof where === "string" && /^[a-z-]{1,40}$/.test(where) ? where : "installer";
  return buildInstallerIssueUrl({
    message: text,
    version: d.version,
    os: `${d.platform ?? process.platform} ${safe(() => release(), "")} ${safe(() => arch(), "")}`.trim(),
    where: screen,
    sanitize: installerSanitizeContext(d),
  });
}
