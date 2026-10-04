/**
 * Background job behind Settings → Local: pull the local embedding model if
 * needed and build the local search index (lib/embeddings/localEmbedJob.ts).
 *
 * Normally spawned detached by the app (POST /api/llm/embeddings, or switching
 * Settings → Model to Local), which takes the single-flight lock first and hands
 * it to this process. Can also be run by hand from scaffold/:
 *
 *   node --import tsx scripts/local-embeddings-job.mjs
 *
 * Progress and errors go to data/local/local-embeddings-job.json; Settings polls it.
 */
import "./_loadEnvLocal.mjs"; // LLM_BASE_URL etc. when run by hand
import { runLocalEmbedJob } from "../lib/embeddings/localEmbedJob.ts";
import { acquireLocalEmbeddingsLock, releaseLocalEmbeddingsLock } from "../lib/embeddings/localEmbeddings.ts";

const baseDir = process.cwd();
if (process.env.GRANTED_LOCAL_EMBEDDINGS_LOCK_HELD !== "1" && !acquireLocalEmbeddingsLock(baseDir)) {
  console.error("Local search setup is already running.");
  process.exitCode = 1;
} else {
  await main();
}

async function main() {
  let ok = false;
  try {
    ok = await runLocalEmbedJob({ baseDir });
  } finally {
    releaseLocalEmbeddingsLock(baseDir);
  }
  console.log(ok ? "Local search index is ready." : "Local search setup failed; see data/local/local-embeddings-job.json.");
  // exitCode, not process.exit(): on Windows, exiting with fetch's keep-alive sockets still open can crash Node (0xC0000409).
  process.exitCode = ok ? 0 : 1;
}
