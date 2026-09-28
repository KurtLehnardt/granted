import { useCallback, useEffect, useState } from "react";
import { validateImport } from "../lib/packageValidator";
import type { AssembledPackage } from "../lib/contracts/package";
import { resolvePortalForUrl, type PortalFieldMap } from "../config";
import { isTerminalStep, type StepDetection, type AdvanceOutcome } from "../content/navigator";
import type { FillResult, FillSummary } from "../content/fillEngine";
import {
  IMPORT_SCREEN,
  REVIEW_SCREEN,
  FILL_PROGRESS_SCREEN,
  FILL_OUTCOME_LABELS,
  NAVIGATE_SCREEN,
  TERMINAL_SCREEN,
  CLEAR_PACKAGE,
} from "./copy";

const PACKAGE_STORAGE_KEY = "grantedPackage";

type Screen = "import" | "main" | "terminal";

interface StoredPackage {
  opportunity_id: string;
  program_title: string;
  payload: AssembledPackage;
}

/**
 * The popup (spec §5). Screens: Import → Review → Fill/Progress → Navigate →
 * terminal "Review & submit via your authorized AOR", which shows the
 * verbatim AOR_HANDOFF panel.
 *
 * No control in this component can trigger a portal submit. This component
 * only ever: imports (client-side validation, spec §6.3), asks the content
 * script to fill the CURRENT step, asks it to advance (both are the ONLY two
 * actions that touch the portal page, and both are always in direct
 * response to a click here), and clears the stored package.
 */
export function Popup(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>("import");
  const [pkg, setPkg] = useState<StoredPackage | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const [fieldMap, setFieldMap] = useState<PortalFieldMap | undefined>(undefined);
  const [stepDetection, setStepDetection] = useState<StepDetection | null>(null);
  const [portalError, setPortalError] = useState<string | null>(null);

  const [fillResults, setFillResults] = useState<FillResult[] | null>(null);
  const [fillSummary, setFillSummary] = useState<FillSummary | null>(null);
  const [fillBusy, setFillBusy] = useState(false);
  const [advanceMessage, setAdvanceMessage] = useState<string | null>(null);

  // Load any previously-imported package from session storage on mount.
  useEffect(() => {
    chrome.storage.session.get(PACKAGE_STORAGE_KEY).then((stored) => {
      const value = stored[PACKAGE_STORAGE_KEY] as StoredPackage | undefined;
      if (value) {
        setPkg(value);
        setScreen("main");
      }
    });
  }, []);

  const refreshPortalStatus = useCallback(async () => {
    setPortalError(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) {
        setPortalError("Open a supported portal tab (grants.gov, research.gov, ASSIST, sbir.gov) to continue.");
        return;
      }
      const map = resolvePortalForUrl(tab.url);
      setFieldMap(map);
      if (!map) {
        setPortalError("This page isn't one of the supported grant portals.");
        return;
      }
      if (!tab.id) return;
      const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_PORTAL_STATUS" }).catch(() => null);
      if (!response || response.ok !== true) {
        setPortalError("Couldn't reach this tab. Reload the portal page and reopen this popup.");
        return;
      }
      setStepDetection(response.step as StepDetection);
    } catch {
      setPortalError("Couldn't determine the active tab. Try reopening the popup.");
    }
  }, []);

  useEffect(() => {
    if (screen === "main") void refreshPortalStatus();
  }, [screen, refreshPortalStatus]);

  const doImport = useCallback(
    async (raw: string) => {
      setImportBusy(true);
      setImportError(null);
      try {
        const result = await validateImport(raw);
        if (!result.ok) {
          setImportError(`${IMPORT_SCREEN.failurePrefix} (${result.message})`);
          return;
        }
        const stored: StoredPackage = {
          opportunity_id: result.envelope.opportunity_id,
          program_title: result.envelope.program_title,
          payload: result.envelope.payload,
        };
        await chrome.storage.session.set({ [PACKAGE_STORAGE_KEY]: stored });
        setPkg(stored);
        setScreen("main");
      } finally {
        setImportBusy(false);
      }
    },
    [],
  );

  const onFileChosen = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      file.text().then((text) => void doImport(text));
    },
    [doImport],
  );

  const onFillThisPage = useCallback(async () => {
    if (!pkg || !fieldMap || stepDetection?.status !== "known") return;
    setFillBusy(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      const response = await chrome.tabs
        .sendMessage(tab.id, { type: "FILL_STEP", pkg: pkg.payload, stepId: stepDetection.step.stepId })
        .catch(() => null);
      if (response?.ok) {
        setFillResults(response.result.results as FillResult[]);
        setFillSummary(response.result.summary as FillSummary);
      } else {
        setPortalError("Couldn't fill this page. Reload the portal tab and try again.");
      }
    } finally {
      setFillBusy(false);
    }
  }, [pkg, fieldMap, stepDetection]);

  const onAdvance = useCallback(async () => {
    setAdvanceMessage(null);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const response = await chrome.tabs.sendMessage(tab.id, { type: "ADVANCE_STEP" }).catch(() => null);
    if (!response?.ok) {
      setAdvanceMessage(NAVIGATE_SCREEN.unknownStepMessage);
      return;
    }
    const outcome = response.outcome as AdvanceOutcome;
    if (!outcome.advanced) {
      if (outcome.reason === "blocked_by_submit_guard" || outcome.reason === "terminal_step") {
        setScreen("terminal");
      } else if (outcome.reason === "no_current_step") {
        setAdvanceMessage(NAVIGATE_SCREEN.unknownStepMessage);
      } else {
        setAdvanceMessage("Couldn't find the next-section control on this page.");
      }
      return;
    }
    setFillResults(null);
    setFillSummary(null);
    await refreshPortalStatus();
  }, [refreshPortalStatus]);

  const onClearPackage = useCallback(async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_PACKAGE" }).catch(() => undefined);
    setPkg(null);
    setFillResults(null);
    setFillSummary(null);
    setScreen("import");
  }, []);

  // NOTE (spec §4.4): when the current step is the last enumerated step, we
  // deliberately do NOT auto-switch to the terminal screen here — the final
  // step is never auto-advanced. The terminal panel is reached only when the
  // human clicks "Go to next section" (`onAdvance`) and the navigator itself
  // reports `terminal_step` / `blocked_by_submit_guard`.
  const showTerminalHint =
    screen === "main" && fieldMap !== undefined && stepDetection?.status === "known" && isTerminalStep(fieldMap, stepDetection.step);

  return (
    <div style={{ padding: 16 }}>
      <header style={{ marginBottom: 12 }}>
        <strong>Granted Assisted Fill</strong>
      </header>

      {screen === "import" && (
        <section>
          <h2 style={{ fontSize: 14 }}>{IMPORT_SCREEN.title}</h2>
          <label style={{ display: "block", marginBottom: 8 }}>
            {IMPORT_SCREEN.filePickerLabel}
            <input type="file" accept=".json,.granted.json" onChange={onFileChosen} disabled={importBusy} />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            {IMPORT_SCREEN.pasteLabel}
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={4}
              style={{ width: "100%" }}
            />
          </label>
          <button disabled={importBusy || pasteText.trim().length === 0} onClick={() => void doImport(pasteText)}>
            {IMPORT_SCREEN.importButton}
          </button>
          {importError && (
            <p role="alert" style={{ color: "#991b1b", fontSize: 12 }}>
              {importError}
            </p>
          )}
        </section>
      )}

      {screen === "main" && pkg && (
        <section>
          <h2 style={{ fontSize: 14 }}>{pkg.program_title}</h2>

          {portalError && (
            <p role="alert" style={{ color: "#991b1b", fontSize: 12 }}>
              {portalError}
            </p>
          )}

          {fieldMap && stepDetection?.status === "known" && (
            <>
              <p style={{ fontSize: 12, color: "#374151" }}>
                Section: <strong>{stepDetection.step.title}</strong>
              </p>

              <ReviewList fieldMap={fieldMap} stepId={stepDetection.step.stepId} pkg={pkg.payload} />

              <button disabled={fillBusy} onClick={() => void onFillThisPage()}>
                {FILL_PROGRESS_SCREEN.fillButton}
              </button>

              {fillSummary && (
                <p style={{ fontSize: 12 }}>
                  {FILL_PROGRESS_SCREEN.summaryLine(
                    fillSummary.filledVerified + fillSummary.filledUnverified,
                    fillSummary.gaps,
                    fillSummary.unmapped,
                  )}
                </p>
              )}

              {fillResults && (
                <ul style={{ fontSize: 12, paddingLeft: 16 }}>
                  {fillResults.map((r, i) => (
                    <li key={`${r.packageKey ?? "portal"}-${i}`}>
                      {r.label}: {FILL_OUTCOME_LABELS[r.outcome]}
                    </li>
                  ))}
                </ul>
              )}

              <div style={{ marginTop: 12 }}>
                {showTerminalHint && (
                  <p style={{ fontSize: 12, color: "#6b7280" }}>
                    This is the last section. Review it, then continue.
                  </p>
                )}
                <button onClick={() => void onAdvance()}>{NAVIGATE_SCREEN.nextButton}</button>
                {advanceMessage && (
                  <p role="alert" style={{ color: "#991b1b", fontSize: 12 }}>
                    {advanceMessage}
                  </p>
                )}
              </div>
            </>
          )}

          {fieldMap && stepDetection?.status === "unknown" && (
            <p style={{ fontSize: 12 }}>{NAVIGATE_SCREEN.unknownStepMessage}</p>
          )}

          <div style={{ marginTop: 16 }}>
            <button onClick={() => void onClearPackage()}>{CLEAR_PACKAGE.button}</button>
          </div>
        </section>
      )}

      {screen === "terminal" && (
        <section>
          <p style={{ fontSize: 11, textTransform: "uppercase", color: "#6b7280" }}>{TERMINAL_SCREEN.eyebrow}</p>
          <h2 style={{ fontSize: 16 }}>{TERMINAL_SCREEN.headline}</h2>
          <p style={{ fontSize: 13 }}>{TERMINAL_SCREEN.body}</p>
          <button onClick={() => setScreen("main")}>Back to review</button>
        </section>
      )}
    </div>
  );
}

/** Per-field review list (spec §5.1 step 2): grounded vs. gap vs. excluded. */
function ReviewList({
  fieldMap,
  stepId,
  pkg,
}: {
  fieldMap: PortalFieldMap;
  stepId: string;
  pkg: AssembledPackage;
}): React.JSX.Element {
  const fieldsForStep = fieldMap.fields.filter((f) => f.stepId === stepId);
  const packageFields = pkg.forms.forms.flatMap((f) => f.fields);

  return (
    <div style={{ fontSize: 12, marginBottom: 12 }}>
      <p style={{ fontWeight: 600 }}>{REVIEW_SCREEN.groundedSectionTitle}</p>
      <ul style={{ paddingLeft: 16 }}>
        {fieldsForStep
          .filter((b) => !b.neverFill && b.role !== "signature" && b.role !== "date_signed" && b.role !== "credential" && b.role !== "certification")
          .filter((b) => b.packageKey !== null)
          .map((b) => {
            const field = packageFields.find((f) => f.key === b.packageKey);
            if (!field) return null;
            if (field.status === "founder_to_provide") {
              return (
                <li key={b.packageKey}>
                  {b.label}: <em>{field.display}</em> — {REVIEW_SCREEN.gapLabel}
                </li>
              );
            }
            return (
              <li key={b.packageKey}>
                {b.label}: <strong>{field.display}</strong> ({REVIEW_SCREEN.provenanceLabel(field.source ?? "unknown")})
              </li>
            );
          })}
      </ul>

      <p style={{ fontWeight: 600 }}>{REVIEW_SCREEN.excludedSectionTitle}</p>
      <ul style={{ paddingLeft: 16 }}>
        {fieldsForStep
          .filter((b) => b.neverFill || b.role === "signature" || b.role === "date_signed" || b.role === "credential" || b.role === "certification")
          .map((b) => (
            <li key={`${b.label}-excluded`}>{b.label}</li>
          ))}
      </ul>
    </div>
  );
}
