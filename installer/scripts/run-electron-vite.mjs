#!/usr/bin/env node
// Ubuntu 24.04+ breaks Electron's native SUID sandbox for an unpacked
// (dev-from-source) run: npm extracts chrome-sandbox as 755/non-root, and
// that distro's AppArmor restriction on unprivileged user namespaces blocks
// the other sandboxing fallback too -- Electron aborts with a fatal
// SUID-sandbox error before a window ever renders.
//
// This can ONLY be fixed via the environment/command-line the electron
// binary itself is launched with -- NOT from inside the app's own main
// process JS. A real validation pass on Ubuntu 24.04 proved this: a probe
// written as the literal first line of the built main/index.js never
// printed before the abort fired, meaning Electron's native sandbox check
// runs and aborts before any main-process JavaScript is evaluated at all.
// (An earlier attempt used app.commandLine.appendSwitch("no-sandbox")
// inside main/index.ts -- confirmed ineffective for exactly this reason,
// and removed.)
//
// This wrapper sets ELECTRON_DISABLE_SANDBOX before spawning electron-vite
// (which in turn spawns electron) -- early enough to actually take effect,
// confirmed working by the same validation pass (it's one of the two
// mechanisms, alongside the equivalent --no-sandbox CLI flag, that were
// directly verified to produce a correctly rendering window). Linux only,
// since macOS/Windows don't have this bug and disabling the sandbox there
// would be an unnecessary regression.
//
// Scoped to running from source, before any real packaging exists: a
// properly packaged Linux release (electron-builder or similar) sets
// chrome-sandbox's ownership/mode correctly at build time, which fixes
// this at the root rather than working around it -- revisit this file
// once that milestone lands, rather than assuming it's still needed.
import { spawnSync } from "node:child_process";

const env = { ...process.env };
if (process.platform === "linux") {
  env["ELECTRON_DISABLE_SANDBOX"] = "1";
}

const electronViteArgs = process.argv.slice(2);
const result = spawnSync("electron-vite", electronViteArgs, {
  stdio: "inherit",
  env,
  shell: true,
});
process.exit(result.status ?? 1);
