/**
 * Prints ONE marked section of the page as if it were the whole document,
 * via the browser's own print dialog — "Save as PDF" is a destination every
 * modern browser already offers there, so this needs no server-side
 * rendering or PDF library. Pairs with app/globals.css's `@media print`
 * block, which hides everything in `<body>` except whichever element
 * carries the matching `print-section-<target>` class (see
 * CompetitorResults.tsx for real usage) — add a new `PrintTarget` + its own
 * CSS pair there when a new printable section is needed.
 *
 * `data-print-target` is set on `<body>` right before printing and cleared
 * on the browser's own `afterprint` event, which fires reliably whether the
 * user actually prints, saves as PDF, or cancels — no fixed timeout
 * guessing how long the dialog stays open.
 */
export type PrintTarget = "competitor-analysis" | "grant-proposal-prompt";

export function printElement(target: PrintTarget): void {
  if (typeof document === "undefined") return;
  document.body.setAttribute("data-print-target", target);
  const cleanup = () => {
    document.body.removeAttribute("data-print-target");
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
}
