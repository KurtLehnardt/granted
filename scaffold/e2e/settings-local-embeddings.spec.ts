import { test, expect, type Page } from "@playwright/test";
import { skipWelcomeGuide } from "./fixtures";

/**
 * Settings → Model → Local sets up local search with no terminal: picking Local
 * starts the background job, Settings shows its progress, a failure shows a
 * plain error with Retry, and success says search now runs on this machine.
 *
 * /api/llm, /api/llm/config and /api/llm/embeddings are stubbed at the network
 * layer (page.route), so this needs no Ollama, no keys, and never touches the
 * server's real data/local/.
 */

const MODEL = "nomic-embed-text";
const status = (s: Record<string, unknown>) => ({ model: MODEL, active: false, ...s });

async function stubLlm(page: Page) {
  let provider: "cloud" | "ollama" = "cloud";
  // Each poll of GET /api/llm/embeddings pops the next status; the last one sticks.
  const polls: Record<string, unknown>[] = [];
  let current: Record<string, unknown> = status({ state: "needed" });
  const posts: string[] = [];

  await page.route("**/api/llm", (route) =>
    route.fulfill({
      json:
        provider === "ollama"
          ? { local: true, provider, model: "llama3.2:1b", models: [], localEmbeddings: current }
          : { local: false, provider, localEmbeddings: current },
    }),
  );
  await page.route("**/api/llm/config", async (route) => {
    posts.push(`config:${route.request().postDataJSON()?.provider}`);
    provider = "ollama";
    current = status({ state: "running", progress: { stage: "pulling", pct: 40 } });
    await route.fulfill({ json: { provider, localEmbeddings: current } });
  });
  await page.route("**/api/llm/embeddings", async (route) => {
    if (route.request().method() === "POST") {
      posts.push("embeddings:start");
      current = status({ state: "running", progress: { stage: "embedding", done: 2000, total: 4698, pct: 43 } });
      return route.fulfill({ status: 202, json: { started: true, status: current } });
    }
    if (polls.length) current = polls.shift()!;
    return route.fulfill({ json: current });
  });
  return { polls, posts };
}

test("settings: picking Local sets up local search in the background, with progress, Retry, and a ready state", async ({ page }) => {
  await skipWelcomeGuide(page);
  const { polls, posts } = await stubLlm(page);
  await page.goto("/");
  await page.getByRole("button", { name: /open settings|open menu/i }).click();

  const section = page.getByTestId("model-section");
  await expect(section.getByTestId("active-provider")).toHaveText(/Cloud/);

  // The first poll after switching fails the way a stopped Ollama does.
  polls.push(
    status({
      state: "failed",
      errorKind: "ollama-unreachable",
      error: "Couldn't reach Ollama at http://localhost:11434. Make sure Ollama is installed and running (open the Ollama app), then click Retry.",
    }),
  );

  await section.getByRole("button", { name: "Local (Ollama)" }).click();
  await expect(section.getByTestId("active-provider")).toHaveText(/Local/);
  const panel = section.getByTestId("local-search-status");
  // Either the pull progress (if the first poll hasn't landed yet) or the failure it turns into.
  await expect(panel).toContainText(/Downloading the local search model \(nomic-embed-text\): 40%|Couldn't reach Ollama/);
  expect(posts).toContain("config:ollama");

  await expect(panel).toContainText("Couldn't reach Ollama");
  await expect(panel).toHaveAttribute("data-state", "failed");

  // Retry → running with a progress bar, then ready.
  polls.push(status({ state: "ready", active: true, count: 4698 }));
  await panel.getByRole("button", { name: "Retry" }).click();
  expect(posts).toContain("embeddings:start");
  await expect(panel).toContainText(/Building the local search index|Search runs on this machine/);
  await expect(panel).toContainText("Search runs on this machine (nomic-embed-text, 4,698 grants indexed).", { timeout: 15_000 });
  await expect(panel.getByRole("button")).toHaveCount(0);
});
