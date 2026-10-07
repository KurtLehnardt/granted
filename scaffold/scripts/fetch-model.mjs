/**
 * Download the built-in search model into scaffold/models/ (gitignored), so
 * search works with no API key and offline. The installers run this right after
 * `npm ci`; if it fails there, the app downloads the model itself on the first
 * search instead (Settings → Model shows the progress).
 *
 *   node scripts/fetch-model.mjs            (from scaffold/)
 *   npm run model:fetch
 *
 * Idempotent: files already present and verified are kept, so re-running it
 * (the in-app updater runs the installer script again) is quick.
 *
 * Env: GRANTED_MODEL_URL  a mirror holding the same files, e.g.
 *        https://mirror.example.org/nomic-embed-text-v1.5  (fetches <url>/onnx/model_fp16.onnx, ...)
 *      GRANTED_MODELS_DIR  a different models folder (default scaffold/models)
 */
import { BUILTIN_MODEL, BUILTIN_MODEL_TOTAL_BYTES, builtinModelPresent, downloadBuiltinModel, modelBaseUrl, modelsDir } from "./lib/builtinModel.mjs";

const dir = modelsDir();
if (builtinModelPresent(dir)) {
  console.log(`Search model already present (${BUILTIN_MODEL.repo}) in ${dir}.`);
} else {
  const mb = (n) => Math.round(n / 1e6);
  console.log(`Downloading the search model (${BUILTIN_MODEL.repo}, about ${mb(BUILTIN_MODEL_TOTAL_BYTES)} MB) from ${modelBaseUrl()} ...`);
  let lastPct = -1;
  const isTty = Boolean(process.stdout.isTTY);
  try {
    await downloadBuiltinModel({
      dir,
      onProgress: ({ pct, doneBytes }) => {
        if (pct === lastPct) return;
        lastPct = pct;
        if (isTty) process.stdout.write(`\r  ${pct}% (${mb(doneBytes)} of ${mb(BUILTIN_MODEL_TOTAL_BYTES)} MB)`);
        else if (pct % 10 === 0) console.log(`  ${pct}%`);
      },
    });
    if (isTty) process.stdout.write("\n");
    console.log(`Search model ready in ${dir}.`);
  } catch (e) {
    if (isTty) process.stdout.write("\n");
    console.error(`Couldn't download the search model: ${e.message}`);
    console.error("Granted will try again the first time you search. To retry now: npm run model:fetch");
    process.exitCode = 1;
  }
}
