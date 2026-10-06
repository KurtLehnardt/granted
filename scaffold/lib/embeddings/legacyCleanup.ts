import { rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Before the built-in search model, picking Local in Settings re-embedded the
 * corpus with Ollama into data/local/local-embeddings/ (plus a job file, log and
 * lock beside it). Search no longer reads any of it, so it is removed on upgrade:
 * best effort, once per process, never throwing.
 */
export const LEGACY_LOCAL_EMBEDDINGS_PATHS = [
  ["data", "local", "local-embeddings"],
  ["data", "local", "local-embeddings-job.json"],
  ["data", "local", "local-embeddings-job.log"],
  ["data", "local", "local-embeddings.lock"],
];

export function removeLegacyLocalEmbeddings(baseDir: string): void {
  for (const parts of LEGACY_LOCAL_EMBEDDINGS_PATHS) {
    try {
      rmSync(join(baseDir, ...parts), { recursive: true, force: true });
    } catch {
      /* a file another process holds open: leave it for next time */
    }
  }
}

const KEY = Symbol.for("granted.legacyLocalEmbeddingsRemoved");

/** removeLegacyLocalEmbeddings for the app's own folder, once per process (never under tests). */
export function removeLegacyLocalEmbeddingsOnce(baseDir: string = process.cwd()): void {
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (g[KEY] || process.env.NODE_TEST_CONTEXT) return;
  g[KEY] = true;
  removeLegacyLocalEmbeddings(baseDir);
}
