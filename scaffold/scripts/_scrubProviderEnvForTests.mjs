/**
 * Test-bootstrap plumbing, loaded via Node's `--import` flag before any test
 * file runs (see the "test" script in package.json). The leading underscore
 * in the filename marks it as bootstrap plumbing rather than a runnable
 * script of its own — it is never invoked directly.
 *
 * Several tests assert on "no cloud key configured" behavior (for example,
 * that resolveCloudConfig() reports no key, or that saving a cloud config
 * with no key anywhere returns a 400), but lib/llm/config.ts reads
 * process.env.ANTHROPIC_API_KEY and process.env.OPENAI_API_KEY directly. On
 * a developer machine with real keys exported in the shell profile, those
 * tests would see a real key and fail, even though the exact same tests
 * pass in CI, where there are no ambient provider keys. This file exists so
 * the test run is hermetic on both: it deliberately clears only the two
 * provider env vars the process inherited at startup, before any test file
 * (and therefore before anything that reads those vars) has a chance to run.
 *
 * This only clears what was present at process startup. Tests that
 * themselves set and then restore ANTHROPIC_API_KEY / OPENAI_API_KEY around
 * individual assertions are unaffected — they mutate process.env at
 * runtime, after this file has already deleted whatever was inherited.
 */

delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
