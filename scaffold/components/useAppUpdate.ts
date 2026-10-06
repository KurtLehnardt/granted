/**
 * Waiting through an update: update.ps1 stops this server, installs the new
 * release and starts Granted again, so for a minute or two every request
 * fails. Polls the (GitHub-free) version endpoint until the server answers
 * with the new version — or update.ps1 reports an error.
 */
import type { AppUpdateInfo } from "@/app/api/app/update/handler";

export type UpdateOutcome = { ok: true } | { ok: false; message: string };

export async function waitForUpdate(
  to: string,
  opts: { intervalMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<UpdateOutcome> {
  const intervalMs = opts.intervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  // Give update.ps1 a moment to write "running" and stop the server.
  await sleep(intervalMs);
  while (now() < deadline) {
    try {
      const res = await doFetch("/api/app/update?check=0", { cache: "no-store" });
      if (res.ok) {
        const info = (await res.json()) as AppUpdateInfo;
        if (`v${info.version}` === to) return { ok: true };
        if (info.status?.state === "error" && info.status.to === to) {
          return { ok: false, message: info.status.message ?? "The update didn't finish." };
        }
      }
    } catch {
      /* the server is down mid-update: keep waiting */
    }
    await sleep(intervalMs);
  }
  return { ok: false, message: "The update is taking much longer than expected. Check Granted's icon by the clock, or restart Granted." };
}
