"use client";
// Explicit React import: needed under the plain `tsx`-run node:test runner
// (this repo's tsconfig `"jsx": "preserve"` falls back to the classic JSX
// runtime there) — see the same note in components/ApplicationChecklist.tsx.
import React, { useEffect, useRef, useState } from "react";

/**
 * Wraps horizontally-scrollable wide content (a table, a graph) with a
 * visual "there's more this way" hint -- a thin edge-fade gradient that
 * appears only while there's actually more content to scroll to in that
 * direction, and disappears once you've scrolled there. Mobile UI-walkthrough
 * finding: the awards tables scroll (a real `overflow-x-auto`, nothing was
 * lost) but gave zero visual cue that they do -- Amount/Year were invisible
 * unless a user happened to swipe. This makes that discoverable without
 * relying on accident.
 *
 * `tabIndex={0}` on the scroll container itself makes it keyboard-reachable
 * (Tab, then arrow keys scroll it) -- a bare `overflow-x-auto` div isn't in
 * the tab order by default, so without this the hint would only ever help
 * sighted mouse/touch users, not keyboard users hitting the same overflow.
 *
 * `fadeBg` names the Tailwind color TOKEN the gradient fades TO (must match
 * whatever's actually behind this container) so it blends into the real
 * background instead of showing a mismatched box -- token-backed per CON-02
 * (no raw hex), not a hardcoded color.
 */
export default function ScrollFadeContainer({
  children,
  fadeBg = "canvas",
}: {
  children: React.ReactNode;
  fadeBg?: "canvas" | "canvas-alt";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 1px tolerance for sub-pixel rounding at the scroll extremes (some
    // browsers report a fractional scrollWidth/clientWidth).
    const update = () => {
      setCanScrollLeft(el.scrollLeft > 1);
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // Catches content/viewport changes that don't fire a scroll event (e.g.
    // expanding a card widens/narrows the visible column, or window resize).
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  const fadeFrom = fadeBg === "canvas-alt" ? "from-canvas-alt" : "from-canvas";

  return (
    <div className="relative">
      <div
        ref={ref}
        tabIndex={0}
        className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
      >
        {children}
      </div>
      {canScrollLeft && (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r ${fadeFrom} to-transparent`}
        />
      )}
      {canScrollRight && (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l ${fadeFrom} to-transparent`}
        />
      )}
    </div>
  );
}
