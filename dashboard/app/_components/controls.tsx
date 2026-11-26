"use client";

import { useState } from "react";

import {
  FIDELITY_TEXT,
  type SourceKey,
  type SourceVisibility,
  sourceColumns,
} from "../../lib/burn-data";
import { type WindowKey, windows } from "../../lib/date-windows";
import type { DisplayControls } from "../../lib/display-settings";
import { palettes } from "../../lib/themes";
import { ConsoleSyncBar, type Sync, syncTone } from "./console-sync";
import { VendorMark } from "./panel";

export function RangePicker({ value, onChange }: { value: WindowKey; onChange: (key: WindowKey) => void }) {
  return (
    <div className="range" aria-label="Select time range">
      {windows.map((option) => (
        <button key={option.key} type="button" aria-pressed={value === option.key} onClick={() => onChange(option.key)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** One chip per source, marked with its provider in its tier colour; the tier itself shows on hover. */
export function SourceToggles({
  visible,
  onToggle,
}: {
  visible: SourceVisibility;
  onToggle: (key: SourceKey) => void;
}) {
  return (
    <>
      {sourceColumns.map((source) => (
        <button
          key={source.key}
          type="button"
          className={`sourceToggle ${source.fidelity}`}
          aria-pressed={visible[source.key]}
          title={`${source.label}, ${FIDELITY_TEXT[source.fidelity]}. Click to ${visible[source.key] ? "hide" : "show"}.`}
          onClick={() => onToggle(source.key)}
        >
          <VendorMark vendor={source.vendor} />
          {source.label}
        </button>
      ))}
    </>
  );
}

/** The "i" button and its panel: what the page is and what the trust tiers mean. */
export function AboutButton() {
  return (
    <details className="info">
      <summary aria-label="About this dashboard" title="About this dashboard">
        i
      </summary>
      <div className="infoPanel">
        <p>
          One normalized file, one local day (America/Los_Angeles), every source on the same axes.
          Measured columns come from local Codex, Claude Code, and Ollama logs and from the
          providers&rsquo; own meters; chat columns are labeled estimates. Cache reads count toward burn and are
          shaded separately.
        </p>
        <p>
          <strong>Trust tiers.</strong> Hover a source, tile, cell, or row to see which applies.
        </p>
        <ul className="infoList">
          {Object.values(FIDELITY_TEXT).map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/**
 * Desktop: Console sync and appearance settings behind a sliders icon next to
 * the "i". The icon carries the sync status dot while a pull runs or when sync
 * needs attention, since the sync controls are no longer on the page.
 */
export function SettingsMenu({ settings, sync }: { settings: DisplayControls; sync: Sync }) {
  const tone = sync.status && !sync.unreachable ? syncTone(sync.status, sync.busy) : null;
  return (
    <details className="info settingsMenu">
      <summary aria-label="Settings: Console sync and appearance" title="Settings: Console sync and appearance">
        {(tone === "working" || tone === "bad") && <span className={`syncDot ${tone} settingsBadge`} aria-hidden />}
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
          <path d="M2 4h7M13 4h1M2 12h1M7 12h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="11" cy="4" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="5" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </summary>
      <div className="infoPanel settingsPanel">
        <ConsoleSyncBar sync={sync} />
        <section className="appearanceBlock" aria-label="Appearance">
          <p className="label">Appearance</p>
          <AppearanceControls settings={settings} />
        </section>
      </div>
    </details>
  );
}

/** Size steppers, palette swatches, and "Save as default". Shared by the desktop menu and the phone sheet. */
export function AppearanceControls({ settings }: { settings: DisplayControls }) {
  const { display, setDisplay, bump } = settings;
  const [saved, setSaved] = useState(false);

  const saveAsDefault = async () => {
    try {
      const res = await fetch("/api/display-defaults", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(display),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2200);
      }
    } catch {
      /* a paused copy has no server behind it; nothing to save */
    }
  };

  return (
    <>
      <Stepper label="Title" value={display.titleScale} onChange={(d) => bump("titleScale", d)} />
      <Stepper label="Figures" value={display.figureScale} onChange={(d) => bump("figureScale", d)} />
      <Stepper label="Panel figures" value={display.panelFigureScale} onChange={(d) => bump("panelFigureScale", d)} />
      <Stepper label="Density" value={display.density} onChange={(d) => bump("density", d)} />
      <div className="swatches" role="group" aria-label="Colour palette">
        <span className="label">Palette</span>
        {palettes.map((option) => (
          <button
            key={option.key}
            type="button"
            className="swatch"
            aria-pressed={display.palette === option.key}
            title={option.label}
            aria-label={`${option.label} palette`}
            onClick={() => setDisplay((prev) => ({ ...prev, palette: option.key }))}
            style={{ background: option.vars["--bg"], borderColor: option.vars["--line"] }}
          >
            <i style={{ background: option.vars["--accent"] }} />
            <i style={{ background: option.vars["--fresh"] }} />
          </button>
        ))}
      </div>
      <button
        type="button"
        className="saveDefault"
        onClick={saveAsDefault}
        title="Write these settings to data/display-defaults.json so a fresh browser, a cleared cache, or a deployed copy starts looking exactly like this."
      >
        {saved ? "Saved" : "Save as default"}
      </button>
    </>
  );
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (delta: number) => void }) {
  return (
    <div className="stepper" role="group" aria-label={`${label} size`}>
      <span className="label">{label}</span>
      <button type="button" onClick={() => onChange(-0.1)} aria-label={`Decrease ${label} size`}>
        &minus;
      </button>
      <output>{Math.round(value * 100)}%</output>
      <button type="button" onClick={() => onChange(0.1)} aria-label={`Increase ${label} size`}>
        +
      </button>
    </div>
  );
}
