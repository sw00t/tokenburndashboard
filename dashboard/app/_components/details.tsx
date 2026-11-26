"use client";

import { useState } from "react";

import {
  type BurnRow,
  FIDELITY_TEXT,
  reconcilableRows,
  reconciliation,
  rowFidelityLabel,
  sumField,
  titleCase,
} from "../../lib/burn-data";
import { nextActions } from "../../lib/insights";
import { WORDS_PER_TOKEN, fermiScale, formatPercent, formatTokens, formatUsd, movingAverage7, sumTokens } from "../../lib/token-math";
import { InfoTip } from "./info-tip";
import { ExpandRow, Metric, Panel, PanelHeader } from "./panel";

export function ScaleEquivalentsPanel({ rows }: { rows: BurnRow[] }) {
  const fresh = sumField(rows, "fresh");
  return (
    <Panel
      label="Scale equivalents"
      title="Make the number human"
      note={
        <>
          Approximate comparisons; each figure&rsquo;s &ldquo;i&rdquo; shows its math. Fresh-only:{" "}
          {formatTokens(fresh * WORDS_PER_TOKEN)} words. Cache reads re-serve context the model already saw, so the fresh
          figure is closer to new material.
        </>
      }
    >
      <div className="equivalents">
        {fermiScale(sumTokens(rows), sumField(rows, "cost_usd")).map((item) => (
          <div key={item.label} className="equivalent">
            <span className="muted">
              {item.label} <InfoTip label={`How ${item.label} is computed`}>{item.note}</InfoTip>
            </span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function NextActionsPanel({ rows }: { rows: BurnRow[] }) {
  return (
    <Panel
      label="What next"
      title="What should the computer do next?"
      note="Heuristics computed from the rows in view. Read them as prompts, not verdicts."
    >
      <ul className="actions">
        {nextActions(rows).map((action) => (
          <li key={action.title}>
            <strong>{action.title}</strong>
            <span>{action.body}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function PeakDayPanel({ peakDay }: { peakDay: BurnRow | undefined }) {
  return (
    <Panel
      label="Peak day"
      title={peakDay ? titleCase(peakDay.driver) : "No Data"}
      note={peakDay?.evidence ? titleCase(peakDay.evidence) : "Add evidence notes to explain why a day spiked."}
    >
      <div className="sourceGrid peakGrid">
        <Metric label="Date" value={peakDay?.date || "n/a"} note="Local bucket" />
        <Metric
          label="Burn"
          value={formatTokens(peakDay?.total || 0)}
          note={peakDay ? `${formatPercent(peakDay.fresh, peakDay.total)} fresh` : ""}
          title={peakDay ? rowFidelityLabel(peakDay).text : undefined}
        />
        <Metric label="Calls" value={`${peakDay?.claude_code_calls || 0}`} note="Claude Code" />
        {peakDay && peakDay.cost_usd > 0 && <Metric label="Cost" value={formatUsd(peakDay.cost_usd)} note="Billed that day" />}
      </div>
    </Panel>
  );
}

/**
 * Collapsed by default to a header and a slim expand row; the grid stretches it
 * to the height of the Peak day panel beside it, so the two sit flush.
 */
export function MethodPanel({ rows, showCost }: { rows: BurnRow[]; showCost: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const billedTokens = sumField(rows, "billed_tokens");
  const openaiTokens = rows.reduce((s, r) => s + r.openai_api_tokens, 0);
  const openaiSpend = sumField(rows, "openai_api_usd");
  return (
    <Panel label="Method" title="How the numbers are made" className="collapsible">
      {expanded && (
        <ul className="method">
          <li>Burn = input + cache writes + cache reads + output, per call.</li>
          <li>Days bucket in America/Los_Angeles before summing.</li>
          <li>Claude Code = CLI plus Cowork, de-duplicated by message id.</li>
          <li>Calls = unique Claude Code API responses that day.</li>
          <li>Days whose logs were pruned are rebuilt from local aggregates and labeled derived.</li>
          <li>Estimates never merge into measured columns.</li>
          <li>A day may split across drivers; shares are fractional and sum to one.</li>
          <li>Model names come from each lane: the meter, the export, and local session logs.</li>
        <li>
          Local models = Ollama&rsquo;s server logs: prompt tokens processed plus tokens generated, per request. A
          reused cached prompt is not logged, so this lane has no cache-read share.
        </li>
          {billedTokens > 0 && <li>Console API = the meter, minus traffic a local log already counted.</li>}
          {openaiTokens > 0 && (
            <li>
              OpenAI API = the platform usage export, API keys only, UTC-day buckets
              {openaiSpend > 0 ? ` (${formatUsd(openaiSpend)} in view, kept apart from Anthropic spend)` : ""}. ChatGPT chat is
              not in it and stays estimated.
            </li>
          )}
          {showCost && (
            <li>
              Cost arrives on UTC days and is apportioned to local days by hourly token share, per token type. Window totals
              exact; per-day derived.
            </li>
          )}
        </ul>
      )}
      <ExpandRow expanded={expanded} onToggle={() => setExpanded((prev) => !prev)} more="Show the method" less="Hide the method" />
    </Panel>
  );
}

/** Local logs vs Anthropic's meter for Claude Code, on days both saw it. */
export function ReconcilePanel({ rows }: { rows: BurnRow[] }) {
  const recon = reconciliation(rows);
  if (!recon) return null;
  const plural = (n: number) => (n === 1 ? "" : "s");
  return (
    <section className="panel reconcile">
      <PanelHeader
        label="Reconciliation"
        title="Local logs vs the bill"
        note={
          <>
            Days where both a local session log and Anthropic&rsquo;s meter saw Claude Code. Only one direction means
            anything: bars where <em>billed</em> runs past <em>local</em> are work your logs missed.
          </>
        }
      />
      <div className="reconcileBody">
        <div className="reconcileHead">
          <div className="reconcileScore">
            <strong>{recon.gapDays === 0 ? "0" : formatTokens(recon.missingTokens)}</strong>
            <span className="muted">
              {recon.gapDays === 0
                ? `No day billed more Claude Code than the local logs captured, across ${recon.days} comparable day${plural(recon.days)}. The extraction is not missing measurable work.`
                : `tokens the invoice records that the local logs did not, across ${recon.gapDays} of ${recon.days} comparable day${plural(recon.days)} — the local extraction captured ${Math.round(recon.coverage * 100)}% of billed Claude Code on those days.`}
            </span>
            {(recon.worstGap || recon.subscriptionDays > 0) && (
              <InfoTip label="Reconciliation details">
                {recon.worstGap ? `Largest gap ${recon.worstGap.date}, ${formatTokens(recon.worstGapTokens)} unlogged. ` : ""}
                {recon.subscriptionDays > 0 &&
                  `On the other ${recon.subscriptionDays} day${plural(recon.subscriptionDays)} local exceeds billed, which is expected: subscription-billed Claude Code never reaches the organization meter.`}
              </InfoTip>
            )}
          </div>
          <div className="reconcileKey">
            <span>
              <i className="keyLocal" /> local log
            </span>
            <span>
              <i className="keyBilled" /> billed
            </span>
          </div>
        </div>
        <ReconcileChart rows={reconcilableRows(rows).slice(-24)} />
      </div>
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

/**
 * The last 30 active days with their 7-day average, newest first. Loads showing
 * a fifth of the rows; each row's trust tier shows on hover.
 */
export function DayTable({ rows, showCost }: { rows: BurnRow[]; showCost: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const recent = rows.slice(-30).reverse();
  const collapsedCount = Math.max(1, Math.ceil(recent.length / 5));
  const shown = expanded ? recent : recent.slice(0, collapsedCount);
  const hasBilled = rows.some((r) => r.console_tokens > 0);
  const hasOpenai = rows.some((r) => r.openai_api_tokens > 0);
  const hasLocal = rows.some((r) => r.local_model_tokens > 0);
  const indexByDate = new Map(rows.map((row, index) => [row.date, index]));

  return (
    <section className="panel">
      <PanelHeader
        label="Moving-average table"
        title="Last 30 active days"
        note="Newest first. Cache share is the part of measured tokens that were cache reads; 7d avg is per calendar day. Hover a row for its trust tier."
      />
      <div className="tableWrap">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Total</th>
              {showCost && <th className="moneyCol">Cost</th>}
              <th title="Average burn per calendar day over the 7 days ending on this row">7d avg</th>
              <th>Cache share</th>
              <th title={FIDELITY_TEXT.exact}>Codex</th>
              <th title={FIDELITY_TEXT.exact}>Claude Code</th>
              <th>Calls</th>
              {hasBilled && <th title={FIDELITY_TEXT.billed}>Console API</th>}
              {hasOpenai && <th title={FIDELITY_TEXT.billed}>OpenAI API</th>}
              {hasLocal && <th title={FIDELITY_TEXT.exact}>Local models</th>}
              <th title={FIDELITY_TEXT.estimated}>Claude chat</th>
              <th title={FIDELITY_TEXT.estimated}>ChatGPT</th>
              <th>Driver</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.date} title={`${row.date}: ${rowFidelityLabel(row).text}`}>
                <td>
                  <strong>{row.date}</strong>
                </td>
                <td>{formatTokens(row.total)}</td>
                {showCost && <td className="moneyCol">{row.cost_usd > 0 ? formatUsd(row.cost_usd) : "—"}</td>}
                <td>{formatTokens(movingAverage7(rows, indexByDate.get(row.date) ?? -1))}</td>
                <td>{formatPercent(row.cached, row.exact_tokens + row.billed_tokens)}</td>
                <td>{formatTokens(row.codex_tokens)}</td>
                <td>{formatTokens(row.claude_code_tokens)}</td>
                <td>{row.claude_code_calls}</td>
                {hasBilled && <td>{formatTokens(row.console_tokens)}</td>}
                {hasOpenai && (
                  <td title={row.openai_api_usd ? `${row.openai_api_requests} requests, ${formatUsd(row.openai_api_usd)}` : undefined}>
                    {formatTokens(row.openai_api_tokens)}
                  </td>
                )}
                {hasLocal && (
                  <td title={row.local_model_requests ? `${row.local_model_requests} requests` : undefined}>
                    {formatTokens(row.local_model_tokens)}
                  </td>
                )}
                <td>{formatTokens(row.claude_chat_est)}</td>
                <td>{formatTokens(row.chatgpt_est)}</td>
                <td>{titleCase(row.driver)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ExpandRow
        expanded={expanded}
        onToggle={() => setExpanded((prev) => !prev)}
        more={`Show all ${recent.length} days`}
        less={`Collapse to the latest ${collapsedCount}`}
      />
    </section>
  );
}
