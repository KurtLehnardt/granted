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
  readUninstallOutcome,
  startUninstaller,
  uninstallInfo,
  type CannotUninstallReason,
  type UninstallCheck,
  type UninstallChoice,
  type UninstallOutcome,
} from "@/lib/appUpdate/install";

/**
 * How long an uninstall this server started is still believed to be running.
 *
 * The same self-clearing latch the sibling update route keeps (see its
 * RUNNING_STALE_MS), and for the same reason: without it, a "running" flag that
 * nothing ever clears locks the feature out until the whole server is
 * restarted — and an uninstall that REFUSED (exit 3, exit 1) leaves the server
 * running, so that lockout would be permanent and the user could never retry.
 *
 * Shorter than the update's twenty minutes because the work is shorter: an
 * update re-clones a repository and runs `npm ci`, while an uninstall stops the
 * server (15s at worst), waits for node to go (15s at worst) and deletes a
 * folder. Five minutes is far longer than that can plausibly take and short
 * enough to be out of the way. A refusal usually clears the latch sooner than
 * this anyway — the uninstaller says so in its log, and that is read back below.
 */
const RUNNING_STALE_MS = 5 * 60 * 1000;

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
  /** An uninstall this server started that hasn't reported an outcome yet. */
  running: boolean;
  /** What the uninstaller this server started actually did, once it has said (null until then). */
  outcome: UninstallOutcome | null;
}

type Req = { headers: { get(name: string): string | null }; url?: string };

export type UninstallDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  uninstallInfo: () => ReturnType<typeof uninstallInfo>;
  readUninstallCheck: (script: string) => Promise<UninstallCheck | null>;
  startUninstaller: (script: string, choice: UninstallChoice) => Promise<string>;
  readUninstallOutcome: (log: string) => UninstallOutcome | null;
  now: () => number;
};

const REAL_DEPS: UninstallDeps = {
  isLoopbackRequest,
  uninstallInfo: () => uninstallInfo(),
  readUninstallCheck: (script) => readUninstallCheck(script),
  startUninstaller: (script, choice) => startUninstaller(script, choice),
  readUninstallOutcome: (log) => readUninstallOutcome(log),
  now: () => Date.now(),
};

/**
 * The uninstall this server started: when, and the log it is writing to. One at
 * a time, and never a latch that outlives what it describes (see
 * RUNNING_STALE_MS and uninstallState below).
 */
let run: { startedAt: number; log: string } | null = null;
/** The last outcome read out of that log, kept after the latch is cleared so the page can still show it. */
let lastOutcome: UninstallOutcome | null = null;
export function resetUninstallStateForTests(): void {
  run = null;
  lastOutcome = null;
}

/**
 * Whether an uninstall is still running, and what the last one said.
 *
 * Three ways a latch is let go, in this order: the uninstaller reported that it
 * did NOT remove anything (Granted is still here and can be asked again — the
 * case the whole log-reading is for), the uninstaller reported that it DID
 * (nothing more is coming; the server is about to stop), or nothing was
 * reported at all for longer than an uninstall can take.
 */
function uninstallState(d: UninstallDeps): { running: boolean; outcome: UninstallOutcome | null } {
  if (!run) return { running: false, outcome: lastOutcome };
  const outcome = run.log ? d.readUninstallOutcome(run.log) : null;
  if (outcome) {
    lastOutcome = outcome;
    run = null;
    return { running: false, outcome };
  }
  if (d.now() - run.startedAt >= RUNNING_STALE_MS) {
    run = null;
    return { running: false, outcome: lastOutcome };
  }
  return { running: true, outcome: lastOutcome };
}

const NOTHING_FOUND: Omit<AppUninstallInfo, "canUninstall" | "reason" | "installDir" | "running" | "outcome"> = {
  unsaved: [],
  keyFiles: [],
  backupDir: "",
};

async function info(d: UninstallDeps, check: boolean): Promise<AppUninstallInfo> {
  const state = uninstallState(d);
  const install = d.uninstallInfo();
  if (!install.canUninstall || !install.script) {
    return { canUninstall: false, reason: install.reason, installDir: install.installDir, ...NOTHING_FOUND, ...state };
  }
  // ?check=0: the page polling for the outcome of an uninstall it started, which
  // needs no second opinion about what would be deleted (and must not run the
  // script every couple of seconds to get one).
  if (!check) {
    return { canUninstall: true, reason: null, installDir: install.installDir, ...NOTHING_FOUND, ...state };
  }
  const found = await d.readUninstallCheck(install.script);
  if (!found) {
    // The script is there but said nothing readable. Report it as unavailable
    // rather than offering a button whose outcome nobody can predict.
    return { canUninstall: false, reason: "no-uninstaller", installDir: install.installDir, ...NOTHING_FOUND, ...state };
  }
  return {
    canUninstall: found.grantedInstall && found.installerMade,
    reason: found.grantedInstall && found.installerMade ? null : "not-installer-made",
    installDir: found.installDir || install.installDir,
    unsaved: found.unsaved,
    keyFiles: found.keyFiles,
    backupDir: found.backupDir,
    ...state,
  };
}

/**
 * GET /api/app/uninstall — whether this install can uninstall itself, what
 * would be deleted, and what the page has to warn about first. Changes nothing.
 *
 * ?check=0 skips asking the script and answers from this server alone: it is
 * what the page polls after starting an uninstall, to find out whether the
 * uninstaller refused (the same shape as the update route's ?check=0).
 */
export async function handleUninstallGet(req: Req, deps: Partial<UninstallDeps> = {}) {
  const d = { ...REAL_DEPS, ...deps };
  if (!d.isLoopbackRequest(req)) return NextResponse.json({ error: "Only available from this computer" }, { status: 403 });
  let check = true;
  try {
    if (req.url) check = new URL(req.url).searchParams.get("check") !== "0";
  } catch {
    /* not a URL this can read a query out of: ask the script, as always */
  }
  return NextResponse.json(await info(d, check));
}

/**
 * POST /api/app/uninstall — { action: "uninstall", keepKeys, force }.
 *
 * Answers 202 { started: true, log } once the uninstaller has been STARTED,
 * which is all that can be promised: it quits this very server, so there is no
 * later reply to wait for. What it is not is a promise that Granted has gone —
 * the script makes its own decisions afterwards and can still refuse (exit 3, a
 * parent folder it can't write to; exit 1, a copy of the keys it couldn't
 * make), leaving Granted running. Both of those print a line to `log`, which
 * GET ?check=0 reads back, and the page polls it rather than announcing
 * success. `keptKeys` here is likewise where the copy is MEANT to go; the
 * outcome in that log is what says where it went.
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
  if (uninstallState(d).running) return NextResponse.json({ error: "An uninstall is already running", started: false }, { status: 409 });
  // Taken HERE, in the same synchronous run as the check above it, with no
  // `await` in between — which is the whole point. It used to be taken further
  // down, after `readUninstallCheck`, and that is a real subprocess (around
  // 70ms): Node yields there, so two POSTs arriving close together both found
  // the latch still clear, both got past this guard, and both spawned a real
  // uninstaller against the same folder. One won the atomic rename; the other
  // exhausted its retry loop and reported exit 3 "files-in-use, nothing was
  // deleted" — false, because the install was gone. Whichever log was written
  // last is what the page polls, so the user could be told the uninstall
  // failed and to try again after Granted had already been removed. Two
  // browser tabs, a reload-and-reclick, or any client of this loopback
  // endpoint is enough to do it.
  //
  // The cost of taking it this early is that every refusal below now happens
  // while holding it, and has to put it back (`release()`); a refusal that
  // kept the latch would lock the feature out for the whole staleness window
  // over a question the user can answer straight away.
  const previousOutcome = lastOutcome;
  run = { startedAt: d.now(), log: "" };
  lastOutcome = null;
  const release = (): void => {
    run = null;
    // What the LAST uninstall said goes back on display too: a request that
    // refused to start one has changed nothing and has nothing to report over
    // it.
    lastOutcome = previousOutcome;
  };

  const check = await d.readUninstallCheck(install.script);
  if (!check || !check.grantedInstall || !check.installerMade) {
    release();
    return NextResponse.json({ error: "This folder isn't an install Granted's installer made, so it wasn't deleted", started: false }, { status: 409 });
  }
  const force = body.force === true;
  if (check.unsaved.length > 0 && !force) {
    release();
    return NextResponse.json(
      { error: "This folder has work that isn't saved to GitHub", started: false, unsaved: check.unsaved },
      { status: 409 },
    );
  }

  const choice: UninstallChoice = { keepKeys: body.keepKeys !== false, force };
  try {
    // The log the uninstaller will report to is filled in as soon as that is
    // known; the latch itself has been held since before the check above.
    const log = await d.startUninstaller(install.script, choice);
    run = { startedAt: d.now(), log };
    return NextResponse.json({ started: true, installDir: check.installDir, keptKeys: choice.keepKeys ? check.backupDir : null, log }, { status: 202 });
  } catch (err) {
    // Nothing was started, so this is a refusal like the others: let it go.
    release();
    const message = `Couldn't start the uninstaller: ${err instanceof Error ? err.message : String(err)}`;
    return NextResponse.json({ error: message, started: false, errorId: logError("app-uninstall", err, { path: "/api/app/uninstall" }) }, { status: 500 });
  }
}
