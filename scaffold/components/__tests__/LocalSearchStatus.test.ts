import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import LocalSearchStatus, { describeLocalSearchStatus } from "../LocalSearchStatus";
import type { LocalEmbeddingsStatus } from "@/lib/embeddings/localEmbeddings";

const s = (over: Partial<LocalEmbeddingsStatus>): LocalEmbeddingsStatus => ({ state: "needed", model: "nomic-embed-text", active: false, ...over });
const render = (status: LocalEmbeddingsStatus | null) =>
  renderToStaticMarkup(React.createElement(LocalSearchStatus, { initialStatus: status }));

describe("describeLocalSearchStatus — what Settings → Local says", () => {
  test("nothing to say when embeddings are set in .env.local, or before the status loads", () => {
    assert.equal(describeLocalSearchStatus(s({ state: "not-applicable" })), null);
    assert.equal(describeLocalSearchStatus(undefined), null);
  });

  test("running: one plain line per stage, with a percentage", () => {
    assert.match(describeLocalSearchStatus(s({ state: "running", progress: { stage: "checking" } }))!.title, /checking Ollama/);
    const pulling = describeLocalSearchStatus(s({ state: "running", progress: { stage: "pulling", pct: 42 } }))!;
    assert.equal(pulling.title, "Downloading the local search model (nomic-embed-text): 42%");
    assert.equal(pulling.pct, 42);
    const embedding = describeLocalSearchStatus(s({ state: "running", progress: { stage: "embedding", done: 1200, total: 4698, pct: 26 } }))!;
    assert.equal(embedding.title, "Building the local search index: 1,200 of 4,698 grants (26%)");
    assert.match(embedding.detail!, /in the background.*half an hour.*start working as soon as it finishes/);
    assert.equal(embedding.action, undefined, "no button while it runs");
    assert.match(describeLocalSearchStatus(s({ state: "running", progress: { stage: "saving" } }))!.title, /Saving/);
  });

  test("an update over an active index says search keeps working meanwhile", () => {
    const v = describeLocalSearchStatus(s({ state: "running", active: true, progress: { stage: "embedding" } }))!;
    assert.match(v.detail!, /keeps using your current local index/);
  });

  test("failed: the server's plain-language error plus Retry", () => {
    const v = describeLocalSearchStatus(s({ state: "failed", error: "Couldn't reach Ollama at http://localhost:11434.", errorKind: "ollama-unreachable" }))!;
    assert.equal(v.tone, "error");
    assert.equal(v.title, "Couldn't reach Ollama at http://localhost:11434.");
    assert.equal(v.action, "Retry");
  });

  test("needed: explains the one-time setup and offers to start it", () => {
    const v = describeLocalSearchStatus(s({}))!;
    assert.match(v.title, /one-time setup/);
    assert.equal(v.action, "Set up local search");
  });

  test("ready / outdated", () => {
    const ready = describeLocalSearchStatus(s({ state: "ready", active: true, count: 4698 }))!;
    assert.equal(ready.tone, "ok");
    assert.equal(ready.title, "Search runs on this machine (nomic-embed-text, 4,698 grants indexed).");
    assert.equal(ready.action, undefined);
    const outdated = describeLocalSearchStatus(s({ state: "ready", active: true, outdated: true }))!;
    assert.equal(outdated.action, "Update local search");
  });
});

describe("LocalSearchStatus — render", () => {
  test("running renders an accessible progress bar and no button", () => {
    const html = render(s({ state: "running", progress: { stage: "embedding", done: 10, total: 100, pct: 10 } }));
    assert.match(html, /data-state="running"/);
    assert.match(html, /role="progressbar"/);
    assert.match(html, /aria-valuenow="10"/);
    assert.doesNotMatch(html, /<button/);
  });

  test("failed renders the error and a Retry button", () => {
    const html = render(s({ state: "failed", error: "Building the local search index failed: boom. Click Retry." }));
    assert.match(html, /Building the local search index failed: boom/);
    assert.match(html, /<button[^>]*>Retry<\/button>/);
  });

  test("renders nothing when not applicable", () => {
    assert.equal(render(s({ state: "not-applicable" })), "");
    assert.equal(render(null), "");
  });
});
