import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import ProblemsSection, { confirmClear, countText } from "../ProblemsSection";
import ReportProblemLink, { upgradedReportUrl } from "../ReportProblemLink";
import CrashNotice from "../CrashNotice";
import { isIgnorableError } from "../ErrorReporter";
import type { LogsSummary } from "@/app/api/logs/handler";

const ISSUE = "https://github.com/KurtLehnardt/granted/issues/new?title=Problem&labels=bug&body=x";
const summary = (over: Partial<LogsSummary> = {}): LogsSummary => ({
  count: 2,
  recentCount: 2,
  recent: [
    { id: "E-ABCDEF", time: "2026-10-05T10:00:00.000Z", area: "search", source: "server", message: "The search didn't complete: [redacted-key]", version: "0.2.3", platform: "win32" },
    { id: "E-GHJKLM", time: "2026-10-04T09:00:00.000Z", area: "page", source: "client", message: "TypeError: x is undefined", version: "0.2.3", platform: "win32" },
  ],
  issueUrl: ISSUE,
  issueIncluded: 2,
  logDir: "C:\\Users\\me\\AppData\\Local\\Granted\\logs",
  canOpenFolder: true,
  ...over,
});
const render = (s?: LogsSummary) => renderToStaticMarkup(React.createElement(ProblemsSection, { initialSummary: s }));

describe("Settings → Problems & logs", () => {
  test("the heading, the count, the last errors and the four buttons", () => {
    const html = render(summary());
    assert.match(html, /Problems &amp; logs/);
    assert.match(html, /2 errors in the last 7 days\./);
    assert.match(html, /E-ABCDEF/);
    assert.match(html, /The search didn&#x27;t complete: \[redacted-key\]/);
    assert.match(html, /TypeError: x is undefined/);
    assert.match(html, />Report a problem</);
    assert.match(html, />Copy log</);
    assert.match(html, />Open log folder</);
    assert.match(html, />Clear log</);
  });

  test("Report a problem is a link to the pre-filled GitHub issue, opened in a new tab", () => {
    const html = render(summary());
    const a = /<a [^>]*data-testid="report-problem"[^>]*>/.exec(html)![0];
    assert.match(a, new RegExp(`href="${ISSUE.replace(/[?&.]/g, (c) => (c === "&" ? "&amp;" : `\\${c}`))}"`));
    assert.match(a, /target="_blank"/);
    assert.match(a, /rel="noopener noreferrer"/);
  });

  test("an empty log: nothing to copy or clear", () => {
    const html = render(summary({ count: 0, recentCount: 0, recent: [] }));
    assert.match(html, /No errors recorded\./);
    assert.match(html, /disabled=""[^>]*>Copy log</);
    assert.match(html, /disabled=""[^>]*>Clear log</);
    assert.doesNotMatch(html, /aria-label="Recent errors"/);
  });

  test("not Windows: the log folder's path is shown instead", () => {
    assert.match(render(summary({ canOpenFolder: false, logDir: "/home/me/.granted/logs" })), /The log is in \/home\/me\/\.granted\/logs\./);
    assert.doesNotMatch(render(summary()), /The log is in/);
  });

  test("count text", () => {
    assert.equal(countText(null), "Reading the error log…");
    assert.equal(countText(null, true), "Couldn't read the error log.");
    assert.equal(countText(summary({ count: 1, recentCount: 1 })), "1 error in the last 7 days.");
    assert.equal(countText(summary({ count: 9, recentCount: 2 })), "2 errors in the last 7 days (9 in the log).");
  });

  test("Clear log asks first, and does nothing unless confirmed", () => {
    const asked: string[] = [];
    assert.equal(confirmClear((m) => (asked.push(m), false)), false);
    assert.equal(confirmClear(() => true), true);
    assert.match(asked[0], /Clear Granted's error log\?/);
    assert.equal(confirmClear(() => { throw new Error("no dialogs here"); }), false);
  });

  test("before it loads", () => {
    assert.match(render(undefined), /Reading the error log…/);
  });
});

describe("Report this problem (under an error)", () => {
  test("shows the error id and links to the issue", () => {
    const html = renderToStaticMarkup(React.createElement(ReportProblemLink, { errorId: "E-ABCDEF", initialUrl: ISSUE }));
    assert.match(html, /Error ID <span data-testid="error-id">E-ABCDEF<\/span>/);
    assert.match(html, />Report this problem</);
    assert.match(html, /target="_blank"/);
  });

  test("without the server, a link built from this error alone (sanitized)", () => {
    const html = renderToStaticMarkup(
      React.createElement(ReportProblemLink, { errorId: "E-ABCDEF", area: "search", message: "bad sk-ant-AAAAAAAAAAAAAAAAAAAA" }),
    );
    const href = /href="([^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    const u = new URL(href);
    assert.equal(u.searchParams.get("template"), "bug_report.yml");
    assert.equal(u.searchParams.get("error-id"), "E-ABCDEF");
    const body = u.searchParams.get("recent-errors")!;
    assert.match(body, /E-ABCDEF/);
    assert.match(body, /bad \[redacted-key\]/);
  });

  test("REGRESSION (review): the server's link replaces the browser's only when the server found this error", () => {
    const mine = "https://github.com/KurtLehnardt/granted/issues/new?template=bug_report.yml&title=mine";
    const server = "https://github.com/KurtLehnardt/granted/issues/new?template=bug_report.yml&title=server";
    assert.equal(upgradedReportUrl(mine, { issueUrl: server, issueFound: true }), server);
    assert.equal(upgradedReportUrl(mine, { issueUrl: server, issueFound: false }), mine);
    assert.equal(upgradedReportUrl(mine, { issueUrl: server }), mine);
    assert.equal(upgradedReportUrl(mine, null), mine);
    assert.equal(upgradedReportUrl(mine, { issueUrl: 42, issueFound: true }), mine);
  });

  test("a crash (error boundary) shows Try again and the report link", () => {
    const html = renderToStaticMarkup(
      React.createElement(CrashNotice, { error: new Error("render blew up"), reset: () => {}, initialErrorId: "E-ZXCVBN" }),
    );
    assert.match(html, /Something went wrong on this page/);
    assert.match(html, />Try again</);
    assert.match(html, /E-ZXCVBN/);
    assert.match(html, />Report this problem</);
  });
});

test("browser noise isn't logged", () => {
  assert.equal(isIgnorableError("ResizeObserver loop completed with undelivered notifications."), true);
  assert.equal(isIgnorableError("Script error."), true);
  assert.equal(isIgnorableError("x", "chrome-extension://abc/content.js"), true);
  assert.equal(isIgnorableError("AbortError: The user aborted a request."), true);
  assert.equal(isIgnorableError("TypeError: cannot read properties of undefined"), false);
});
