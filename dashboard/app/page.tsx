"use client";

import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";

// Seeded from the committed synthetic sample so a fresh clone builds and renders.
// Your real data/daily-burn.json is gitignored and loaded at runtime via /api/burn-rows.
import rawRows from "../data/daily-burn.sample.json";
import savedDisplayDefaults from "../data/display-defaults.json";
import {
  type BurnRow,
  type RawBurnRow,
  type SourceKey,
  hasCostData,
  modelTotals,
  planPeaks,
  estimateSensitivity,
  normalizeRows,
  reconciliation,
  rowFidelityLabel,
  sourceColumns,
  sumField,
  sumSource,
  titleCase,
} from "../lib/burn-data";
import { getWindowRows, type WindowKey, windows } from "../lib/date-windows";
import { type Palette, defaultPalette, paletteByKey, palettes } from "../lib/themes";
import {
  FRESH_FULL_SHARE,
  calendarWeeks,
  costPerMillion,
  fermiScale,
  formatPercent,
  formatTokens,
  formatUsd,
  heatColor,
  heatStyle,
  logNormalize,
  movingAverage7,
  sumTokens,
  weeklyTotals,
} from "../lib/token-math";
import { SCHEDULE_OPTIONS, formatAge, useConsoleSync } from "../lib/use-console-sync";

const initialRows = normalizeRows(rawRows as RawBurnRow[]);
type HeatMetric = "total" | "fresh" | "cost";
type SourceVisibility = Record<SourceKey, boolean>;
const allVisible: SourceVisibility = {
  codex_tokens: true,
  claude_code_tokens: true,
  console_tokens: true,
  openai_api_tokens: true,
  claude_chat_est: true,
  chatgpt_est: true,
};

export default function TokenBurnDashboard() {
  const [windowKey, setWindowKey] = useState<WindowKey>("365");
  const [heatMetric, setHeatMetric] = useState<HeatMetric>("total");
  const [visible, setVisible] = useState<SourceVisibility>(allVisible);
  const [showFidelity, setShowFidelity] = useState(true);
  const [display, setDisplay] = useState<DisplaySettings>(defaultDisplay);
  const [tableExpanded, setTableExpanded] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [allRows, setAllRows] = useState<BurnRow[]>(initialRows);
  const palette = paletteByKey(display.palette);

  // Console sync owns its own schedule server-side; the page just keeps it honest
  // while it is open, and swaps in fresh rows when a pull lands.
  const sync = useConsoleSync((raw) => setAllRows(normalizeRows(raw)));

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(DISPLAY_KEY);
      if (saved) setDisplay({ ...defaultDisplay, ...JSON.parse(saved) });
    } catch {
      /* storage unavailable */
    }
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(DISPLAY_KEY, JSON.stringify(display));
    } catch {
      /* storage unavailable */
    }
  }, [display, hydrated]);
  useEffect(() => {
    // Push the palette to <html> and <body> too, so the page ground outside <main> matches.
    for (const [name, value] of Object.entries(palette.vars)) {
      if (name.startsWith("--")) document.documentElement.style.setProperty(name, String(value));
    }
    document.documentElement.style.background = palette.vars["--bg"];
    document.documentElement.style.colorScheme = palette.scheme;
    document.body.style.background = palette.vars["--bg"];
    document.body.style.color = palette.vars["--ink"];
  }, [palette]);

  // Phone-only overlays: the settings sheet and the sources dropdown.
  const [menuOpen, setMenuOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
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
  }, [menuOpen, sourcesOpen]);

  const [savedDefault, setSavedDefault] = useState(false);
  const saveAsDefault = async () => {
    try {
      const res = await fetch("/api/display-defaults", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(display),
      });
      if (res.ok) {
        setSavedDefault(true);
        setTimeout(() => setSavedDefault(false), 2200);
      }
    } catch {
      /* a paused copy has no server behind it; nothing to save */
    }
  };

  const bump = (key: "titleScale" | "figureScale" | "panelFigureScale" | "density", delta: number) =>
    setDisplay((prev) => ({ ...prev, [key]: clampScale(prev[key] + delta, key === "density" ? 0.2 : 0.5) }));
  const mainStyle = {
    ...palette.vars,
    "--title-scale": display.titleScale,
    "--figure-scale": display.figureScale,
    "--panel-figure-scale": display.panelFigureScale,
    "--density": display.density,
  } as CSSProperties;

  const rows = useMemo(() => applySourceVisibility(allRows, visible), [allRows, visible]);
  const selectedRows = useMemo(() => getWindowRows(rows, windowKey), [rows, windowKey]);
  const hiddenCount = sourceColumns.filter((source) => !visible[source.key]).length;
  const total = sumTokens(selectedRows);
  const cached = sumField(selectedRows, "cached");
  const fresh = sumField(selectedRows, "fresh");
  const exactTokens = sumField(selectedRows, "exact_tokens");
  const billedTokens = sumField(selectedRows, "billed_tokens");
  const openaiTokens = sumSource(selectedRows, "openai_api_tokens");
  const openaiSpend = sumField(selectedRows, "openai_api_usd");
  const estimatedTokens = sumField(selectedRows, "estimated_tokens");

  // Money only appears once the Console has actually billed something.
  const showCost = hasCostData(selectedRows);
  const spend = sumField(selectedRows, "cost_usd");
  const cachedSpend = sumField(selectedRows, "cost_cached_usd");
  const spendDays = selectedRows.filter((row) => row.cost_usd > 0).length;
  const recon = useMemo(() => reconciliation(selectedRows), [selectedRows]);
  const models = useMemo(() => modelTotals(selectedRows), [selectedRows]);
  const plan = useMemo(() => planPeaks(selectedRows), [selectedRows]);
  const gptSens = useMemo(() => estimateSensitivity(selectedRows, "chatgpt_est"), [selectedRows]);
  const heatMetricEffective: HeatMetric = heatMetric === "cost" && !showCost ? "total" : heatMetric;
  const calls = selectedRows.reduce((sum, row) => sum + row.claude_code_calls, 0);
  const peakDay = selectedRows.reduce(
    (peak, row) => (row.total > peak.total ? row : peak),
    selectedRows[0] || rows[0],
  );
  const lastAverage =
    selectedRows.length > 0 ? movingAverage7(selectedRows, selectedRows.length - 1) : 0;
  // The model that did most of the peak day's billed work, when the meter saw it.
  const peakTopModel = useMemo(() => (peakDay ? modelTotals([peakDay])[0] || null : null), [peakDay]);
  const drivers = buildDriverRows(selectedRows, total);
  const weekly = weeklyTotals(selectedRows);
  const peakWeek = weekly.reduce((peak, week) => (week.total > peak.total ? week : peak), weekly[0]);
  const heatValue = (row: BurnRow) =>
    heatMetricEffective === "total" ? row.total : heatMetricEffective === "fresh" ? row.fresh : row.cost_usd;
  const maxHeat = Math.max(...selectedRows.map(heatValue), 0);
  const calendar = calendarWeeks(selectedRows);
  const sourceTotal = sourceColumns.reduce((sum, source) => sum + sumSource(selectedRows, source.key), 0);
  const tableRowsAll = selectedRows.slice(-30).reverse();
  const collapsedCount = Math.max(1, Math.ceil(tableRowsAll.length / 5));
  const tableRows = tableExpanded ? tableRowsAll : tableRowsAll.slice(0, collapsedCount);
  const nextActions = buildNextActions(selectedRows);
  const derivedDays = selectedRows.filter((row) => row.claude_code_fidelity !== "exact" && row.claude_code_fidelity !== "none").length;

  // The heatmap reads left to right, oldest first; open it on the latest weeks.
  const calendarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = calendarRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [calendar.length, windowKey]);

  const fidelityPills = (
    <div className="pillRow">
      {billedTokens > 0 && <span className="pill billed">billed {formatTokens(billedTokens)}</span>}
      <span className="pill exact">exact {formatTokens(exactTokens)}</span>
      <span className="pill estimated">estimated {formatTokens(estimatedTokens)}</span>
      {derivedDays > 0 && (
        <span className="pill derived">
          {derivedDays} day{derivedDays === 1 ? "" : "s"} derived from pruned logs
        </span>
      )}
    </div>
  );

  // Shared by the desktop Appearance bar and the phone settings sheet.
  const appearanceControls = (
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
        {savedDefault ? "Saved" : "Save as default"}
      </button>
    </>
  );

  return (
    <main className={`page${display.compact ? " compact" : ""}`} style={mainStyle} data-scheme={palette.scheme}>
      <section className="hero">
        <div className="titleRow">
          <div className="titleText">
            <h1>Token Burn Dashboard</h1>
            <p className="subtitle">AI Usage by Day, Source, and Work Driver</p>
            <PhoneSyncLine sync={sync} onOpen={() => setMenuOpen(true)} />
          </div>
          <div className="titleActions deskOnly">
            <AboutButton />
            <button
              type="button"
              className="pause"
              onClick={pauseInPlace}
              title="Freezes this tab as a static view that keeps rendering after npm run dev stops. Nothing is saved unless you say yes to the prompt."
            >
              Pause
            </button>
          </div>
        </div>
        <div className="controls deskOnly">
          <div className="range" aria-label="Select time range">
            {windows.map((windowOption) => (
              <button
                key={windowOption.key}
                type="button"
                aria-pressed={windowKey === windowOption.key}
                onClick={() => setWindowKey(windowOption.key)}
              >
                {windowOption.label}
              </button>
            ))}
          </div>
          <div className="sources" aria-label="Show or hide sources">
            {sourceColumns.map((source) => (
              <button
                key={source.key}
                type="button"
                className={`sourceToggle ${source.fidelity}`}
                aria-pressed={visible[source.key]}
                onClick={() => setVisible((prev) => ({ ...prev, [source.key]: !prev[source.key] }))}
              >
                <i aria-hidden />
                {source.label}
                {showFidelity && <small>{source.fidelity}</small>}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="fidelityToggle"
            aria-pressed={showFidelity}
            onClick={() => setShowFidelity((prev) => !prev)}
          >
            <i aria-hidden />
            Toggle fidelity labels
            <small>billed / exact / derived / est.</small>
          </button>
          {hiddenCount > 0 && (
            <p className="muted controlsNote">
              {hiddenCount} source{hiddenCount === 1 ? "" : "s"} hidden. Every view below recomputes on the visible sources only.
            </p>
          )}
        </div>
      </section>

      {/* Phone only: one sticky row holding the controls you reach for while scrolling. */}
      <div className="phoneBar phoneOnly">
        <div className="range" aria-label="Select time range">
          {windows.map((windowOption) => (
            <button
              key={windowOption.key}
              type="button"
              aria-pressed={windowKey === windowOption.key}
              onClick={() => setWindowKey(windowOption.key)}
            >
              {windowOption.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="phoneChip"
          aria-expanded={sourcesOpen}
          onClick={() => setSourcesOpen((prev) => !prev)}
        >
          Sources <b>{sourceColumns.length - hiddenCount}/{sourceColumns.length}</b>
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
                {sourceColumns.map((source) => (
                  <button
                    key={source.key}
                    type="button"
                    className={`sourceToggle ${source.fidelity}`}
                    aria-pressed={visible[source.key]}
                    onClick={() => setVisible((prev) => ({ ...prev, [source.key]: !prev[source.key] }))}
                  >
                    <i aria-hidden />
                    {source.label}
                    {showFidelity && <small>{source.fidelity}</small>}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="fidelityToggle"
                aria-pressed={showFidelity}
                onClick={() => setShowFidelity((prev) => !prev)}
              >
                <i aria-hidden />
                Fidelity labels
              </button>
              {showFidelity && fidelityPills}
              {hiddenCount > 0 && (
                <p className="muted controlsNote">Every view recomputes on the visible sources only.</p>
              )}
            </div>
          </>
        )}
      </div>

      <section
        className={`displayBar deskOnly${display.barCollapsed ? " collapsed" : ""}`}
        aria-label="Appearance settings"
      >
        <button
          type="button"
          className="barToggle"
          aria-expanded={!display.barCollapsed}
          title={display.barCollapsed ? "Show appearance settings" : "Minimize appearance settings"}
          onClick={() => setDisplay((prev) => ({ ...prev, barCollapsed: !prev.barCollapsed }))}
        >
          <span className="chevron" aria-hidden>{display.barCollapsed ? "▸" : "▾"}</span>
          <span className="label">Appearance</span>
        </button>

        {display.barCollapsed ? (
          <span className="barSummary muted">
            {paletteByKey(display.palette).label} · title {Math.round(display.titleScale * 100)}% ·
            figures {Math.round(display.figureScale * 100)}% · density{" "}
            {Math.round(display.density * 100)}%
          </span>
        ) : (
          appearanceControls
        )}
      </section>

      <div className="deskOnly">
        <ConsoleSyncBar sync={sync} />
      </div>

      <section className="stats" aria-label="Token burn summary">
        <Metric label="Total burn" value={formatTokens(total)} note={`${formatPercent(cached, total)} cache reads`} short={`${formatPercent(cached, total)} cached`} />
        <Metric label="Peak day" value={formatTokens(peakDay?.total || 0)} note={peakDay?.date || "n/a"} short={peakDay ? shortDate(peakDay.date) : "n/a"} />
        <Metric label="7d average" value={formatTokens(lastAverage)} note="moving average, active days" short="per active day" />
        <Metric label="API calls" value={calls.toLocaleString()} note={`${selectedRows.length} active days`} short={`${selectedRows.length} days`} />
      </section>

      {showCost && (
        <section className="money" aria-label="Billed spend summary">
          <div className="moneyLead">
            <span className="label">Billed</span>
            <p>
              Real money, from Anthropic&rsquo;s own meter. Everything above is tokens; everything
              here settled on an invoice.
            </p>
          </div>
          <div className="moneyGrid">
            <MoneyMetric label="Total spend" value={formatUsd(spend)} note={`${spendDays} billed day${spendDays === 1 ? "" : "s"}`} short={`${spendDays} days`} />
            <MoneyMetric
              label="Per 1M tokens"
              value={formatUsd(costPerMillion(spend, billedTokens || total))}
              note="blended rate in view"
              short="blended"
            />
            <MoneyMetric
              label="Cache reads"
              value={formatUsd(cachedSpend)}
              note={`${formatPercent(cachedSpend, spend)} of spend re-reading context`}
              short={`${formatPercent(cachedSpend, spend)} of spend`}
            />
            <MoneyMetric
              label="Per billed day"
              value={formatUsd(spendDays ? spend / spendDays : 0)}
              note="mean across days with a charge"
              short="mean"
            />
          </div>
        </section>
      )}

      {showFidelity && (
        <section className="fidelityBar deskOnly" aria-label="Fidelity summary">
          {fidelityPills}
        </section>
      )}

      <section className="grid chartsGrid">
        <Panel
          label="Daily burn"
          title="Heatmap"
          note="Log color scale. Accent-coloured cells are cache-read heavy; the more a cell shifts to the second colour, the larger its fresh share."
          action={
            <div className="toggle" role="group" aria-label="Heatmap metric">
              {(showCost ? (["total", "fresh", "cost"] as HeatMetric[]) : (["total", "fresh"] as HeatMetric[])).map((metric) => (
                <button
                  key={metric}
                  type="button"
                  aria-pressed={heatMetricEffective === metric}
                  onClick={() => setHeatMetric(metric)}
                >
                  {metric}
                </button>
              ))}
            </div>
          }
        >
          <div className="calendarWrap deskOnly" ref={calendarRef}>
            <div className="calendar" aria-label="Daily token burn heatmap">
              <div className="dayLabels" aria-hidden>
                {["Mon", "", "Wed", "", "Fri", "", "Sun"].map((label, index) => (
                  <span key={index}>{label}</span>
                ))}
              </div>
              {calendar.map((week) => (
                <div key={week[0].date} className="week">
                  {week.map((cell) => {
                    const row = cell.row;
                    const value = row ? heatValue(row) : 0;
                    // In cost mode the fresh/cached mix is the money split, not the token split.
                    const mixNumerator = row
                      ? heatMetricEffective === "cost"
                        ? row.cost_usd - row.cost_cached_usd
                        : row.fresh
                      : 0;
                    const title = row
                      ? `${row.date}: ${formatTokens(row.total)} tokens (${formatPercent(row.fresh, row.total)} fresh)` +
                        (row.cost_usd > 0 ? `, ${formatUsd(row.cost_usd)} billed` : "") +
                        `, ${row.driver}${showFidelity ? `, ${rowFidelityLabel(row).text}` : ""}`
                      : `${cell.date}: no recorded usage`;
                    return (
                      <span
                        key={cell.date}
                        className={`cell${row ? "" : " empty"}`}
                        style={row ? heatStyle(value, mixNumerator, maxHeat, palette) : undefined}
                        title={title}
                        tabIndex={row ? 0 : -1}
                        aria-label={title}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <WeekRows
            weeks={calendar}
            heatValue={heatValue}
            mixValue={(row) =>
              heatMetricEffective === "cost" ? row.cost_usd - row.cost_cached_usd : row.fresh
            }
            maxHeat={maxHeat}
            palette={palette}
            metric={heatMetricEffective}
          />
          <div className="legend" aria-hidden>
            <span>less</span>
            {[0.2, 0.4, 0.6, 0.8, 1].map((n) => (
              <i key={n} style={{ background: heatColor(Math.pow(10, n * 6), 0, 1_000_000, palette) }} />
            ))}
            <span>more</span>
            <span className="legendGap">cached</span>
            {[0, 0.25, 0.5, 0.75, 1].map((mix) => (
              <i key={mix} style={{ background: heatColor(1_000_000, 1_000_000 * mix * FRESH_FULL_SHARE, 1_000_000, palette) }} />
            ))}
            <span>fresh ({Math.round(FRESH_FULL_SHARE * 100)}%+)</span>
          </div>
        </Panel>

        <Panel
          label="Weekly trend"
          title="Log-scaled trend"
          note={
            peakWeek ? (
              <>
                Peak week starts {peakWeek.week} at {formatTokens(peakWeek.total)} tokens.
                <br />
                Thin line is fresh tokens only; dotted spans are weeks with no recorded usage.
              </>
            ) : (
              "No weeks in range."
            )
          }
        >
          <div className="trend">
            <TrendChart weekly={weekly} />
          </div>
        </Panel>
      </section>

      <section className="grid">
        <Panel
          label="Source split"
          title={showFidelity ? "Exact beside estimated" : "By source"}
          note={
            showFidelity
              ? "The source labels are part of the dashboard, not a footnote."
              : "Share of the selected window. Cache reads shown where measured."
          }
        >
          <div className="sourceGrid">
            {sourceColumns.map((source) => {
              const value = sumSource(selectedRows, source.key);
              const share = sourceTotal ? Math.round((value / sourceTotal) * 100) : 0;
              const cachedValue = source.cachedKey ? sumField(selectedRows, source.cachedKey) : 0;
              if (source.key === "claude_chat_est" && plan) {
                // A measured signal for the subscription stands in for the flat chat estimate.
                return (
                  <div key={source.key} className="source">
                    {showFidelity && <span className="pill exact">measured</span>}
                    <strong>{plan.sevenDay.pct}%</strong>
                    <span className="muted">
                      Claude plan 7-day limit, peak {plan.sevenDay.date}
                    </span>
                    <span className="sourceSub">
                      5-hour peak {plan.fiveHour.pct}% on {plan.fiveHour.date} · latest {plan.latest.pct7d}% / {plan.latest.pct5h}% ·{" "}
                      {plan.sampledDays} sampled days
                    </span>
                    {value > 0 && (
                      <span className="sourceSub">
                        chat est. {formatTokens(value)} / {share}% stays in totals
                      </span>
                    )}
                  </div>
                );
              }
              if (source.key === "chatgpt_est" && value > 0) {
                return (
                  <div key={source.key} className="source">
                    {showFidelity && <span className={`pill ${source.fidelity}`}>{source.fidelity}</span>}
                    <strong>{`\u2264${Math.max(1, Math.round(gptSens.maxShare * 100))}%`}</strong>
                    <span className="muted">
                      ChatGPT est. can move the total at most this much
                    </span>
                    <span className="sourceSub">
                      {formatTokens(gptSens.perDay)} x {gptSens.days} active days = {formatTokens(value)} ({share}%) · range{" "}
                      {formatTokens(gptSens.low)} to {formatTokens(gptSens.high)}
                    </span>
                  </div>
                );
              }
              return (
                <div key={source.key} className="source">
                  {showFidelity && <span className={`pill ${source.fidelity}`}>{source.fidelity}</span>}
                  <strong>{formatTokens(value)}</strong>
                  <span className="muted">
                    {source.label} / {share}%
                    {source.cachedKey && value > 0 ? ` / ${formatPercent(cachedValue, value)} cache reads` : ""}
                  </span>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel
          label="Drivers"
          title={showCost ? "What Is Burning Tokens and Money" : "What Is Burning Tokens"}
          noWrapTitle
          note={
            showCost ? (
              <>
                Grouped by driver, sorted by tokens.
                <br />
                The money column is the billed share landing on that driver.
              </>
            ) : (
              <>
                Grouped by driver. Sorted by total tokens.
                <br />
                Share is of the selected window.
              </>
            )
          }
        >
          <div className={`driverGrid${showCost ? " withCost" : ""}`}>
            {drivers.map((driver) => (
              <div key={driver.label} className="driver">
                <strong>{titleCase(driver.label)}</strong>
                <span className="track">
                  <i style={{ width: `${driver.share}%` }} />
                </span>
                <span className="driverValue">
                  {formatTokens(driver.value)} / {driver.share}%
                </span>
                {showCost && (
                  <span className="driverCost">{driver.cost > 0 ? formatUsd(driver.cost) : "—"}</span>
                )}
              </div>
            ))}
          </div>
        </Panel>
      </section>

      {models.length > 0 && (
        <section className="panel modelsPanel">
          <div className="panelHeader">
            <div>
              <p className="label">Models</p>
              <h2 className="noWrap">Which Model Did the Work</h2>
            </div>
            <div className="panelAside">
              <p>
                Every lane that names a model: Anthropic&rsquo;s meter, OpenAI&rsquo;s export, Codex
                session logs, and Claude Code logs. Billed and local rows stay separate.{" "}
                {models.length} row{models.length === 1 ? "" : "s"} in the selected window.
              </p>
            </div>
          </div>
          <div className="modelGrid">
            {models.map((model) => (
              <div key={`${model.lane}:${model.vendor}:${model.model}`} className="modelRow">
                <small className={`modelVendor ${model.vendor}`}>{model.vendor === "openai" ? "OpenAI" : "Anthropic"}</small>
                <strong title={`${model.model} (${model.lane === "billed" ? "billed meter" : "local session log"})`}>
                  {model.label}
                  <em className={`modelLane ${model.lane}`}>{model.lane}</em>
                </strong>
                <span className="track">
                  <i style={{ width: `${Math.max(1, model.share * 100)}%` }} />
                </span>
                <span className="modelValue">{formatTokens(model.tokens)}</span>
                <span className="modelShare">{Math.round(model.share * 100)}%</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="grid">
        <Panel
          label="Scale equivalents"
          title="Make the number human"
          note="Approximate comparisons are useful only when the math stays visible."
        >
          <div className="equivalents">
            {fermiScale(total, spend).map((item) => (
              <div key={item.label} className="equivalent">
                <span className="muted">{item.label}</span>
                <strong>{item.value}</strong>
                <span className="math">{item.note}</span>
              </div>
            ))}
          </div>
          <p className="footnoteInline">
            Fresh-only: {formatTokens(fresh * 0.75)} words. Cache reads re-serve context the model
            already saw, so the fresh figure is closer to new material.
          </p>
        </Panel>

        <Panel
          label="What next"
          title="What should the computer do next?"
          note="Heuristics computed from the rows in view. Read them as prompts, not verdicts."
        >
          <ul className="actions">
            {nextActions.map((action) => (
              <li key={action.title}>
                <strong>{action.title}</strong>
                <span>{action.body}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </section>

      <section className="grid">
        <Panel
          label="Peak day"
          title={peakDay ? titleCase(peakDay.driver) : "No Data"}
          note={
            peakDay?.evidence
              ? titleCase(peakDay.evidence)
              : "Add evidence notes to explain why a day spiked."
          }
        >
          <div className="sourceGrid peakGrid">
            <Metric label="Date" value={peakDay?.date || "n/a"} note="Local bucket" />
            <Metric
              label="Burn"
              value={formatTokens(peakDay?.total || 0)}
              note={peakDay ? `${formatPercent(peakDay.fresh, peakDay.total)} fresh` : ""}
            />
            <Metric label="Calls" value={`${peakDay?.claude_code_calls || 0}`} note="Claude Code" />
            {peakDay && peakDay.cost_usd > 0 && (
              <Metric label="Cost" value={formatUsd(peakDay.cost_usd)} note="Billed that day" />
            )}
            {peakTopModel && (
              <Metric
                label="Top model"
                value={peakTopModel.label}
                note={`${formatTokens(peakTopModel.tokens)} billed, ${peakTopModel.vendor === "openai" ? "OpenAI" : "Anthropic"}`}
              />
            )}
            {showFidelity && (
              <Metric
                label="Label"
                value={peakDay ? titleCase(rowFidelityLabel(peakDay).text) : "n/a"}
                note="Fidelity"
              />
            )}
          </div>
        </Panel>
        <Panel
          label="Method"
          title="How the numbers are made"
          note="Kept short so the trust label means something."
        >
          <ul className="method">
            <li>Burn = input + cache writes + cache reads + output, per call.</li>
            <li>Days bucket in your local timezone (BURN_TZ) before summing.</li>
            <li>Claude Code = CLI plus Cowork, de-duplicated by message id.</li>
            <li>Calls = unique Claude Code API responses that day.</li>
            <li>Estimates never merge into measured columns.</li>
            <li>A day may split across drivers; shares are fractional and sum to one.</li>
            {billedTokens > 0 && (
              <>
                <li>Console API = the meter, minus traffic a local log already counted.</li>
                {openaiTokens > 0 && (
                  <li>
                    OpenAI API = the platform usage export, API keys only, UTC-day buckets
                    {openaiSpend > 0 ? ` (${formatUsd(openaiSpend)} in view, kept apart from Anthropic spend)` : ""}.
                    ChatGPT chat is not in it and stays estimated.
                  </li>
                )}
                <li>Model attribution comes from the meter; local logs ship without one.</li>
              </>
            )}
            {showCost && (
              <li>
                Cost arrives on UTC days and is apportioned to local days by hourly token share,
                per token type. Window totals exact; per-day derived.
              </li>
            )}
          </ul>
        </Panel>
      </section>

      {recon && (
        <section className="panel reconcile">
          <div className="panelHeader">
            <div>
              <p className="label">Reconciliation</p>
              <h2>Local logs vs the bill</h2>
            </div>
            <div className="panelAside">
              <p>
                Days where both a local session log and Anthropic&rsquo;s meter saw Claude Code. Only
                one direction means anything: bars where <em>billed</em> runs past <em>local</em> are
                work your logs missed.
              </p>
            </div>
          </div>
          <div className="reconcileBody">
            <div className="reconcileHead">
              <div className="reconcileScore">
                <strong>{recon.gapDays === 0 ? "0" : formatTokens(recon.missingTokens)}</strong>
                <span className="muted">
                  {recon.gapDays === 0 ? (
                    <>
                      No day billed more Claude Code than the local logs captured, across{" "}
                      {recon.days} comparable day{recon.days === 1 ? "" : "s"}. The extraction is not
                      missing measurable work.
                    </>
                  ) : (
                    <>
                      tokens the invoice records that the local logs did not, across {recon.gapDays}{" "}
                      of {recon.days} comparable day{recon.days === 1 ? "" : "s"} — the local
                      extraction captured {Math.round(recon.coverage * 100)}% of billed Claude Code
                      on those days.
                    </>
                  )}
                </span>
                <span className="math">
                  {recon.worstGap
                    ? `Largest gap ${recon.worstGap.date}, ${formatTokens(recon.worstGapTokens)} unlogged. `
                    : ""}
                  {recon.subscriptionDays > 0 && (
                    <>
                      On the other {recon.subscriptionDays} day
                      {recon.subscriptionDays === 1 ? "" : "s"} local exceeds billed, which is
                      expected: subscription-billed Claude Code never reaches the organization meter.
                    </>
                  )}
                </span>
              </div>
              <div className="reconcileKey">
                <span><i className="keyLocal" /> local log</span>
                <span><i className="keyBilled" /> billed</span>
              </div>
            </div>
            <ReconcileChart rows={recon.days > 24 ? selectedRows.filter((r) => r.billed_claude_code_tokens > 0 && r.claude_code_tokens > 0).slice(-24) : selectedRows.filter((r) => r.billed_claude_code_tokens > 0 && r.claude_code_tokens > 0)} />
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panelHeader">
          <div>
            <p className="label">Moving-average table</p>
            <h2>Last 30 active days</h2>
          </div>
          <button
            type="button"
            className="expand"
            aria-expanded={tableExpanded}
            onClick={() => setTableExpanded((prev) => !prev)}
          >
            {tableExpanded ? `Collapse to ${collapsedCount}` : `Show all ${tableRowsAll.length}`}
          </button>
          <p>
            {showFidelity ? "Exact and estimated columns stay separate. " : ""}
            Cache share is the part of measured tokens that were cache reads.
            {tableExpanded ? "" : ` Showing ${tableRows.length} of ${tableRowsAll.length} rows.`}
          </p>
        </div>
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Total</th>
                {showCost && <th className="moneyCol">Cost</th>}
                <th>7d avg</th>
                <th>Cache share</th>
                <th>Codex{showFidelity ? " exact" : ""}</th>
                <th>Claude Code{showFidelity ? " exact" : ""}</th>
                <th>Calls</th>
                {billedTokens > 0 && <th>Console API{showFidelity ? " billed" : ""}</th>}
                {openaiTokens > 0 && <th>OpenAI API{showFidelity ? " billed" : ""}</th>}
                <th>Claude chat{showFidelity ? " est." : ""}</th>
                <th>ChatGPT{showFidelity ? " est." : ""}</th>
                <th>Driver</th>
                {showFidelity && <th>Label</th>}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row) => {
                const originalIndex = selectedRows.findIndex((candidate) => candidate.date === row.date);
                const label = rowFidelityLabel(row);
                return (
                  <tr key={row.date}>
                    <td>
                      <strong>{row.date}</strong>
                    </td>
                    <td>{formatTokens(row.total)}</td>
                    {showCost && (
                      <td className="moneyCol">{row.cost_usd > 0 ? formatUsd(row.cost_usd) : "—"}</td>
                    )}
                    <td>{formatTokens(movingAverage7(selectedRows, originalIndex))}</td>
                    <td>{formatPercent(row.cached, row.exact_tokens + row.billed_tokens)}</td>
                    <td>{formatTokens(row.codex_tokens)}</td>
                    <td>{formatTokens(row.claude_code_tokens)}</td>
                    <td>{row.claude_code_calls}</td>
                    {billedTokens > 0 && <td>{formatTokens(row.console_tokens)}</td>}
                    {openaiTokens > 0 && (
                      <td title={row.openai_api_usd ? `${row.openai_api_requests} requests, ${formatUsd(row.openai_api_usd)}` : undefined}>
                        {formatTokens(row.openai_api_tokens)}
                      </td>
                    )}
                    <td>{formatTokens(row.claude_chat_est)}</td>
                    <td>{formatTokens(row.chatgpt_est)}</td>
                    <td>{titleCase(row.driver)}</td>
                    {showFidelity && (
                      <td>
                        <span className={`pill ${label.tone}`}>{label.text}</span>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <p className="footerNote">
        Data lives in <code>data/daily-burn.json</code>, generated by <code>npm run data</code> from
        local logs plus a private estimates file. Raw exports, paths, and project names stay out of
        this app.
      </p>

      {menuOpen && (
        <div className="sheetLayer phoneOnly">
          <div className="scrim" onClick={() => setMenuOpen(false)} aria-hidden />
          <section className="sheet" role="dialog" aria-modal="true" aria-label="Settings">
            <div className="sheetHead">
              <span className="sheetGrip" aria-hidden />
              <h2>Settings</h2>
              <button type="button" className="phoneIcon" aria-label="Close settings" onClick={() => setMenuOpen(false)}>
                <span aria-hidden>×</span>
              </button>
            </div>
            <ConsoleSyncBar sync={sync} />
            <div className="sheetBlock">
              <p className="label">Appearance</p>
              <button
                type="button"
                className="fidelityToggle"
                aria-pressed={display.compact}
                onClick={() => setDisplay((prev) => ({ ...prev, compact: !prev.compact }))}
              >
                <i aria-hidden />
                Compact view
                <small>{display.compact ? "on" : "off"}</small>
              </button>
              <div className="sheetAppearance">{appearanceControls}</div>
            </div>
            <div className="sheetBlock">
              <p className="label">Snapshot</p>
              <button
                type="button"
                className="pause"
                onClick={() => {
                  setMenuOpen(false);
                  setTimeout(pauseInPlace, 50);
                }}
              >
                Pause this view
              </button>
              <p className="muted sheetHint">Freezes this tab as a static copy. Nothing is saved unless you confirm.</p>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

type DisplaySettings = {
  titleScale: number;
  figureScale: number;
  panelFigureScale: number;
  density: number;
  palette: string;
  /** Appearance controls collapsed to a thin bar. Persisted like the rest. */
  barCollapsed: boolean;
  /** Phone only: tighter tiles, smaller heatmap cells and type, so the trend fits on the first screen. */
  compact: boolean;
};
const DISPLAY_KEY = "token-burn-display";
/**
 * What a browser with no saved settings starts from. The built-ins are the
 * floor; data/display-defaults.json overrides them, and the "Save as default"
 * button writes that file - so the current look can become the default without
 * editing code, and it carries to a deployed copy or a cleared browser.
 */
const builtInDisplay: DisplaySettings = {
  titleScale: 1, figureScale: 1, panelFigureScale: 1, density: 1,
  palette: defaultPalette.key, barCollapsed: true, compact: true,
};
const defaultDisplay: DisplaySettings = {
  ...builtInDisplay,
  ...(savedDisplayDefaults as Partial<DisplaySettings>),
};
const clampScale = (value: number, min = 0.5) => Math.min(2, Math.max(min, Math.round(value * 10) / 10));

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

/**
 * Pause: replace this tab's live page with a static copy of itself (current DOM plus every
 * applied stylesheet, no scripts). The tab then has no dependency on the dev server, so it keeps
 * rendering after `npm run dev` stops. A file is written only if the user confirms the prompt.
 */
function pauseInPlace() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const css = Array.from(document.styleSheets)
    .map((sheet) => {
      try {
        return Array.from(sheet.cssRules).map((rule) => rule.cssText).join("\n");
      } catch {
        return "";
      }
    })
    .join("\n");
  const main = document.querySelector("main");
  if (!main) return;
  const clone = main.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("button").forEach((button) => {
    button.setAttribute("disabled", "");
    button.setAttribute("title", "Paused view: controls are inactive");
  });
  const html = `<!doctype html>
<html lang="en" style="background:${document.documentElement.style.background};color-scheme:${document.documentElement.style.colorScheme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token Burn Dashboard (paused ${stamp})</title>
<style>${css}</style>
<style>
.pausedBanner{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:12px;padding:8px 14px;font:700 12px/1.4 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#06232b;background:#ffdf43}
.pausedBanner button{margin-left:auto;width:26px;height:26px;border:1px solid rgba(6,35,43,.4);border-radius:6px;background:transparent;color:#06232b;font:700 16px/1 system-ui,sans-serif;cursor:pointer}
.pausedBanner button:hover{background:rgba(6,35,43,.12)}
</style>
</head>
<body style="background:${document.body.style.background};color:${document.body.style.color}">
<div class="pausedBanner" role="status">Paused view captured ${stamp}. Static copy; controls are inactive. Use the back button or reopen the dev URL to return to the live page.<button type="button" aria-label="Close banner" onclick="this.parentNode.remove()">&times;</button></div>
${clone.outerHTML}
</body>
</html>`;

  const saveCopy = window.confirm(
    `Pause will freeze this tab as a static view.\n\nAlso save a copy as an HTML file (token-burn-paused-${stamp}.html)?\n\nOK = pause and save a file.  Cancel = pause only, no file.`,
  );

  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));

  if (saveCopy) {
    const link = document.createElement("a");
    link.href = url;
    link.download = `token-burn-paused-${stamp.replace(/[: ]/g, "-")}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  // Navigate this tab to the static copy. A real navigation discards every script of the live
  // page, including Next's hot-reload client, which would otherwise call location.reload()
  // once it gives up reconnecting to a stopped dev server.
  window.location.assign(url);
}

function Metric({ label, value, note, short }: { label: string; value: string; note: string; short?: string }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <strong>{value}</strong>
      <NoteText note={note} short={short} />
    </div>
  );
}

/** A note with an optional shorter wording that phones show instead. */
function NoteText({ note, short }: { note: string; short?: string }) {
  if (!short) return <span>{note}</span>;
  return (
    <span>
      <span className="deskOnly">{note}</span>
      <span className="phoneOnly">{short}</span>
    </span>
  );
}

function shortDate(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The "i" button and its panel: the page description and the fidelity definitions. */
function AboutButton() {
  return (
    <details className="info">
      <summary aria-label="About this dashboard" title="About this dashboard">i</summary>
      <div className="infoPanel">
        <p>
          One normalized file, one local day (set by BURN_TZ), every source on the same
          axes. Exact columns come from local Codex and Claude Code logs; billed columns come from
          Anthropic&rsquo;s own meter. Chat columns are labeled estimates. Cache reads count toward
          burn and are shaded separately.
        </p>
        <p>
          <strong>Fidelity.</strong> Billed = Anthropic&rsquo;s own meter, the number that settles
          the invoice. Exact = measured from local session logs. Derived = stats-cache totals
          scaled by a measured de-duplication ratio. Estimated = interview-based or spread from
          message counts.
        </p>
      </div>
    </details>
  );
}

/** Phone only: one tappable line standing in for the Console sync bar. */
function PhoneSyncLine({ sync, onOpen }: { sync: ReturnType<typeof useConsoleSync>; onOpen: () => void }) {
  const { status, busy, unreachable } = sync;
  if (unreachable || !status) return null;
  const running = busy || status.running;
  const tone = running
    ? "working"
    : !status.hasCredential
      ? "idle"
      : status.authProblem || status.lastOk === false
        ? "bad"
        : "ok";
  const text = running
    ? `Pulling from Console${status.progress ? ` · ${status.progress.pct}%` : ""}`
    : !status.hasCredential
      ? "Console not connected"
      : tone === "bad"
        ? "Console sync needs attention"
        : `${status.billedDays} billed days · synced ${formatAge(status.ageMs)}`;
  return (
    <button type="button" className="phoneSync phoneOnly" onClick={onOpen}>
      <span className={`syncDot ${tone}`} aria-hidden />
      {text}
      <span aria-hidden className="phoneSyncChevron">›</span>
    </button>
  );
}

/**
 * Phone heatmap: one row per week, newest first, seven day cells plus a bar for the
 * week's total. Same colour scale as the desktop calendar, turned to fit a tall screen.
 */
function WeekRows({
  weeks,
  heatValue,
  mixValue,
  maxHeat,
  palette,
  metric,
}: {
  weeks: ReturnType<typeof calendarWeeks>;
  heatValue: (row: BurnRow) => number;
  mixValue: (row: BurnRow) => number;
  maxHeat: number;
  palette: Palette;
  metric: HeatMetric;
}) {
  const [all, setAll] = useState(false);
  const rows = [...weeks].reverse().map((week) => ({
    start: week[0].date,
    cells: week,
    total: week.reduce((sum, cell) => sum + (cell.row ? heatValue(cell.row) : 0), 0),
  }));
  const maxWeek = Math.max(...rows.map((r) => r.total), 1);
  const LIMIT = 12;
  const shown = all ? rows : rows.slice(0, LIMIT);
  const fmt = (n: number) => (metric === "cost" ? formatUsd(n) : formatTokens(n));
  // Linear on purpose: the cells already carry the log colour scale, so the bar shows true proportion.
  const width = (n: number) => (n > 0 ? Math.max(3, (n / maxWeek) * 100) : 0);
  return (
    <div className="weekRows phoneOnly">
      <div className="weekRow weekHead" aria-hidden>
        <span />
        <span className="weekCells">
          {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </span>
        <span>week</span>
      </div>
      {shown.map((week) => (
        <div key={week.start} className="weekRow">
          <span className="weekLabel">{shortDate(week.start)}</span>
          <span className="weekCells">
            {week.cells.map((cell) => {
              const row = cell.row;
              const title = row
                ? `${row.date}: ${fmt(heatValue(row))}, ${row.driver}`
                : `${cell.date}: no recorded usage`;
              return (
                <span
                  key={cell.date}
                  className={`cell${row ? "" : " empty"}`}
                  style={row ? heatStyle(heatValue(row), mixValue(row), maxHeat, palette) : undefined}
                  title={title}
                  aria-label={title}
                />
              );
            })}
          </span>
          <span className="weekTotal">
            <i style={{ width: `${width(week.total)}%` }} />
            <b>{week.total > 0 ? fmt(week.total) : "–"}</b>
          </span>
        </div>
      ))}
      {rows.length > LIMIT && (
        <button type="button" className="expand weekMore" onClick={() => setAll((prev) => !prev)}>
          {all ? `Latest ${LIMIT} weeks` : `All ${rows.length} weeks`}
        </button>
      )}
    </div>
  );
}

function MoneyMetric({ label, value, note, short }: { label: string; value: string; note: string; short?: string }) {
  return (
    <div className="stat moneyStat">
      <span className="label">{label}</span>
      <strong>{value}</strong>
      <NoteText note={note} short={short} />
    </div>
  );
}

/**
 * Console sync controls: schedule, manual pull, and the setup path.
 *
 * The setup path shows the command to run but never accepts a key through the
 * UI - there is no input here on purpose. The key goes into the Keychain via the
 * user's own terminal and is read only by the fetch script, server-side.
 */
function ConsoleSyncBar({ sync }: { sync: ReturnType<typeof useConsoleSync> }) {
  const { status, busy, unreachable } = sync;
  const [copied, setCopied] = useState(false);
  // Pressing Pull now / Backfill folds away any setup, auth, or warning panels so
  // the bar shows only pull progress and status. They stay folded after the pull
  // finishes until the user reopens them with "Show details".
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);

  // A paused/exported copy of this page has no server behind it.
  if (unreachable || !status) return null;

  const auth = status.authProblem;

  const tone = busy || status.running
    ? "working"
    : !status.hasCredential
      ? "idle"
      : auth || status.lastOk === false
        ? "bad"
        : "ok";

  const prog = status.progress;
  const running = busy || status.running;

  const startPull = (full: boolean) => {
    setDetailsCollapsed(true);
    sync.pull(full);
  };

  const showSetup = !status.hasCredential;
  const showAuth = Boolean(auth);
  const showWarnings = status.hasCredential && !auth && status.warnings.length > 0;
  const hasDetails = showSetup || showAuth || showWarnings;
  const detailsVisible = hasDetails && !running && !detailsCollapsed;

  const summary = running
    ? prog && prog.total > 0
      ? `${prog.phase} · ${prog.done}/${prog.total} requests`
      : "Starting…"
    : !status.hasCredential
      ? "Not connected"
      : auth
        ? `${auth.status} — credential not permitted`
        : status.lastOk === false
          ? status.lastMessage || "Last pull failed"
          : `${status.billedDays} billed day${status.billedDays === 1 ? "" : "s"} · updated ${formatAge(status.ageMs)}`;

  const copySetup = async () => {
    try {
      await navigator.clipboard.writeText(status.setupHint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked; the command is visible on screen anyway */
    }
  };

  return (
    <section className="syncBar" aria-label="Console sync">
      <div className="syncLead">
        <span className="label">Console sync</span>
        <span className={`syncDot ${tone}`} aria-hidden />
        <span className="syncSummary">{summary}</span>
      </div>

      {running && (
        <div
          className="syncProgress"
          role="progressbar"
          aria-valuenow={prog?.pct ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Console pull progress"
        >
          <span className="syncProgressTrack">
            <i style={{ width: `${Math.max(2, prog?.pct ?? 0)}%` }} />
          </span>
          <span className="syncPct">{prog?.pct ?? 0}%</span>
        </div>
      )}

      <div className="syncSchedule" role="group" aria-label="Automatic pull interval">
        <span className="label">Every</span>
        {SCHEDULE_OPTIONS.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={status.schedule === option.value}
            disabled={!status.hasCredential}
            onClick={() => sync.setSchedule(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="syncActions">
        <button
          type="button"
          className="syncPull"
          onClick={() => startPull(false)}
          disabled={running}
          title="Resumes from cached data: fetches only days newer than what is stored, plus a short re-check window for figures the provider is still revising."
        >
          {running ? "Pulling…" : "Pull now"}
        </button>
        <button
          type="button"
          className="syncBackfill"
          onClick={() => startPull(true)}
          disabled={running}
          title="Ignore the cache and re-pull the last 180 days. Slow: one request per week of tokens, one per day of Claude Code analytics."
        >
          Backfill 180d
        </button>
        {hasDetails && !running && detailsCollapsed && (
          <button
            type="button"
            className="syncDetailsToggle"
            onClick={() => setDetailsCollapsed(false)}
          >
            Show details
          </button>
        )}
        {detailsVisible && (
          <button
            type="button"
            className="syncDetailsToggle"
            onClick={() => setDetailsCollapsed(true)}
          >
            Hide details
          </button>
        )}
      </div>

      {detailsVisible && showSetup && (
        <div className="syncSetup">
          <p>
            {status.notConfiguredReason
              ? `No credential found (${status.notConfiguredReason}).`
              : "No credential found."}{" "}
            Store an Admin API key in your Keychain, then press Pull now. Run this in a terminal —
            the bare <code>-w</code> at the end makes it prompt, so the key never lands in your shell
            history, this repo, or any synced file:
          </p>
          <div className="syncCmd">
            <code>{status.setupHint}</code>
            <button type="button" onClick={copySetup}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <p className="muted">
            Needs an Admin API key (<code>sk-ant-admin01-…</code>) from Console → Settings → Admin
            keys, created by an org admin. Regular and workspace-scoped keys are refused by these
            endpoints, and the Admin API is unavailable to individual accounts without an
            organization. If your Claude Code runs on a Pro/Max subscription, expect this lane to
            stay empty — subscription traffic is not metered here.
          </p>
        </div>
      )}

      {detailsVisible && auth && (
        <div className="syncSetup syncAuthProblem">
          <p>
            <strong>
              HTTP {auth.status} using a {auth.kindLabel}.
            </strong>{" "}
            The credential reached Anthropic and was understood — it simply is not permitted to read
            organization usage and cost. This is a permissions problem, not a bad key.
          </p>
          <p>{auth.guidance}</p>
          {auth.kind === "plain-key" && (
            <div className="syncCmd">
              <code>https://platform.claude.com/settings/admin-keys</code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText("https://platform.claude.com/settings/admin-keys").catch(() => {});
                }}
              >
                Copy
              </button>
            </div>
          )}
          <p className="muted">
            Once you have the new key, replace the stored one with the same command as before — the{" "}
            <code>-U</code> flag overwrites in place:
          </p>
          <div className="syncCmd">
            <code>{status.setupHint}</code>
            <button type="button" onClick={copySetup}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <p className="muted">
            To see exactly which endpoints the current credential can reach, run{" "}
            <code>npm run data:console:check</code>.
            {auth.requestId ? ` Support reference: ${auth.requestId}.` : ""}
          </p>
        </div>
      )}

      {detailsVisible && showWarnings && (
        <p className="syncWarn">{status.warnings.join(" · ")}</p>
      )}
    </section>
  );
}

/** Paired local-vs-billed bars, one row per comparable day. */
function ReconcileChart({ rows }: { rows: BurnRow[] }) {
  const max = Math.max(...rows.map((r) => Math.max(r.claude_code_tokens, r.billed_claude_code_tokens)), 1);
  return (
    <div className="reconcileRows">
      {rows.map((row) => {
        // Only billed > local indicates missing data; the reverse is the
        // subscription-billed share, which the org meter cannot see.
        const gap = row.billed_claude_code_tokens - row.claude_code_tokens;
        return (
          <div key={row.date} className="reconcileRow">
            <span className="reconcileDate">{row.date.slice(5)}</span>
            <span className="reconcileBars">
              <i
                className="barLocal"
                style={{ width: `${(row.claude_code_tokens / max) * 100}%` }}
                title={`local log: ${formatTokens(row.claude_code_tokens)}`}
              />
              <i
                className="barBilled"
                style={{ width: `${(row.billed_claude_code_tokens / max) * 100}%` }}
                title={`billed: ${formatTokens(row.billed_claude_code_tokens)}`}
              />
            </span>
            <span
              className={`reconcileDrift${gap > 0 ? " off" : ""}`}
              title={
                gap > 0
                  ? `${formatTokens(gap)} billed but not present in local logs`
                  : "local logs exceed the bill: subscription-billed work the org meter does not see"
              }
            >
              {gap > 0 ? `−${formatTokens(gap)}` : "sub"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Panel({
  label,
  title,
  note,
  action,
  noWrapTitle,
  children,
}: {
  label: string;
  title: string;
  note: React.ReactNode;
  action?: React.ReactNode;
  noWrapTitle?: boolean;
  children: React.ReactNode;
}) {
  return (
    <article className="panel">
      <div className="panelHeader">
        <div>
          <p className="label">{label}</p>
          <h2 className={noWrapTitle ? "noWrap" : undefined}>{title}</h2>
        </div>
        <div className="panelAside">
          {action}
          <details className="panelInfo phoneOnly">
            <summary aria-label={`About ${title}`}>i</summary>
          </details>
          <p className="panelNote">{note}</p>
        </div>
      </div>
      {children}
    </article>
  );
}

function TrendChart({ weekly }: { weekly: ReturnType<typeof weeklyTotals> }) {
  const width = 720;
  const height = 260;
  const left = 46;
  const right = 16;
  const top = 24;
  const bottom = 34;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const max = Math.max(...weekly.map((w) => w.total), 1);
  const x = (index: number) => left + (weekly.length === 1 ? plotW / 2 : (index / (weekly.length - 1)) * plotW);
  const y = (value: number) => top + plotH - logNormalize(value, max) * plotH;
  // Break the line on weeks with no recorded usage instead of plunging to the floor.
  const path = (key: "total" | "fresh") => {
    let d = ""; let pen = false;
    weekly.forEach((w, i) => {
      if (w[key] <= 0) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(w[key]).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  /**
   * Bridge each gap with a dotted segment so the eye follows the series across
   * quiet weeks without reading the gap as measured zero.
   */
  const bridge = (key: "total" | "fresh") => {
    const points = weekly.map((w, i) => ({ i, v: w[key] })).filter((p) => p.v > 0);
    let d = "";
    for (let n = 1; n < points.length; n += 1) {
      const a = points[n - 1];
      const b = points[n];
      if (b.i - a.i <= 1) continue; // adjacent weeks are already joined by the solid line
      d += `M${x(a.i).toFixed(1)} ${y(a.v).toFixed(1)}L${x(b.i).toFixed(1)} ${y(b.v).toFixed(1)} `;
    }
    return d.trim();
  };
  const ticks = [1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000].filter((t) => t <= max * 1.2);
  const labelEvery = Math.max(1, Math.ceil(weekly.length / 6));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Weekly token burn trend line, log scale">
      {ticks.map((tick) => (
        <g key={tick}>
          <path d={`M${left} ${y(tick)}H${width - right}`} stroke="var(--line)" />
          <text x={left - 6} y={y(tick) + 4} textAnchor="end" fill="var(--muted)" fontSize="11">
            {formatTokens(tick)}
          </text>
        </g>
      ))}
      <path
        d={bridge("fresh")}
        fill="none"
        stroke="var(--fresh)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="0.5 3"
        opacity="0.65"
      />
      <path
        d={bridge("total")}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="0.5 3"
        opacity="0.75"
      />
      <path d={path("fresh")} fill="none" stroke="var(--fresh)" strokeWidth="2" strokeLinecap="round" />
      <path d={path("total")} fill="none" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      {weekly.map((w, i) =>
        w.total > 0 ? <circle key={w.week} cx={x(i).toFixed(1)} cy={y(w.total).toFixed(1)} r="3.5" fill="var(--accent)" /> : null,
      )}
      {weekly.map((w, i) =>
        // The last week is always labelled; drop a regular label that would crowd it.
        (i % labelEvery === 0 && weekly.length - 1 - i >= Math.ceil(labelEvery * 0.6)) || i === weekly.length - 1 ? (
          <text key={`l-${w.week}`} x={x(i)} y={height - 10} textAnchor="middle" fill="var(--muted)" fontSize="11">
            {w.week.slice(5)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function applySourceVisibility(rows: BurnRow[], visible: SourceVisibility): BurnRow[] {
  if (sourceColumns.every((source) => visible[source.key])) return rows;
  return rows
    .map((row) => {
      const codex = visible.codex_tokens ? row.codex_tokens : 0;
      const claudeCode = visible.claude_code_tokens ? row.claude_code_tokens : 0;
      const consoleTokens = visible.console_tokens ? row.console_tokens : 0;
      const openaiTokens = visible.openai_api_tokens ? row.openai_api_tokens : 0;
      const claudeChat = visible.claude_chat_est ? row.claude_chat_est : 0;
      const chatgpt = visible.chatgpt_est ? row.chatgpt_est : 0;
      const codexCached = visible.codex_tokens ? row.codex_cached : 0;
      const claudeCodeCached = visible.claude_code_tokens ? row.claude_code_cached : 0;
      const consoleCached = visible.console_tokens ? row.console_cached : 0;
      const openaiCached = visible.openai_api_tokens ? row.openai_api_cached : 0;
      const cached = codexCached + claudeCodeCached + consoleCached + openaiCached;
      const total = codex + claudeCode + consoleTokens + openaiTokens + claudeChat + chatgpt;
      // Money is billed against the Console lane, so it hides with that lane.
      const costUsd = visible.console_tokens ? row.cost_usd : 0;
      return {
        ...row,
        codex_tokens: codex,
        claude_code_tokens: claudeCode,
        claude_code_calls: visible.claude_code_tokens ? row.claude_code_calls : 0,
        console_tokens: consoleTokens,
        openai_api_tokens: openaiTokens,
        openai_api_requests: visible.openai_api_tokens ? row.openai_api_requests : 0,
        openai_api_usd: visible.openai_api_tokens ? row.openai_api_usd : 0,
        openai_api_models: visible.openai_api_tokens ? row.openai_api_models : {},
        claude_chat_est: claudeChat,
        chatgpt_est: chatgpt,
        total,
        codex_cached: codexCached,
        claude_code_cached: claudeCodeCached,
        console_cached: consoleCached,
        openai_api_cached: openaiCached,
        cached,
        fresh: total - cached,
        exact_tokens: codex + claudeCode,
        billed_tokens: consoleTokens + openaiTokens,
        estimated_tokens: claudeChat + chatgpt,
        cost_usd: costUsd,
        cost_cached_usd: visible.console_tokens ? row.cost_cached_usd : 0,
        console_models: visible.console_tokens ? row.console_models : {},
        codex_models: visible.codex_tokens ? row.codex_models : {},
        claude_code_models: visible.claude_code_tokens ? row.claude_code_models : {},
        billed_claude_code_tokens: visible.claude_code_tokens ? row.billed_claude_code_tokens : 0,
        codex_fidelity: codex ? row.codex_fidelity : "none",
        claude_code_fidelity: claudeCode ? row.claude_code_fidelity : "none",
        chat_fidelity: claudeChat + chatgpt ? row.chat_fidelity : "none",
        console_fidelity: consoleTokens ? row.console_fidelity : "none",
        openai_api_fidelity: openaiTokens ? row.openai_api_fidelity : "none",
        cost_fidelity: costUsd ? row.cost_fidelity : "none",
      };
    })
    .filter((row) => row.total > 0 || row.cost_usd > 0);
}

function buildDriverRows(selectedRows: BurnRow[], total: number) {
  const totals = new Map<string, { value: number; cost: number }>();

  for (const row of selectedRows) {
    // A day may be split across drivers; distribute its tokens and cost by share
    // so the bars reflect how the day was actually spent.
    const shares = Object.keys(row.driver_split).length
      ? Object.entries(row.driver_split)
      : ([[row.driver, 1]] as [string, number][]);
    for (const [label, share] of shares) {
      const entry = totals.get(label) || { value: 0, cost: 0 };
      entry.value += row.total * share;
      entry.cost += row.cost_usd * share;
      totals.set(label, entry);
    }
  }

  return Array.from(totals, ([label, entry]) => ({
    label,
    value: entry.value,
    cost: entry.cost,
    share: total ? Math.round((entry.value / total) * 100) : 0,
  }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

function buildNextActions(selectedRows: BurnRow[]) {
  const actions: { title: string; body: string }[] = [];
  if (selectedRows.length === 0) return [{ title: "No data in range", body: "Widen the window or add rows." }];

  const total = sumTokens(selectedRows);
  const cached = sumField(selectedRows, "cached");
  const fresh = sumField(selectedRows, "fresh");
  const calls = selectedRows.reduce((s, r) => s + r.claude_code_calls, 0);
  const spend = sumField(selectedRows, "cost_usd");
  const cachedSpend = sumField(selectedRows, "cost_cached_usd");
  const drivers = buildDriverRows(selectedRows, total);
  const unlabeled = drivers.find((d) => d.label === "unlabeled");

  // Money outranks token counts as a call to action, so it leads when it exists.
  if (spend > 0) {
    actions.push({
      title: `${formatUsd(cachedSpend)} of ${formatUsd(spend)} went on cache reads`,
      body: `${formatPercent(cachedSpend, spend)} of the bill re-reads context the model already saw. Cheapest token type, so a high share is normal on long sessions - and the first thing a tighter brief removes.`,
    });
  }

  if (unlabeled && unlabeled.share >= 20) {
    actions.push({
      title: `Label ${unlabeled.share}% of burn`,
      body: "Add driver rules in the private estimates file so this view can answer the question.",
    });
  } else if (drivers[0]) {
    actions.push({
      title: `${drivers[0].label} is the top driver at ${drivers[0].share}%`,
      body: `${formatTokens(drivers[0].value)} tokens. If that is the work that matters, keep going; if not, scope the next session elsewhere.`,
    });
  }

  actions.push({
    title: `${formatPercent(cached, total)} of burn is cache reads`,
    body: `Only ${formatTokens(fresh)} tokens were new material. A fresh session with a tight brief cuts re-reads without losing output.`,
  });

  if (calls > 0) {
    actions.push({
      title: `${formatTokens(Math.round(total / calls))} tokens per call`,
      body: `${calls.toLocaleString()} calls in view. This rises as sessions run long; subagents for search and review keep the main context small.`,
    });
  }

  const last = selectedRows[selectedRows.length - 1];
  const sorted = [...selectedRows].sort((a, b) => b.total - a.total);
  const top3 = sorted.slice(0, 3).reduce((s, r) => s + r.total, 0);
  actions.push({
    title: `Top 3 days are ${formatPercent(top3, total)} of the window`,
    body: `Burn is spiky, not steady. ${sorted.slice(0, 3).map((r) => r.date).join(", ")} are the days worth an evidence note. Last recorded: ${last.date}.`,
  });

  return actions.slice(0, 3);
}
