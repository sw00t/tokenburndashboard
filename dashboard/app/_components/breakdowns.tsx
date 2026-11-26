"use client";

import { useState } from "react";

import {
  type BurnRow,
  FIDELITY_TEXT,
  VENDOR_LABEL,
  modelTotals,
  planPeaks,
  sourceColumns,
  sumField,
  sumSource,
  titleCase,
} from "../../lib/burn-data";
import { driverTotals } from "../../lib/insights";
import { formatPercent, formatTokens, formatUsd } from "../../lib/token-math";
import { InfoTip } from "./info-tip";
import { ExpandRow, Panel, PanelHeader, VendorMark } from "./panel";

/** Each source's share of the window. Hover a figure for how it was measured. */
export function SourceSplitPanel({ rows }: { rows: BurnRow[] }) {
  const sourceTotal = sourceColumns.reduce((sum, source) => sum + sumSource(rows, source.key), 0);
  const plan = planPeaks(rows);

  return (
    <Panel label="Source split" title="By source" note="Each source as a share of the selected window. Hover a figure for how it was measured.">
      <div className="sourceGrid">
        {sourceColumns.filter((source) => source.key !== "chatgpt_est").map((source) => {
          const value = sumSource(rows, source.key);
          const share = sourceTotal ? Math.round((value / sourceTotal) * 100) : 0;
          const tier = FIDELITY_TEXT[source.fidelity];

          // A measured signal for the subscription stands in for the flat chat estimate.
          if (source.key === "claude_chat_est" && plan) {
            return (
              <div key={source.key} className="source" title="measured: the Claude desktop app's plan-limit meter">
                <strong>{plan.sevenDay.pct}%</strong>
                <span className="muted">
                  Claude plan 7-day limit, peak {plan.sevenDay.date}{" "}
                  <InfoTip label="Plan meter details">
                    5-hour peak {plan.fiveHour.pct}% on {plan.fiveHour.date}. Latest {plan.latest.pct7d}% (7-day) and{" "}
                    {plan.latest.pct5h}% (5-hour), from {plan.sampledDays} sampled days.
                    {value > 0 && ` The Claude chat estimate, ${formatTokens(value)} (${share}%), still counts in the totals.`}
                  </InfoTip>
                </span>
              </div>
            );
          }

          const cachedValue = source.cachedKey ? sumField(rows, source.cachedKey) : 0;
          return (
            <div key={source.key} className="source" title={tier}>
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
  );
}

export function DriversPanel({ rows, showCost }: { rows: BurnRow[]; showCost: boolean }) {
  const drivers = driverTotals(rows);
  return (
    <Panel
      label="Drivers"
      title={showCost ? "What Is Burning Tokens and Money" : "What Is Burning Tokens"}
      noWrapTitle
      note={
        <>
          Grouped by driver, sorted by tokens.
          <br />
          {showCost ? "The money column is the billed share landing on that driver." : "Share is of the selected window."}
        </>
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
            {showCost && <span className="driverCost">{driver.cost > 0 ? formatUsd(driver.cost) : "—"}</span>}
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** Model rows shown before the "Show more" button. */
const MODEL_CAP = 12;

/**
 * Tokens per model, largest first, from every lane that names one. The top
 * MODEL_CAP rows show; the rest fold behind a button that says how many tokens
 * they hold, so nothing silently drops out. Billed vs local shows on hover and
 * in the bar colour.
 */
export function ModelsPanel({ rows }: { rows: BurnRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const models = modelTotals(rows);
  if (models.length === 0) return null;
  const capped = models.length > MODEL_CAP;
  const shown = expanded ? models : models.slice(0, MODEL_CAP);
  const hiddenTokens = models.slice(MODEL_CAP).reduce((s, m) => s + m.tokens, 0);

  return (
    <section className="panel modelsPanel">
      <PanelHeader
        label="Models"
        title="Which Model Did the Work"
        noWrapTitle
        note="Every lane that names a model: Anthropic's meter, OpenAI's export, Codex and Claude Code session logs, and local runners such as Ollama, named in the left column. Billed and local rows stay separate; hover a name to see which."
      />
      <div className="modelGrid">
        {shown.map((model) => (
          <div key={`${model.lane}:${model.vendor}:${model.model}`} className={`modelRow ${model.lane}`}>
            <small className={`modelVendor ${model.vendor}`}>
              <VendorMark vendor={model.vendor} />
              {VENDOR_LABEL[model.vendor]}
            </small>
            <strong
              title={`${model.model}, ${model.lane === "billed" ? FIDELITY_TEXT.billed : model.vendor === "ollama" ? "exact: Ollama's own per-request counts, run on this machine" : "local session logs (exact, or derived where pruned)"}`}
            >
              {model.label}
            </strong>
            <span className="track">
              <i style={{ width: `${Math.max(1, model.share * 100)}%` }} />
            </span>
            <span className="modelValue">{formatTokens(model.tokens)}</span>
            <span className="modelShare">{Math.round(model.share * 100)}%</span>
          </div>
        ))}
      </div>
      {capped && (
        <ExpandRow
          expanded={expanded}
          onToggle={() => setExpanded((prev) => !prev)}
          more={`Show ${models.length - MODEL_CAP} more (${formatTokens(hiddenTokens)})`}
          less={`Collapse to top ${MODEL_CAP}`}
        />
      )}
    </section>
  );
}

