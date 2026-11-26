"use client";

import { useEffect, useState } from "react";

import { type BurnRow, type SourceKey, type SourceVisibility, derivedDayCount, sourceColumns, sumField } from "../../lib/burn-data";
import type { WindowKey } from "../../lib/date-windows";
import type { DisplayControls } from "../../lib/display-settings";
import { pauseInPlace } from "../../lib/pause";
import { formatTokens } from "../../lib/token-math";
import type { useConsoleSync } from "../../lib/use-console-sync";
import { ConsoleSyncBar } from "./console-sync";
import { AboutButton, AppearanceControls, RangePicker, SourceToggles } from "./controls";

/**
 * Phone only: one sticky row with the controls you reach for while scrolling
 * (range, sources, about, settings), plus the sources dropdown and the
 * settings sheet it opens. Touch has no hover, so the trust-tier summary that
 * desktop shows on hover is spelled out in the sources dropdown.
 */
export function PhoneBar({
  windowKey,
  onWindow,
  visible,
  onToggleSource,
  rows,
  sync,
  settings,
  menuOpen,
  setMenuOpen,
}: {
  windowKey: WindowKey;
  onWindow: (key: WindowKey) => void;
  visible: SourceVisibility;
  onToggleSource: (key: SourceKey) => void;
  rows: BurnRow[];
  sync: ReturnType<typeof useConsoleSync>;
  settings: DisplayControls;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
}) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const shownCount = sourceColumns.filter((source) => visible[source.key]).length;

  useEffect(() => {
    if (!menuOpen && !sourcesOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setSourcesOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    // The sheet scrolls on its own; the page behind it should not.
    const lock = menuOpen ? document.body.style.overflow : null;
    if (menuOpen) document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      if (lock !== null) document.body.style.overflow = lock;
    };
  }, [menuOpen, sourcesOpen, setMenuOpen]);

  return (
    <>
      <div className="phoneBar phoneOnly">
        <RangePicker value={windowKey} onChange={onWindow} />
        <button type="button" className="phoneChip" aria-expanded={sourcesOpen} onClick={() => setSourcesOpen((prev) => !prev)}>
          Sources <b>{shownCount}/{sourceColumns.length}</b>
          <span aria-hidden>{sourcesOpen ? "▴" : "▾"}</span>
        </button>
        <AboutButton />
        <button
          type="button"
          className="phoneIcon"
          aria-label="Settings: Console sync, appearance, pause"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          <span aria-hidden>⋯</span>
        </button>
        {sourcesOpen && (
          <>
            <div className="scrim clear" onClick={() => setSourcesOpen(false)} aria-hidden />
            <div className="sourcesSheet" role="group" aria-label="Show or hide sources">
              <div className="sourcesList">
                <SourceToggles visible={visible} onToggle={onToggleSource} />
              </div>
              <TrustSummary rows={rows} />
              {shownCount < sourceColumns.length && (
                <p className="muted controlsNote">Every view recomputes on the visible sources only.</p>
              )}
            </div>
          </>
        )}
      </div>

      {menuOpen && <SettingsSheet sync={sync} settings={settings} onClose={() => setMenuOpen(false)} />}
    </>
  );
}

/** Tokens per trust tier in the window, as pills. */
function TrustSummary({ rows }: { rows: BurnRow[] }) {
  const billed = sumField(rows, "billed_tokens");
  const derivedDays = derivedDayCount(rows);
  return (
    <div className="pillRow">
      {billed > 0 && <span className="pill billed">billed {formatTokens(billed)}</span>}
      <span className="pill exact">local logs {formatTokens(sumField(rows, "exact_tokens"))}</span>
      <span className="pill estimated">estimated {formatTokens(sumField(rows, "estimated_tokens"))}</span>
      {derivedDays > 0 && (
        <span className="pill derived">
          {derivedDays} day{derivedDays === 1 ? "" : "s"} derived from pruned logs
        </span>
      )}
    </div>
  );
}

function SettingsSheet({
  sync,
  settings,
  onClose,
}: {
  sync: ReturnType<typeof useConsoleSync>;
  settings: DisplayControls;
  onClose: () => void;
}) {
  const { display, setDisplay } = settings;
  return (
    <div className="sheetLayer phoneOnly">
      <div className="scrim" onClick={onClose} aria-hidden />
      <section className="sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="sheetHead">
          <span className="sheetGrip" aria-hidden />
          <h2>Settings</h2>
          <button type="button" className="phoneIcon" aria-label="Close settings" onClick={onClose}>
            <span aria-hidden>×</span>
          </button>
        </div>
        <ConsoleSyncBar sync={sync} />
        <div className="sheetBlock">
          <p className="label">Appearance</p>
          <button
            type="button"
            className="switchToggle"
            aria-pressed={display.compact}
            onClick={() => setDisplay((prev) => ({ ...prev, compact: !prev.compact }))}
          >
            <i aria-hidden />
            Compact view
            <small>{display.compact ? "on" : "off"}</small>
          </button>
          <div className="sheetAppearance">
            <AppearanceControls settings={settings} />
          </div>
        </div>
        <div className="sheetBlock">
          <p className="label">Snapshot</p>
          <button
            type="button"
            className="pause"
            onClick={() => {
              onClose();
              setTimeout(pauseInPlace, 50);
            }}
          >
            Pause this view
          </button>
          <p className="muted sheetHint">Freezes this tab as a static copy. Nothing is saved unless you confirm.</p>
        </div>
      </section>
    </div>
  );
}
