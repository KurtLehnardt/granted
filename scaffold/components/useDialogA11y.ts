"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * FE-06 — shared accessible-dialog behavior for AutoFillModal and
 * SettingsPanel (kept as a hook rather than duplicated in both so the
 * focus-trap logic only has to be gotten right once).
 *
 * On mount: focuses `initialFocusRef` (falls back to the first focusable
 * descendant of `dialogRef`), locks body scroll, and starts trapping Tab
 * within the dialog. Esc calls `onClose`. On unmount: releases the scroll
 * lock and returns focus to whatever element had it before the dialog
 * opened (the trigger button), so keyboard/screen-reader users land back
 * where they started.
 *
 * Deliberately does not animate anything — see app/globals.css's
 * `prefers-reduced-motion` rule and FE-06's note not to add motion that
 * could mask a state change (e.g. delay conveying which requirements are
 * already on file).
 */
export function useDialogA11y(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>
) {
  // Keep the LATEST onClose in a ref so the setup effect can run ONCE on
  // mount/unmount without re-running when onClose's identity changes. Previously
  // the effect depended on `[onClose]`, so a caller that passes a fresh arrow
  // each render (e.g. the drawer, whose parent re-renders on consent/user
  // change) tore the effect down and back up mid-interaction — yanking focus to
  // the Close button and overwriting `previouslyFocused` with an in-dialog
  // control, so final close returned focus to the wrong (often unmounted)
  // element (frontend review MEDIUM: drawer focus regression).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    function getFocusable(): HTMLElement[] {
      if (!dialog) return [];
      return Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
    }

    (initialFocusRef?.current ?? getFocusable()[0])?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Hide the rest of the page from assistive tech while the dialog is open
    // (frontend review MEDIUM: `aria-modal` alone doesn't stop an SR virtual
    // cursor from browsing the background). Mark every direct <body> child that
    // does NOT contain the dialog as `inert` + aria-hidden. For a portaled
    // dialog (a body-level sibling) this covers the whole app; for an inline
    // dialog the child containing it is skipped, so the dialog is never inerted.
    const inerted: HTMLElement[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child instanceof HTMLElement && !child.contains(dialog) && !child.hasAttribute("inert")) {
        child.setAttribute("inert", "");
        child.setAttribute("aria-hidden", "true");
        inerted.push(child);
      }
    }

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
      // Un-inert BEFORE restoring focus so focus can land on the trigger.
      for (const el of inerted) {
        el.removeAttribute("inert");
        el.removeAttribute("aria-hidden");
      }
      previouslyFocused?.focus();
    };
    // Mount/unmount only — onClose is read via onCloseRef so an identity change
    // no longer tears down focus management. dialogRef/initialFocusRef are refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
