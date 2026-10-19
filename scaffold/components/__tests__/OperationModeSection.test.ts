import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import OperationModeSection from "../OperationModeSection";
import type { OperationMode } from "../../lib/llm/config";

type Props = React.ComponentProps<typeof OperationModeSection>;

function render(props: Partial<Props> = {}) {
  return renderToStaticMarkup(
    React.createElement(OperationModeSection, { currentMode: "local", onModeChange: () => {}, ...props }),
  );
}

// The repo has no DOM test environment, so click handlers are exercised by
// calling the component with a stub hook dispatcher and invoking the onClick
// of the button elements it returns.
function findButtons(node: React.ReactNode, out: React.ReactElement<any>[] = []): React.ReactElement<any>[] {
  if (Array.isArray(node)) node.forEach((n) => findButtons(n, out));
  else if (React.isValidElement(node)) {
    const el = node as React.ReactElement<any>;
    if (el.type === "button") out.push(el);
    findButtons(el.props?.children, out);
  }
  return out;
}

function renderButtons(props: Props): React.ReactElement<any>[] {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const prev = internals.current;
  internals.current = { useId: () => ":test:" };
  try {
    return findButtons((OperationModeSection as unknown as (p: Props) => React.ReactElement)(props));
  } finally {
    internals.current = prev;
  }
}

describe("OperationModeSection", () => {
  test("renders the three options", () => {
    const html = render();
    assert.match(html, />Fully Local</);
    assert.match(html, />Cloud</);
    assert.match(html, />Hybrid</);
    assert.equal((html.match(/<button/g) ?? []).length, 3);
  });

  for (const [mode, label] of [
    ["local", "Fully Local"],
    ["cloud", "Cloud"],
    ["hybrid", "Hybrid"],
  ] as const) {
    test(`highlights only the selected option (${mode})`, () => {
      const html = render({ currentMode: mode });
      const pressed = Array.from(html.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([^<]*)</g)).map((m) => m[1]);
      assert.deepEqual(pressed, [label]);
      assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 2);
      assert.equal((html.match(/bg-structure text-token-white/g) ?? []).length, 1);
    });
  }

  test("calls onModeChange with the clicked mode", () => {
    const calls: OperationMode[] = [];
    const buttons = renderButtons({ currentMode: "local", onModeChange: (m) => calls.push(m) });
    assert.equal(buttons.length, 3);
    buttons[1].props.onClick(); // Cloud
    buttons[2].props.onClick(); // Hybrid
    assert.deepEqual(calls, ["cloud", "hybrid"]);
  });

  test("does not call onModeChange when the current option is clicked", () => {
    const calls: OperationMode[] = [];
    const buttons = renderButtons({ currentMode: "local", onModeChange: (m) => calls.push(m) });
    buttons[0].props.onClick();
    assert.deepEqual(calls, []);
  });

  test("shows the privacy badge in local mode", () => {
    const html = render({ currentMode: "local" });
    assert.match(html, /data-testid="privacy-badge"/);
    assert.match(html, /no data leaves your device/);
  });

  test("does not show the privacy badge in cloud or hybrid mode", () => {
    assert.doesNotMatch(render({ currentMode: "cloud" }), /privacy-badge/);
    assert.doesNotMatch(render({ currentMode: "hybrid" }), /privacy-badge/);
  });

  test("buttons are disabled when the disabled prop is true", () => {
    const html = render({ disabled: true });
    assert.equal((html.match(/<button[^>]*disabled=""/g) ?? []).length, 3);
  });

  test("buttons are enabled by default", () => {
    assert.doesNotMatch(render(), /disabled=""/);
  });
});
