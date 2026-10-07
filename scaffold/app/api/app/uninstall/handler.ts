/**
 * Settings → About Granted → Uninstall Granted (macOS).
 *
 * The counterpart of Windows' "Installed apps" entry, which is where a Windows
 * user uninstalls Granted and which scripts/windows/uninstall.ps1 registers.
 * macOS has no such list, so the work order puts uninstall in two places
 * instead: the menu-bar menu (which runs the script directly, with its own
 * alert) and here.
 *
 * All of the safety rules live in scaffold/scripts/macos/uninstall.sh and are
 * not restated here: this route asks the script what an uninstall would find
 * (`--check`, which changes nothing), hands that to the page so the asking can
 * happen in front of the person doing it, and then runs the script with
 * --quiet — plus --force only when the page actually showed the unsaved work
 * and the answer was still yes. That is exactly the pair of flags the Windows
 * script's QuietUninstallString and -Force mean.
 */
import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { logError } from "@/lib/errorLog/server";
import {
  readUninstallCheck,
  startUninstaller,
  uninstallInfo,
  type CannotUninstallReason,
  type UninstallCheck,
  type UninstallChoice,
} from "@/lib/appUpdate/install";

export interface AppUninstallInfo {
  canUninstall: boolean;
  reason: CannotUninstallReason | null;
  installDir: string;
  /** Work in the folder that isn't on GitHub, in the script's own words. */
  unsaved: string[];
  /** The API-key and settings files a copy can be kept of. */
  keyFiles: string[];
  /** Where that copy goes. */
  backupDir: string;
}

type Req = { headers: { get(name: string): string | null } };

export type UninstallDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  uninstallInfo: () => ReturnType<typeof uninstallInfo>;
  readUninstallCheck: (script: string) => Promise<UninstallCheck | null>;
  startUninstaller: (script: string, choice: UninstallChoice) => Promise<string>;
};

const REAL_DEPS: UninstallDeps = {
  isLoopbackRequest,
  uninstallInfo: () => uninstallInfo(),
  readUninstallCheck: (script) => readUninstallCheck(script),
  startUninstaller: (script, choice) => startUninstaller(script, choice),
};

/** One uninstall at a time within this server (it only has to last until the server stops). */
let starting = false;
export function resetUninstallStateForTests(): void {
  starting = false;
}

const NOTHING_FOUND: Omit<AppUninstallInfo, "canUninstall" | "reason" | "installDir"> = {
  unsaved: [],
  keyFiles: [],
  backupDir: "",
};

async function info(d: UninstallDeps): Promise<AppUninstallInfo> {
  const install = d.uninstallInfo();
  if (!install.canUninstall || !install.script) {
    return { canUninstall: false, reason: install.reason, installDir: install.installDir, ...NOTHING_FOUND };
  }
  const check = await d.readUninstallCheck(install.script);
  if (!check) {
    // The script is there but said nothing readable. Report it as unavailable
    // rather than offering a button whose outcome nobody can predict.
    return { canUninstall: false, reason: "no-uninstaller", installDir: install.installDir, ...NOTHING_FOUND };
  }
  return {
    canUninstall: check.grantedInstall && check.installerMade,
    reason: check.grantedInstall && check.installerMade ? null : "not-installer-made",
    installDir: check.installDir || install.installDir,
    unsaved: check.unsaved,
    keyFiles: check.keyFiles,
    backupDir: check.backupDir,
  };
}

/**
 * GET /api/app/uninstall — whether this install can uninstall itself, what
 * would be deleted, and what the page has to warn about first. Changes nothing.
 */
export async function handleUninstallGet(req: Req, deps: Partial<UninstallDeps> = {}) {
  const d = { ...REAL_DEPS, ...deps };
  if (!d.isLoopbackRequest(req)) return NextResponse.json({ error: "Only available from this computer" }, { status: 403 });
  return NextResponse.json(await info(d));
}

/**
 * POST /api/app/uninstall — { action: "uninstall", keepKeys, force }.
 *
 * Answers 202 { started: true } and then stops answering anything: the
 * uninstaller it started quits this very server. The page says so rather than
 * waiting for a reply that cannot come.
 *
 * `force` is refused unless it is needed, and needed unless it is given: the
 * unsaved work is read again here, from the script, after the page was shown
 * it — so a page left open while work was done in the folder cannot delete it
 * on a stale answer.
 */
export async function handleUninstallPost(req: Req & { json?: () => Promise<unknown> }, deps: Partial<UninstallDeps> = {}) {
  const d = { ...REAL_DEPS, ...deps };
  if (!d.isLoopbackRequest(req)) return NextResponse.json({ error: "Only available from this computer" }, { status: 403 });
  const body = ((await req.json?.().catch(() => null)) ?? {}) as { action?: unknown; keepKeys?: unknown; force?: unknown };
  if (body.action !== "uninstall") return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const install = d.uninstallInfo();
  if (!install.canUninstall || !install.script) {
    return NextResponse.json({ error: "This copy of Granted can't uninstall itself", started: false, reason: install.reason }, { status: 409 });
  }
  if (starting) return NextResponse.json({ error: "An uninstall is already running", started: false }, { status: 409 });

  const check = await d.readUninstallCheck(install.script);
  if (!check || !check.grantedInstall || !check.installerMade) {
    return NextResponse.json({ error: "This folder isn't an install Granted's installer made, so it wasn't deleted", started: false }, { status: 409 });
  }
  const force = body.force === true;
  if (check.unsaved.length > 0 && !force) {
    return NextResponse.json(
      { error: "This folder has work that isn't saved to GitHub", started: false, unsaved: check.unsaved },
      { status: 409 },
    );
  }

  const choice: UninstallChoice = { keepKeys: body.keepKeys !== false, force };
  starting = true;
  try {
    const log = await d.startUninstaller(install.script, choice);
    return NextResponse.json({ started: true, installDir: check.installDir, keptKeys: choice.keepKeys ? check.backupDir : null, log }, { status: 202 });
  } catch (err) {
    starting = false;
    const message = `Couldn't start the uninstaller: ${err instanceof Error ? err.message : String(err)}`;
    return NextResponse.json({ error: message, started: false, errorId: logError("app-uninstall", err, { path: "/api/app/uninstall" }) }, { status: 500 });
  }
}
