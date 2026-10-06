// No imports: shared by Node scripts and browser code (lib/llm/ollamaModels.ts).

/**
 * Memory (GB) → recommended Ollama chat model. A small, easy-to-edit table of
 * WIDELY-AVAILABLE public tags. Ordered high→low; `recommendModel` picks the
 * first tier the machine clears.
 */
export const MODEL_TIERS = [
  {
    minGB: 32,
    model: "qwen2.5:14b",
    alt: "llama3.1:8b",
    note: "Best local quality; needs ~32GB+ of memory/VRAM.",
  },
  {
    minGB: 16,
    model: "qwen2.5:7b",
    alt: "llama3.1:8b",
    note: "Strong, well-calibrated local default for 16–32GB.",
  },
  {
    minGB: 8,
    model: "llama3.2:3b",
    alt: "qwen2.5:3b",
    note: "Good balance for 8–16GB machines.",
  },
  {
    minGB: 0,
    model: "llama3.2:1b",
    alt: "qwen2.5:1.5b",
    note: "Fits small/4GB GPUs, but quality is rougher and scoring is slow.",
  },
];

/**
 * Every tier's model and alternative, best first: the order to prefer an
 * installed model in when the configured one isn't installed.
 */
export const PREFERRED_CHAT_MODELS = MODEL_TIERS.flatMap((t) => [t.model, t.alt]).filter((m, i, all) => all.indexOf(m) === i);
