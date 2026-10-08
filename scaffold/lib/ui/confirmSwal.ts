import Swal from "sweetalert2";

/**
 * A themed SweetAlert2 confirm for "Enable grants for <state>?" (triggered
 * by typing a supported state into the location field -- see
 * components/ProfileQuestionnaire.tsx). Styled to match the app's own
 * primary/secondary button classes (same primaryButtonClass/
 * secondaryButtonClass tokens as the "Find opportunities" button) via
 * `buttonsStyling: false` + `customClass`, rather than swal2's default
 * look -- CON-02 tokens (bg-action/bg-canvas/text-foreground/etc.) are
 * CSS-variable-backed and flip for dark mode automatically, same as every
 * other themed element in this app.
 *
 * Resolves `true` on confirm, `false` on cancel OR any dismissal (Escape,
 * backdrop click, closed) -- never throws. Matches
 * components/ProblemsSection.tsx's confirmClear's same "an interrupted
 * confirm is a no" contract, swal2's async version of that native dialog.
 */
export async function confirmEnableState(stateLabel: string): Promise<boolean> {
  const result = await Swal.fire({
    title: `Enable grants for ${stateLabel}?`,
    text: `Granted can fetch ${stateLabel}'s own grant programs alongside the federal ones, and pull them in now before you search.`,
    showCancelButton: true,
    confirmButtonText: "Enable",
    cancelButtonText: "Not now",
    reverseButtons: true,
    buttonsStyling: false,
    background: "var(--color-canvas)",
    color: "var(--color-foreground)",
    customClass: {
      popup: "rounded-sm",
      title: "font-display text-[18px] font-bold",
      htmlContainer: "font-body text-[14px]",
      actions: "gap-3",
      confirmButton:
        "min-h-[44px] rounded-sm bg-action px-5 py-2.5 font-mono text-[12px] uppercase tracking-eyebrow text-token-white shadow-sm transition hover:opacity-90",
      cancelButton:
        "min-h-[44px] rounded-sm border border-structure-on-canvas bg-canvas-alt px-4 py-2.5 font-mono text-[12px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white",
    },
  });
  return result.isConfirmed === true;
}
