/**
 * The key rules `npm run setup` reports on, kept apart from the interactive
 * script so they can be tested. Every key is optional: search runs on the
 * built-in model with no key, and scoring needs one provider, which can be an
 * Anthropic key, an OpenAI key, another provider chosen later in Settings, or a
 * local model.
 *
 * The shape checks match the app's (lib/llm/providers.ts): an OpenAI key is
 * sk- plus 17-197 more non-space characters; a Claude key is sk-ant- plus
 * letters, digits, - and _.
 */

/** Value set for `key` in env text, or "" if blank or absent. */
export function envValue(text, key) {
  const m = String(text ?? "").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

/** What setup should say about the keys in `envText`. */
export function setupKeyReport(envText) {
  const openAi = envValue(envText, "OPENAI_API_KEY");
  const anthropic = envValue(envText, "ANTHROPIC_API_KEY");
  const openAiSet = openAi !== "" && openAi !== "sk-...";
  const anthropicSet = anthropic !== "" && anthropic !== "sk-ant-...";
  const openAiValid = openAiSet && /^sk-\S{17,197}$/.test(openAi);
  const anthropicValid = anthropicSet && /^sk-ant-[A-Za-z0-9_-]{13,193}$/.test(anthropic);
  return {
    /** A key that can score was given (whether it's well-formed is reported separately). */
    hasScoringKey: openAiSet || anthropicSet,
    openAiMalformed: openAiSet && !openAiValid,
    anthropicMalformed: anthropicSet && !anthropicValid,
    /** Search never needs a key; with a valid OpenAI key it uses OpenAI's embeddings (SEARCH_EMBEDDINGS=auto). */
    searchUses: openAiValid ? "openai" : "builtin",
  };
}
