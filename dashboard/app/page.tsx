"use client";

import { useMemo, useState } from "react";

// Seeded from the committed synthetic sample so a fresh clone builds and renders.
// This machine's real data/daily-burn.json and data/burn-meta.json are gitignored
// and swapped in on load through /api/burn-rows and /api/burn-meta.
import rawMeta from "../data/burn-meta.sample.json";
import rawRows from "../data/daily-burn.sample.json";
import {
  type BurnRow,
  type RawBurnRow,
  type SourceKey,
  type SourceVisibility,
  allSourcesVisible,
  applySourceVisibility,
  derivedDayCount,
  hasCostData,
  normalizeRows,
  sourceColumns,
  sumField,
} from "../lib/burn-data";
import { type WindowKey, getWindowRows, shortDate } from "../lib/date-windows";
import { useDisplaySettings } from "../lib/display-settings";
import { type BurnMeta, asBurnMeta } from "../lib/freshness";
import { pauseInPlace } from "../lib/pause";
import { costPerMillion, formatPercent, formatTokens, formatUsd, movingAverage7, sumTokens } from "../lib/token-math";
import { useConsoleSync } from "../lib/use-console-sync";
import { DriversPanel, ModelsPanel, SourceSplitPanel } from "./_components/breakdowns";
import { PhoneSyncLine } from "./_components/console-sync";
import { AboutButton, RangePicker, SettingsMenu, SourceToggles } from "./_components/controls";
import { DayTable, MethodPanel, NextActionsPanel, PeakDayPanel, ReconcilePanel, ScaleEquivalentsPanel } from "./_components/details";
import { FreshnessStrip } from "./_components/freshness-strip";
import { HeatmapPanel } from "./_components/heatmap";
import { InfoTip } from "./_components/info-tip";
import { Metric } from "./_components/panel";
import { PhoneBar } from "./_components/phone";
import { TrendPanel } from "./_components/trend-chart";

const initialRows = normalizeRows(rawRows as RawBurnRow[]);

export default function TokenBurnDashboard() {
  const settings = useDisplaySettings();
  const [windowKey, setWindowKey] = useState<WindowKey>("1y");
  const [visible, setVisible] = useState<SourceVisibility>(allSourcesVisible);
  const [allRows, setAllRows] = useState<BurnRow[]>(initialRows);
  const [meta, setMeta] = useState<BurnMeta | null>(() => asBurnMeta(rawMeta));
  const [menuOpen, setMenuOpen] = useState(false);

  // Console sync owns its own schedule server-side; the page keeps it honest while
  // it is open, and swaps in fresh rows (and lane freshness) when a pull lands.
  const sync = useConsoleSync(
    (raw) => setAllRows(normalizeRows(raw)),
    (next) => setMeta((prev) => asBurnMeta(next) || prev),
  );

  const rows = useMemo(() => getWindowRows(applySourceVisibility(allRows, visible), windowKey), [allRows, visible, windowKey]);
  const toggleSource = (key: SourceKey) => setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  const hiddenCount = sourceColumns.filter((source) => !visible[source.key]).length;
  const showCost = hasCostData(rows);
  const peakDay = rows.reduce<BurnRow | undefined>((peak, row) => (!peak || row.total > peak.total ? row : peak), undefined);

  return (
    <main className={`page${settings.display.compact ? " compact" : ""}`} style={settings.mainStyle} data-scheme={settings.palette.scheme}>
      <section className="hero">
        <div className="titleRow">
          <div className="titleText">
            <div className="titleLine">
              <h1>Token Burn Dashboard</h1>
              <p className="subtitle">AI Usage by Day, Source, and Work Driver</p>
            </div>
            <PhoneSyncLine sync={sync} onOpen={() => setMenuOpen(true)} />
          </div>
          <div className="titleActions deskOnly">
            <AboutButton />
            <SettingsMenu settings={settings} sync={sync} />
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
          <RangePicker value={windowKey} onChange={setWindowKey} />
          <div className="sources" aria-label="Show or hide sources">
            <SourceToggles visible={visible} onToggle={toggleSource} />
          </div>
          {hiddenCount > 0 && (
            <p className="muted controlsNote">
              {hiddenCount} source{hiddenCount === 1 ? "" : "s"} hidden. Every view below recomputes on the visible sources only.
            </p>
          )}
        </div>
      </section>

      <PhoneBar
        windowKey={windowKey}
        onWindow={setWindowKey}
        visible={visible}
        onToggleSource={toggleSource}
        rows={rows}
        sync={sync}
        settings={settings}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
      />

      <FreshnessStrip meta={meta} hydrated={settings.hydrated} canPull={!sync.unreachable && !!sync.status} />

      <section className="grid chartsGrid">
        <HeatmapPanel rows={rows} showCost={showCost} palette={settings.palette} />
        <TrendPanel rows={rows} />
      </section>

      <SummaryStats rows={rows} peakDay={peakDay} />
      {showCost && <MoneySummary rows={rows} />}

      <section className="grid">
        <SourceSplitPanel rows={rows} />
        <DriversPanel rows={rows} showCost={showCost} />
      </section>

      <ModelsPanel rows={rows} />

      <section className="grid">
        <ScaleEquivalentsPanel rows={rows} />
        <NextActionsPanel rows={rows} />
      </section>

      <section className="grid">
        <PeakDayPanel peakDay={peakDay} />
        <MethodPanel rows={rows} showCost={showCost} />
      </section>

      <ReconcilePanel rows={rows} />
      <DayTable rows={rows} showCost={showCost} />

      <footer className="footerNote">
        Data sources{" "}
        <InfoTip label="Where this data comes from">
          Data lives in <code>data/daily-burn.json</code>, generated by <code>npm run data</code> from local logs, the
          providers&rsquo; meters, and a private estimates file. Raw exports, paths, and project names stay out of this app.
        </InfoTip>
      </footer>
    </main>
  );
}

/** The four headline tiles. Trust tiers for the total show on hover. */
function SummaryStats({ rows, peakDay }: { rows: BurnRow[]; peakDay: BurnRow | undefined }) {
  const total = sumTokens(rows);
  const cached = sumField(rows, "cached");
  const calls = rows.reduce((sum, row) => sum + row.claude_code_calls, 0);
  const lastAverage = rows.length > 0 ? movingAverage7(rows, rows.length - 1) : 0;
  const derivedDays = derivedDayCount(rows);
  // exact_tokens covers both local lanes, including days rebuilt after pruning,
  // so it is "local logs" with the derived days called out, not "exact".
  const trustBreakdown = [
    `local logs ${formatTokens(sumField(rows, "exact_tokens"))}${derivedDays > 0 ? ` (${derivedDays} day${derivedDays === 1 ? "" : "s"} derived)` : ""}`,
    `billed ${formatTokens(sumField(rows, "billed_tokens"))}`,
    `estimated ${formatTokens(sumField(rows, "estimated_tokens"))}`,
  ].join(" · ");

  return (
    <section className="stats" aria-label="Token burn summary">
      <Metric
        label="Total burn"
        value={formatTokens(total)}
        note={`${formatPercent(cached, total)} cache reads`}
        short={`${formatPercent(cached, total)} cached`}
        title={trustBreakdown}
      />
      <Metric
        label="Peak day"
        value={formatTokens(peakDay?.total || 0)}
        note={peakDay?.date || "n/a"}
        short={peakDay ? shortDate(peakDay.date) : "n/a"}
      />
      <Metric
        label="7d average"
        value={formatTokens(lastAverage)}
        note="per day"
        info="Average burn per calendar day over the 7 days ending on the newest row in view. Idle days count as zero."
      />
      <Metric label="API calls" value={calls.toLocaleString()} note={`${rows.length} active days`} short={`${rows.length} days`} />
    </section>
  );
}

/** Real money from Anthropic's meter, shown only when the window has a bill. */
function MoneySummary({ rows }: { rows: BurnRow[] }) {
  const spend = sumField(rows, "cost_usd");
  const cachedSpend = sumField(rows, "cost_cached_usd");
  // The tokens `spend` paid for: the whole Anthropic meter, including Claude Code
  // traffic the console lane subtracts to avoid double-counting burn. OpenAI
  // tokens are excluded because their dollars are not in `spend`.
  const billedTokens = sumField(rows, "anthropic_billed_tokens");
  const spendDays = rows.filter((row) => row.cost_usd > 0).length;
  return (
    <section className="money" aria-label="Billed spend summary">
      <div className="moneyLead">
        <span className="label">
          Billed{" "}
          <InfoTip label="About billed spend">
            Real money, from Anthropic&rsquo;s own meter. Everything else on the page is tokens; everything here settled
            on an invoice. Cost arrives on UTC days and is apportioned to local days by hourly token share.
          </InfoTip>
        </span>
      </div>
      <div className="moneyGrid">
        <Metric money label="Total spend" value={formatUsd(spend)} note={`${spendDays} billed day${spendDays === 1 ? "" : "s"}`} short={`${spendDays} days`} />
        <Metric
          money
          label="Per 1M tokens"
          value={billedTokens > 0 ? formatUsd(costPerMillion(spend, billedTokens)) : "n/a"}
          note={`blended rate on ${formatTokens(billedTokens)} Anthropic-billed tokens`}
          short="blended"
        />
        <Metric
          money
          label="Cache reads"
          value={formatUsd(cachedSpend)}
          note={`${formatPercent(cachedSpend, spend)} of spend re-reading context`}
          short={`${formatPercent(cachedSpend, spend)} of spend`}
        />
        <Metric
          money
          label="Per billed day"
          value={formatUsd(spendDays ? spend / spendDays : 0)}
          note="mean across days with a charge"
          short="mean"
        />
      </div>
    </section>
  );
}
