"use client";

import { useId, useState } from "react";
import {
  getAutoFillRequirements,
  setAutoFillRequirements,
  type AutoFillRequirements,
} from "@/lib/mockAuth";
import { getMaxCandidates, setMaxCandidates } from "@/lib/searchSettings";

/**
 * SettingsForm.tsx — the auto-fill requirements form body, extracted from
 * SettingsPanel (FE-06) so it can be reused verbatim by BOTH the existing
 * Settings modal and the FE-07 left-sidebar's Settings section.
 *
 * Presentational + self-contained: it owns its own form state and persists to
 * localStorage via lib/mockAuth (getAutoFillRequirements / setAutoFillRequirements)
 * exactly as before — nothing here is sent anywhere, and "Delete my data"
 * clears it with everything else.
 *
 * Token-styled (CON-02 60/30/10) — the design revamp made these the default, so
 * the classes are the token set directly (no r7_design ternary). darkMode is
 * "media", so the tokens flip automatically.
 *
 * `onClose` is optional: the modal passes it so the "Close" text button renders
 * in the button row (keeping SettingsPanel's markup identical); the sidebar
 * section omits it (there is nothing to close — it's an inline section).
 */
export default function SettingsForm({ onClose }: { onClose?: () => void }) {
  const [form, setForm] = useState<AutoFillRequirements>(() => getAutoFillRequirements());
  const [maxCandidates, setMaxCandidatesState] = useState<number | null>(() => getMaxCandidates());
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Instance-unique ids / radio-group name (useId) so two mounted instances —
  // the drawer's inline Settings section and the SettingsPanel modal — never
  // share DOM ids or a radio `name` and cross-wire each other (frontend review
  // LOW; latent today since the two never mount simultaneously).
  const uid = useId();
  const ueiId = `${uid}-uei`;
  const aorNameId = `${uid}-aor-name`;
  const samRadioName = `${uid}-samRegistered`;
  const depthId = `${uid}-search-depth`;
  const orgNameId = `${uid}-org-name`;
  const streetId = `${uid}-street`;
  const cityId = `${uid}-city`;
  const stateId = `${uid}-state`;
  const zipId = `${uid}-zip`;
  const cdId = `${uid}-cd`;

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setAutoFillRequirements(form);
    setMaxCandidates(maxCandidates);
    setSavedAt(Date.now());
  }

  function update<K extends keyof AutoFillRequirements>(key: K, value: AutoFillRequirements[K]) {
    setSavedAt(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const legendClass = "font-mono text-[11px] uppercase tracking-eyebrow text-foreground";
  const fieldWrapClass =
    "mt-5 border-t border-structure-on-canvas pt-4 first:mt-4 first:border-t-0 first:pt-0";
  const inputClass =
    "mt-1.5 w-full rounded-sm border border-structure-on-canvas bg-canvas px-2.5 py-1.5 font-body text-[13px] text-foreground outline-none transition focus:border-structure-on-canvas focus:ring-2 focus:ring-structure-on-canvas";
  const labelTextClass = "font-body text-[13px] text-foreground";
  const saveBtnClass =
    "inline-flex min-h-[44px] items-center rounded-sm border border-structure-on-canvas px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
  const closeTextBtnClass =
    "inline-flex min-h-[44px] items-center font-mono text-[11px] uppercase tracking-eyebrow text-foreground underline underline-offset-4 transition hover:text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
  const savedMsgClass = "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";

  return (
    <form onSubmit={handleSave}>
      <p className="mb-4 font-body text-[12px] leading-relaxed text-foreground opacity-80">
        These details are self-reported and stored on this device. Granted never connects to
        SAM.gov — the checkboxes are your own attestation, not a live check.
      </p>
      <fieldset className={fieldWrapClass}>
        <legend className={legendClass}>Active SAM.gov registration</legend>
        <div className="mt-2 flex items-center gap-4">
          <label className={`flex items-center gap-1.5 ${labelTextClass}`}>
            <input
              type="radio"
              name={samRadioName}
              checked={form.samRegistered === true}
              onChange={() => update("samRegistered", true)}
            />
            Yes
          </label>
          <label className={`flex items-center gap-1.5 ${labelTextClass}`}>
            <input
              type="radio"
              name={samRadioName}
              checked={form.samRegistered === false}
              onChange={() => update("samRegistered", false)}
            />
            No
          </label>
        </div>
        {form.samRegistered && (
          <label className={`mt-2 block ${labelTextClass}`}>
            Registration date (optional)
            <input
              type="date"
              value={form.samRegisteredDate}
              onChange={(e) => update("samRegisteredDate", e.target.value)}
              className={inputClass}
            />
          </label>
        )}
      </fieldset>

      <div className={fieldWrapClass}>
        <label className={legendClass} htmlFor={ueiId}>
          UEI (Unique Entity Identifier)
        </label>
        <input
          id={ueiId}
          type="text"
          value={form.uei}
          onChange={(e) => update("uei", e.target.value)}
          placeholder="e.g. ABC123DEF456"
          className={inputClass}
        />
      </div>

      <fieldset className={fieldWrapClass}>
        <legend className={legendClass}>Authorized AOR</legend>
        <label className={`mt-2 block ${labelTextClass}`} htmlFor={aorNameId}>
          Name
          <input
            id={aorNameId}
            type="text"
            value={form.aorName}
            onChange={(e) => update("aorName", e.target.value)}
            placeholder="Who's authorized to sign for your org"
            className={inputClass}
          />
        </label>
        <label className={`mt-2 flex items-center gap-2 ${labelTextClass}`}>
          <input
            type="checkbox"
            checked={form.aorOnFile}
            onChange={(e) => update("aorOnFile", e.target.checked)}
          />
          This AOR is on file in SAM.gov
        </label>
      </fieldset>

      <fieldset className={fieldWrapClass}>
        <legend className={legendClass}>E-Biz POC delegation</legend>
        <label className={`mt-2 flex items-center gap-2 ${labelTextClass}`}>
          <input
            type="checkbox"
            checked={form.eBizPocOnFile}
            onChange={(e) => update("eBizPocOnFile", e.target.checked)}
          />
          The E-Biz POC has delegated AOR authority in SAM.gov
        </label>
      </fieldset>

      <fieldset className={fieldWrapClass}>
        <legend className={legendClass}>Organization details (reused on every grant)</legend>
        <p className="mt-1 font-body text-[12px] text-foreground opacity-80">
          Your legal organization info as registered in SAM.gov. Enter it once here and it&rsquo;s
          filled into every application — copy it from your SAM.gov entity registration.
        </p>
        <label className={`mt-2 block ${labelTextClass}`} htmlFor={orgNameId}>
          Legal organization name
          <input
            id={orgNameId}
            type="text"
            value={form.organizationName}
            onChange={(e) => update("organizationName", e.target.value)}
            placeholder="Exactly as registered in SAM.gov"
            className={inputClass}
          />
        </label>
        <label className={`mt-2 block ${labelTextClass}`} htmlFor={streetId}>
          Street address
          <input
            id={streetId}
            type="text"
            value={form.street}
            onChange={(e) => update("street", e.target.value)}
            className={inputClass}
          />
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          <label className={`flex-1 ${labelTextClass}`} htmlFor={cityId}>
            City
            <input id={cityId} type="text" value={form.city} onChange={(e) => update("city", e.target.value)} className={inputClass} />
          </label>
          <label className={labelTextClass} htmlFor={stateId}>
            State
            <input id={stateId} type="text" value={form.state} onChange={(e) => update("state", e.target.value)} className={`${inputClass} w-24`} />
          </label>
          <label className={labelTextClass} htmlFor={zipId}>
            ZIP
            <input id={zipId} type="text" value={form.zip} onChange={(e) => update("zip", e.target.value)} className={`${inputClass} w-28`} />
          </label>
        </div>
        <label className={`mt-2 block ${labelTextClass}`} htmlFor={cdId}>
          Congressional district
          <input
            id={cdId}
            type="text"
            value={form.congressionalDistrict}
            onChange={(e) => update("congressionalDistrict", e.target.value)}
            placeholder="e.g. ID-01 — look it up at house.gov (Find Your Representative)"
            className={inputClass}
          />
        </label>
      </fieldset>

      <div className={fieldWrapClass}>
        <label className={legendClass} htmlFor={depthId}>
          Search depth
        </label>
        <select
          id={depthId}
          value={maxCandidates == null ? "" : String(maxCandidates)}
          onChange={(e) => {
            setSavedAt(null);
            const v = e.target.value;
            setMaxCandidatesState(v === "" ? null : Number(v));
          }}
          className={inputClass}
        >
          <option value="">Standard (default)</option>
          <option value="12">Faster — fewer matches</option>
          <option value="6">Fastest — fewest matches</option>
        </select>
        <p className="mt-1.5 font-body text-[12px] text-foreground opacity-80">
          How many opportunities the model scores each search. Fewer is faster — helpful on a slow
          local model — but may surface fewer matches.
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <button type="submit" className={saveBtnClass}>
          Save
        </button>
        {onClose && (
          <button type="button" onClick={onClose} className={closeTextBtnClass}>
            Close
          </button>
        )}
        <span aria-live="polite" className={savedMsgClass}>
          {savedAt ? "Saved" : ""}
        </span>
      </div>
    </form>
  );
}
