"use client";

/**
 * AppSidebar.tsx — FE-07 PERSISTENT, collapsible left sidebar (claude.ai-style),
 * gated behind the default-OFF `left_sidebar` flag (entry point in AppMenu).
 *
 * This replaced the old overlay-only drawer. On desktop (>= md) it is a docked
 * <aside> that sits BESIDE the content (the content column shifts right by the
 * sidebar width — see app/page.tsx + the `.app-content-shift` rule in
 * globals.css). It collapses via the header's bare (un-boxed) sidebar icon,
 * leaving a small floating re-open affordance; the expanded/width/open-section
 * state persists in localStorage (lib/sidebar/sidebarPrefs + SidebarProvider).
 * On mobile (< md) it is an overlay drawer with the useDialogA11y focus-trap —
 * a persistent sidebar is NOT modal, so the trap applies to the overlay case
 * ONLY.
 *
 * Everything here stays LOCAL-ONLY (localStorage) and gates/charges NOTHING. The
 * billing section is an explicitly-labeled MOCK with no real payment (§11); the
 * auto-fill / competitor previews it unlocks remain honest previews that submit
 * nothing (§5.3 — no server retention).
 *
 * Token-styled throughout (CON-02 60/30/10, darkMode "media"), no raw hex. The
 * collapse/slide transition is a CSS transform/padding transition; the global
 * prefers-reduced-motion rule in globals.css disables it, and no sidebar state
 * is ever conveyed by motion alone.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { BRAND } from "@/lib/brand";
import { useAuth } from "@/components/AuthProvider";
import { useBilling } from "@/components/BillingProvider";
import { isFlagEnabled } from "@/lib/flags";
import { useSearchDraft } from "@/components/SearchDraftProvider";
import { useDialogA11y } from "@/components/useDialogA11y";
import { useMediaQuery } from "@/components/useMediaQuery";
import { useSidebar } from "@/components/SidebarProvider";
import SettingsForm from "@/components/SettingsForm";
import { clearAllLocalData } from "@/lib/mockAuth";
import { BILLING_TIERS, type BillingTier } from "@/lib/billing/mockBilling";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  type SidebarSectionId,
} from "@/lib/sidebar/sidebarPrefs";
import {
  getGrants,
  addGrant,
  setGrantStatus,
  removeGrant,
  type Grant,
  type GrantStatus,
} from "@/lib/grants/grantsStore";
import {
  getDescriptions,
  createDescription,
  renameDescription,
  deleteDescription,
  saveVersion,
  setActiveVersion,
  type CompanyDescription,
} from "@/lib/descriptions/descriptionsStore";

const STATUS_LABEL: Record<GrantStatus, string> = {
  unapplied: "Unapplied for",
  pending: "Pending",
  granted: "Granted",
};
const STATUS_ORDER: GrantStatus[] = ["unapplied", "pending", "granted"];

// ---- shared token class strings -------------------------------------------
const bodyClass = "px-4 pb-5 pt-1";
const noteClass = "font-body text-[12px] leading-relaxed text-foreground";
const sectionLabelClass =
  "font-mono text-[12px] uppercase tracking-eyebrow text-foreground";
const inputClass =
  "w-full rounded-sm border border-structure-on-canvas/40 bg-canvas px-2.5 py-1.5 font-body text-[13px] text-foreground outline-none transition focus:border-structure-on-canvas focus:ring-2 focus:ring-structure-on-canvas";
const btnClass =
  "shrink-0 rounded-sm border border-structure-on-canvas px-3 py-1.5 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
const linkBtnClass =
  "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas underline underline-offset-4 transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
const dangerBtnClass =
  "rounded-sm border border-error px-3 py-1.5 font-mono text-[11px] uppercase tracking-eyebrow text-foreground transition hover:bg-error hover:text-token-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
const selectClass =
  "rounded-sm border border-structure-on-canvas/40 bg-canvas px-2 py-1 font-mono text-[11px] text-foreground";
const rowCardClass = "rounded-sm border border-structure-on-canvas/20 bg-canvas-alt p-3";
const versionRowClass = "rounded-sm border border-structure-on-canvas/20 bg-canvas p-2.5";
const emptyStateClass =
  "mt-3 rounded-sm border border-dashed border-structure-on-canvas/40 px-3 py-5 text-center";
// Hover-revealed row actions: always visible on touch (no hover), fade in on
// pointer devices when the row is hovered OR anything inside it is focused
// (keyboard-accessible).
const rowActionReveal =
  "flex items-center gap-3 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100";
// Bare (un-boxed) icon control — NO border at rest, just a subtle hover wash.
const iconBtnClass =
  "flex h-9 w-9 items-center justify-center rounded-sm text-structure-on-canvas transition hover:bg-canvas-alt active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas";

function tierCardClass(active: boolean) {
  const base =
    "flex w-full flex-col gap-1 rounded-sm border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-structure-on-canvas";
  return `${base} ${active ? "border-structure-on-canvas bg-canvas-alt" : "border-structure-on-canvas/40 bg-canvas hover:bg-canvas-alt"}`;
}

// ---------------------------------------------------------------------------
// Entry point: pick the docked (desktop) vs overlay (mobile) presentation.
// Exactly one is mounted at a time, so the section state below has a single
// instance (no cross-presentation desync). Both are additionally CSS-guarded
// (hidden md:* / md:hidden) so the first-paint default never flashes the wrong
// one before useMediaQuery resolves.
// ---------------------------------------------------------------------------
export default function AppSidebar() {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  return isDesktop ? <DockedSidebar /> : <MobileSidebar />;
}

// ---------------------------------------------------------------------------
// Desktop: docked, collapsible, resizable.
// ---------------------------------------------------------------------------
function DockedSidebar() {
  const { expanded, width, setExpanded, setWidth, setResizing } = useSidebar();
  const asideRef = useRef<HTMLElement>(null);

  // When collapsed, make the off-screen sidebar inert so its controls leave the
  // tab order and the accessibility tree while it stays mounted for the slide.
  useEffect(() => {
    const el = asideRef.current;
    if (el) el.inert = !expanded;
  }, [expanded]);

  // Resize handle (pointer + keyboard). The aside is anchored at left:0, so the
  // dragged width is simply the pointer's clientX (clamped by setWidth).
  const draggingRef = useRef(false);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      draggingRef.current = true;
      setResizing(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [setResizing],
  );
  const onHandlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      setWidth(e.clientX);
    },
    [setWidth],
  );
  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setResizing(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    },
    [setResizing],
  );
  const onHandleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const STEP = 16;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setWidth(width - STEP);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setWidth(width + STEP);
      } else if (e.key === "Home") {
        e.preventDefault();
        setWidth(SIDEBAR_MIN_WIDTH);
      } else if (e.key === "End") {
        e.preventDefault();
        setWidth(SIDEBAR_MAX_WIDTH);
      }
    },
    [setWidth, width],
  );

  return (
    <>
      <aside
        ref={asideRef}
        aria-label="Account and settings"
        style={{ width }}
        className={`fixed inset-y-0 left-0 z-40 hidden flex-col overflow-hidden border-r border-structure-on-canvas/25 bg-canvas text-foreground shadow-overlay transition-transform duration-200 ease-out md:flex ${expanded ? "translate-x-0" : "-translate-x-full"}`}
      >
        <SidebarHeader
          onRightAction={() => setExpanded(false)}
          rightIcon={<PanelLeftIcon className="h-[18px] w-[18px]" />}
          rightLabel="Collapse sidebar"
        />
        <div className="flex-1 overflow-y-auto">
          <SidebarSections />
        </div>

        {/* Resize handle on the right edge. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={width}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          tabIndex={0}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onHandleKeyDown}
          className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize touch-none select-none transition-colors hover:bg-structure-on-canvas/30 focus-visible:bg-structure-on-canvas/40 focus-visible:outline-none"
        />
      </aside>

      {/* Collapsed → bare (un-boxed) floating re-open affordance, top-left. */}
      {!expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label="Open sidebar"
          className={`fixed left-3 top-3 z-40 hidden md:flex ${iconBtnClass}`}
        >
          <PanelLeftIcon className="h-[18px] w-[18px]" />
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Mobile: a bare menu button + an overlay drawer (modal, focus-trapped).
// ---------------------------------------------------------------------------
function MobileSidebar() {
  const { mobileOpen, setMobileOpen } = useSidebar();
  return (
    <>
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={mobileOpen}
        aria-label="Open menu"
        className={`fixed left-3 top-3 z-40 flex md:hidden ${iconBtnClass}`}
      >
        <PanelLeftIcon className="h-[18px] w-[18px]" />
      </button>
      {mobileOpen && <MobileOverlay onClose={() => setMobileOpen(false)} />}
    </>
  );
}

function MobileOverlay({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  // Focus-trap + scroll-lock + return-focus — ONLY for this overlay (modal) case.
  useDialogA11y(dialogRef, onClose, closeBtnRef);

  return (
    <div className="fixed inset-0 z-50 flex overflow-hidden md:hidden">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Account and settings"
        className="relative z-10 flex h-full w-full max-w-[320px] flex-col overflow-hidden border-r border-structure-on-canvas/25 bg-canvas text-foreground shadow-overlay"
      >
        <SidebarHeader
          rightRef={closeBtnRef}
          onRightAction={onClose}
          rightIcon={<XIcon className="h-4 w-4" />}
          rightLabel="Close menu"
        />
        <div className="flex-1 overflow-y-auto">
          <SidebarSections />
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared header: "Granted" wordmark LEFT, bare (un-boxed) control at the RIGHT
// edge (collapse on desktop, close on mobile).
// ---------------------------------------------------------------------------
function SidebarHeader({
  onRightAction,
  rightIcon,
  rightLabel,
  rightRef,
}: {
  onRightAction: () => void;
  rightIcon: React.ReactNode;
  rightLabel: string;
  rightRef?: React.RefObject<HTMLButtonElement>;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-structure-on-canvas/15 px-4 py-3">
      {/* Banner wordmark. Navy-on-transparent → crisp on the light canvas; the
          dark-mode filter renders it white so it stays legible in dark mode. */}
      <img
        src="/brand/logo-banner.png"
        alt={BRAND}
        className="h-6 w-auto select-none dark:brightness-0 dark:invert"
      />
      <button
        ref={rightRef}
        type="button"
        onClick={onRightAction}
        aria-label={rightLabel}
        className={iconBtnClass}
      >
        {rightIcon}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A single collapsible section (claude.ai-style): header row with a rotating
// chevron + label, an optional right-aligned action, and collapsible content.
// Each toggles independently (per-section state in SidebarProvider).
// ---------------------------------------------------------------------------
function Section({
  id,
  label,
  action,
  children,
}: {
  id: SidebarSectionId;
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { openSections, toggleSection } = useSidebar();
  const isOpen = openSections[id];
  const contentId = `sidebar-section-${id}`;
  return (
    <section className="border-t border-structure-on-canvas/15">
      <div className="flex items-center pr-2">
        <button
          type="button"
          onClick={() => toggleSection(id)}
          aria-expanded={isOpen}
          aria-controls={contentId}
          className="flex flex-1 items-center gap-2 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-structure-on-canvas"
        >
          <Chevron
            className={`h-3.5 w-3.5 shrink-0 text-structure-on-canvas transition-transform ${
              isOpen ? "rotate-90" : ""
            }`}
          />
          <span className={sectionLabelClass}>{label}</span>
        </button>
        {action}
      </div>
      {isOpen && (
        <div id={contentId} className={bodyClass}>
          {children}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The five sections. One instance (mounted in exactly one presentation).
// ---------------------------------------------------------------------------
function SidebarSections() {
  const { setMobileOpen, setSectionOpen } = useSidebar();
  const { user, consent, signOut, setConsent } = useAuth();
  const { tier, setTier } = useBilling();
  const { requestSearchDraft } = useSearchDraft();

  // Local stores (SSR-safe: start empty, hydrate after mount).
  const [grants, setGrants] = useState<Grant[]>([]);
  const [descriptions, setDescriptions] = useState<CompanyDescription[]>([]);

  const [newGrantTitle, setNewGrantTitle] = useState("");
  const [newDescName, setNewDescName] = useState("");
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editingNameValue, setEditingNameValue] = useState("");
  const [versionDrafts, setVersionDrafts] = useState<Record<string, string>>({});
  // Per-description delete confirm: Delete wipes a description AND all its saved
  // versions with no undo, so require an explicit confirm (frontend review
  // MEDIUM) — consistent with the drawer's "Delete my data"/"Close account".
  const [confirmDeleteDescId, setConfirmDeleteDescId] = useState<string | null>(null);

  const [confirming, setConfirming] = useState<null | "delete" | "close">(null);
  const [justCleared, setJustCleared] = useState(false);

  const grantInputRef = useRef<HTMLInputElement>(null);
  const descInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setGrants(getGrants());
    setDescriptions(getDescriptions());
  }, []);

  /** Close the mobile overlay after an action that navigates away or hands off
   *  to the main content. A no-op on desktop (the docked sidebar stays open). */
  const closeDrawer = useCallback(() => setMobileOpen(false), [setMobileOpen]);

  function handleAddGrant(e: React.FormEvent) {
    e.preventDefault();
    if (newGrantTitle.trim().length === 0) return;
    setGrants(addGrant(newGrantTitle));
    setNewGrantTitle("");
  }

  function handleCreateDescription(e: React.FormEvent) {
    e.preventDefault();
    if (newDescName.trim().length === 0) return;
    setDescriptions(createDescription(newDescName));
    setNewDescName("");
  }

  function handleSaveVersion(descId: string) {
    const draft = versionDrafts[descId] ?? "";
    if (draft.trim().length === 0) return;
    setDescriptions(saveVersion(descId, draft));
    setVersionDrafts((prev) => ({ ...prev, [descId]: "" }));
  }

  function handleRestore(descId: string, versionId: string, text: string) {
    setDescriptions(setActiveVersion(descId, versionId));
    setVersionDrafts((prev) => ({ ...prev, [descId]: text }));
  }

  function handleUseThis(text: string) {
    requestSearchDraft(text);
    closeDrawer();
  }

  function resetLocalStateAfterClear() {
    setGrants([]);
    setDescriptions([]);
    setVersionDrafts({});
    setTier("free");
    signOut();
    setConsent(false);
    setConfirming(null);
  }

  function handleDeleteMyData() {
    clearAllLocalData();
    resetLocalStateAfterClear();
    setJustCleared(true);
  }

  function handleCloseAccount() {
    clearAllLocalData();
    resetLocalStateAfterClear();
    setJustCleared(true);
  }

  /** Section-header "＋" action: ensure the section is open, then focus its input. */
  function addAction(id: SidebarSectionId, ref: React.RefObject<HTMLInputElement>, label: string) {
    return (
      <button
        type="button"
        aria-label={label}
        onClick={() => {
          setSectionOpen(id, true);
          requestAnimationFrame(() => ref.current?.focus());
        }}
        className={iconBtnClass}
      >
        <PlusIcon className="h-4 w-4" />
      </button>
    );
  }

  return (
    <>
      {/* 1 — Auto Fill Settings ------------------------------------------- */}
      <Section id="settings" label="Auto Fill Settings">
        <p className={noteClass}>
          Auto-fill requirements — stored on this device only, never sent to a server.
        </p>
        <SettingsForm />

        <div className="mt-4 border-t border-structure-on-canvas/15 pt-4">
          <label className="flex cursor-pointer items-start gap-2.5 text-pretty font-body text-[13px] leading-relaxed text-foreground">
            <input
              type="checkbox"
              checked={consent.granted}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-structure"
            />
            <span>Opt in to sharing anonymized usage data</span>
          </label>
          {consent.granted && consent.grantedAt && (
            <p className="mt-1.5 pl-[26px] font-mono text-[11px] tabular-nums text-foreground">
              Opted in {new Date(consent.grantedAt).toLocaleString()}.
            </p>
          )}
        </div>
      </Section>

      {/* 2 — Grants applied for ------------------------------------------- */}
      <Section
        id="grants"
        label="Grants applied for"
        action={addAction("grants", grantInputRef, "Add a grant")}
      >
        <form onSubmit={handleAddGrant} className="flex items-center gap-2">
          <input
            ref={grantInputRef}
            type="text"
            value={newGrantTitle}
            onChange={(e) => setNewGrantTitle(e.target.value)}
            placeholder="Track a grant by title"
            aria-label="Grant title"
            className={inputClass}
          />
          <button type="submit" className={btnClass}>
            Add
          </button>
        </form>

        {grants.length === 0 ? (
          <div className={emptyStateClass}>
            <p className="font-body text-[13px] font-medium text-foreground">
              No grants tracked yet
            </p>
            <p className={`mt-1 ${noteClass}`}>
              Add a grant above to keep it on this device.
            </p>
          </div>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {grants.map((g) => (
              <li key={g.id} className={`group ${rowCardClass}`}>
                <p className="font-body text-[13px] text-foreground">{g.title}</p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <label className="flex items-center gap-1.5">
                    <span className="sr-only">Status for {g.title}</span>
                    <select
                      value={g.status}
                      onChange={(e) =>
                        setGrants(setGrantStatus(g.id, e.target.value as GrantStatus))
                      }
                      className={selectClass}
                    >
                      {STATUS_ORDER.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className={rowActionReveal}>
                    <button
                      type="button"
                      onClick={() => setGrants(removeGrant(g.id))}
                      aria-label={`Remove ${g.title}`}
                      className={linkBtnClass}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 3 — Company descriptions ----------------------------------------- */}
      <Section
        id="descriptions"
        label="Company descriptions"
        action={addAction("descriptions", descInputRef, "Add a description")}
      >
        <form onSubmit={handleCreateDescription} className="flex items-center gap-2">
          <input
            ref={descInputRef}
            type="text"
            value={newDescName}
            onChange={(e) => setNewDescName(e.target.value)}
            placeholder="New description name"
            aria-label="New description name"
            className={inputClass}
          />
          <button type="submit" className={btnClass}>
            Create
          </button>
        </form>

        {descriptions.length === 0 ? (
          <div className={emptyStateClass}>
            <p className="font-body text-[13px] font-medium text-foreground">
              No saved descriptions yet
            </p>
            <p className={`mt-1 ${noteClass}`}>
              Create one to reuse it across searches.
            </p>
          </div>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {descriptions.map((d) => (
              <li key={d.id} className={`group ${rowCardClass}`}>
                <div className="flex items-center justify-between gap-2">
                  {editingNameId === d.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        setDescriptions(renameDescription(d.id, editingNameValue));
                        setEditingNameId(null);
                      }}
                      className="flex flex-1 items-center gap-2"
                    >
                      <input
                        type="text"
                        value={editingNameValue}
                        onChange={(e) => setEditingNameValue(e.target.value)}
                        aria-label="Rename description"
                        className={inputClass}
                      />
                      <button type="submit" className={btnClass}>
                        Save
                      </button>
                    </form>
                  ) : (
                    <>
                      <p className="font-body text-[14px] font-medium text-foreground">
                        {d.name}
                      </p>
                      <div className={rowActionReveal}>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingNameId(d.id);
                            setEditingNameValue(d.name);
                          }}
                          aria-label={`Rename ${d.name}`}
                          className={linkBtnClass}
                        >
                          Rename
                        </button>
                        {confirmDeleteDescId === d.id ? (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setDescriptions(deleteDescription(d.id));
                                setConfirmDeleteDescId(null);
                              }}
                              aria-label={`Confirm delete ${d.name} and all its versions`}
                              className={dangerBtnClass}
                            >
                              Delete all versions
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteDescId(null)}
                              aria-label="Cancel delete"
                              className={linkBtnClass}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteDescId(d.id)}
                            aria-label={`Delete ${d.name}`}
                            className={linkBtnClass}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div className="mt-2">
                  <textarea
                    value={versionDrafts[d.id] ?? ""}
                    onChange={(e) =>
                      setVersionDrafts((prev) => ({ ...prev, [d.id]: e.target.value }))
                    }
                    rows={3}
                    placeholder="Write or paste a company description…"
                    aria-label={`New version for ${d.name}`}
                    className={`resize-none ${inputClass}`}
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleSaveVersion(d.id)}
                      className={btnClass}
                    >
                      Save version
                    </button>
                  </div>
                </div>

                {d.versions.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-2">
                    {d.versions
                      .slice()
                      .reverse()
                      .map((v) => {
                        const isActive = d.activeVersionId === v.id;
                        return (
                          <li key={v.id} className={versionRowClass}>
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-[10px] text-foreground">
                                {new Date(v.createdAt).toLocaleString()}
                                {isActive ? " · active" : ""}
                              </span>
                            </div>
                            <p className="mt-1 whitespace-pre-wrap font-body text-[12px] leading-relaxed text-foreground">
                              {v.text}
                            </p>
                            <div className="mt-2 flex items-center gap-3">
                              <button
                                type="button"
                                onClick={() => handleRestore(d.id, v.id, v.text)}
                                className={linkBtnClass}
                              >
                                Restore
                              </button>
                              <button
                                type="button"
                                onClick={() => handleUseThis(v.text)}
                                className={btnClass}
                              >
                                Use this
                              </button>
                            </div>
                          </li>
                        );
                      })}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 4 — Account ------------------------------------------------------ */}
      <Section id="account" label="Account">
        <div className="flex flex-col gap-3">
          {/* Identity + sign in/out (moved here from the top-right nav) */}
          {user ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- external avatar; referrerPolicy avoids Google's 403 */}
              <img
                src={user.avatarUrl}
                alt=""
                width={36}
                height={36}
                referrerPolicy="no-referrer"
                className="h-9 w-9 rounded-full"
              />
              <p className="min-w-0 truncate font-body text-[13px] font-medium text-foreground">
                {user.name}
              </p>
            </div>
          ) : (
            <a href="/login" data-tour="signin" onClick={closeDrawer} className={`self-start ${btnClass}`}>
              Sign in
            </a>
          )}

          {/* Delete my data */}
          {confirming === "delete" ? (
            <div className={rowCardClass} role="group" aria-label="Confirm delete my data">
              <p className={noteClass}>
                Delete all locally-stored data (settings, grants, descriptions, tier, sign-in)?
                This can&apos;t be undone.
              </p>
              <div className="mt-2 flex items-center gap-3">
                <button type="button" onClick={handleDeleteMyData} className={dangerBtnClass}>
                  Confirm delete
                </button>
                <button type="button" onClick={() => setConfirming(null)} className={linkBtnClass}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setJustCleared(false);
                setConfirming("delete");
              }}
              className={`self-start ${dangerBtnClass}`}
            >
              Delete my data
            </button>
          )}

          {/* Close account */}
          {confirming === "close" ? (
            <div className={rowCardClass} role="group" aria-label="Confirm close account">
              <p className={noteClass}>
                Close this (mock) account? This clears all local data and signs you out. No
                server is contacted.
              </p>
              <div className="mt-2 flex items-center gap-3">
                <button type="button" onClick={handleCloseAccount} className={dangerBtnClass}>
                  Confirm close
                </button>
                <button type="button" onClick={() => setConfirming(null)} className={linkBtnClass}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setJustCleared(false);
                setConfirming("close");
              }}
              className={`self-start ${dangerBtnClass}`}
            >
              Close account
            </button>
          )}

          {/* Log out — only when signed in */}
          {user && (
            <button type="button" onClick={() => signOut()} className={`self-start ${btnClass}`}>
              Log out
            </button>
          )}

          {justCleared && (
            <p
              className="font-mono text-[11px] text-structure-on-canvas"
              aria-live="polite"
            >
              Local data cleared.
            </p>
          )}
        </div>
      </Section>

      {/* 5 — Billing (MOCK) — hidden unless commercial_ui is on ----------- */}
      {isFlagEnabled("commercial_ui") && (
      <Section id="billing" label="Billing">
        <p className={noteClass}>
          Mock plans — selecting one is a local demo switch only. No payment is taken and no
          server is contacted. It just previews how each plan would unlock features.
        </p>
        <ul className="mt-3 flex flex-col gap-2">
          {BILLING_TIERS.map((t) => {
            const active = tier === t.id;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setTier(t.id as BillingTier)}
                  aria-pressed={active}
                  className={tierCardClass(active)}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[12px] uppercase tracking-eyebrow text-foreground">
                      {t.label}
                      {active ? " · current" : ""}
                    </span>
                    <span className="font-display text-[15px] font-bold text-foreground">
                      {t.priceLabel}
                    </span>
                  </span>
                  <span className="font-body text-[12px] leading-relaxed text-foreground">
                    {t.blurb}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className={`mt-3 ${noteClass}`}>This is a mock. No real charge, ever.</p>
      </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
function Chevron({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

function PanelLeftIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
