import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import LocalSearchStatus, { describeLocalSearchStatus } from "../LocalSearchStatus";
import type { SearchStatus } from "@/lib/embeddings/searchStatus";
import type { BuiltinModelStatus } from "@/lib/embeddings/builtin";

const status = (builtin: Partial<BuiltinModelStatus> = {}, over: Partial<SearchStatus> = {}): SearchStatus => ({
  space: "builtin",
  label: "Built-in, on this computer",
  model: "nomic-embed-text-v1.5",
  reason: "No OpenAI key",
  setting: "auto",
  builtin: { state: "ready", model: "nomic-embed-text-v1.5", totalBytes: 274574153, ...builtin },
  ...over,
});

describe("describeLocalSearchStatus — the Search line", () => {
  test("no status yet -> nothing", () => {
    assert.equal(describeLocalSearchStatus(null), null);
  });

  test("built-in and downloaded -> says search runs on this computer, offline, no key", () => {
    const v = describeLocalSearchStatus(status())!;
    assert.equal(v.tone, "ok");
    assert.equal(v.title, "Search: Built-in, on this computer");
    assert.match(v.detail!, /No key needed/);
    assert.equal(v.action, undefined);
  });

  test("built-in, downloading -> progress with a percentage", () => {
    const v = describeLocalSearchStatus(status({ state: "downloading", pct: 42, doneBytes: 1 }))!;
    assert.equal(v.tone, "progress");
    assert.equal(v.pct, 42);
    assert.match(v.title, /Downloading the search model: 42%/);
    assert.match(v.detail!, /about 275 MB/);
  });

  test("built-in, not downloaded -> offers Download now and says the first search fetches it", () => {
    const v = describeLocalSearchStatus(status({ state: "missing" }))!;
    assert.equal(v.action, "Download now");
    assert.match(v.detail!, /first search/);
  });

  test("built-in, download failed -> the error and a Retry", () => {
    const v = describeLocalSearchStatus(status({ state: "failed", error: "Couldn't download the search model: offline" }))!;
    assert.equal(v.tone, "error");
    assert.equal(v.action, "Retry");
    assert.match(v.title, /offline/);
  });

  test("OpenAI embeddings -> says so, with how to switch to built-in", () => {
    const v = describeLocalSearchStatus(status({}, { space: "openai", label: "OpenAI embeddings", model: "text-embedding-3-small" }))!;
    assert.equal(v.title, "Search: OpenAI embeddings");
    assert.match(v.detail!, /SEARCH_EMBEDDINGS=builtin/);
  });

  test("a custom embedder from .env.local -> names it", () => {
    const v = describeLocalSearchStatus(status({}, { space: "custom", label: "x", model: "nomic-embed-text" }))!;
    assert.match(v.title, /your embedding server \(nomic-embed-text\)/);
  });
});

describe("LocalSearchStatus — renders", () => {
  test("a progress bar while downloading", () => {
    const html = renderToStaticMarkup(React.createElement(LocalSearchStatus, { initialStatus: status({ state: "downloading", pct: 10 }) }));
    assert.match(html, /data-testid="search-status"/);
    assert.match(html, /role="progressbar"/);
    assert.match(html, /aria-valuenow="10"/);
  });

  test("nothing without a status", () => {
    assert.equal(renderToStaticMarkup(React.createElement(LocalSearchStatus, {})), "");
  });
});
