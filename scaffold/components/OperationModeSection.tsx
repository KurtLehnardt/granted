"use client";

import React, { useId } from "react";
import type { OperationMode } from "@/lib/llm/config";

const MODES: { id: OperationMode; label: string; description: string }[] = [
  { id: "local", label: "Fully Local", description: "No API keys needed. Runs entirely on your device." },
  { id: "cloud", label: "Cloud", description: "Uses your configured API keys for scoring and search." },
  { id: "hybrid", label: "Hybrid", description: "Mix local and cloud. Local search with cloud scoring." },
];

// Settings' "Operation mode" section: a three-way segmented control (Fully Local / Cloud / Hybrid).
// Presentational: the parent owns the saved mode and persists changes (POST /api/llm/config).
export default function OperationModeSection({
  currentMode,
  onModeChange,
  disabled,
}: {
  currentMode: OperationMode;
  onModeChange: (mode: OperationMode) => void;
  disabled?: boolean;
}) {
  const uid = useId();
  const descId = `${uid}-mode-desc`;

  const legendClass = "font-mono text-[11px] uppercase tracking-eyebrow text-foreground";
  const fieldWrapClass =
    "mt-5 border-t border-structure-on-canvas pt-4 first:mt-4 first:border-t-0 first:pt-0";
  const segBtnClass = (active: boolean) =>
    `flex-1 min-h-[40px] rounded-sm border border-structure-on-canvas px-3 py-1.5 font-mono text-[11px] uppercase tracking-eyebrow transition disabled:opacity-50 ${
      active ? "bg-structure text-token-white" : "bg-canvas text-structure-on-canvas hover:bg-canvas-alt"
    }`;

  const current = MODES.find((m) => m.id === currentMode);

  return (
    <div className={fieldWrapClass} data-testid="operation-mode-section">
      <span className={legendClass}>Operation mode</span>
      <div className="mt-2 flex gap-2" role="group" aria-label="Operation mode" aria-describedby={descId}>
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={segBtnClass(currentMode === m.id)}
            aria-pressed={currentMode === m.id}
            disabled={disabled}
            onClick={() => {
              if (m.id !== currentMode) onModeChange(m.id);
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p id={descId} className="mt-1.5 font-body text-[12px] text-foreground opacity-80" data-testid="operation-mode-description">
        {current?.description}
      </p>
      {currentMode === "local" && (
        <p
          className="mt-2 rounded-r-sm border-l-2 border-success bg-canvas-alt px-3 py-2 font-body text-[12px] text-foreground"
          data-testid="privacy-badge"
        >
          Running fully offline — no data leaves your device
        </p>
      )}
    </div>
  );
}
