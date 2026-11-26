import { type BurnRow, sumField } from "./burn-data";
import { formatPercent, formatTokens, formatUsd, sumTokens } from "./token-math";

export type DriverTotal = { label: string; value: number; cost: number; share: number };

/**
 * Tokens and cost per work driver, largest first, top 8. A day split across
 * drivers (driver_split) distributes its tokens and cost by share, so the bars
 * reflect how the day was actually spent.
 */
export function driverTotals(rows: BurnRow[]): DriverTotal[] {
  const total = sumTokens(rows);
  const totals = new Map<string, { value: number; cost: number }>();
  for (const row of rows) {
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

export type NextAction = { title: string; body: string };

/** Up to three prompts for what to do next, computed from the rows in view. */
export function nextActions(rows: BurnRow[]): NextAction[] {
  if (rows.length === 0) return [{ title: "No data in range", body: "Widen the window or add rows." }];

  const actions: NextAction[] = [];
  const total = sumTokens(rows);
  const cached = sumField(rows, "cached");
  const fresh = sumField(rows, "fresh");
  const calls = rows.reduce((s, r) => s + r.claude_code_calls, 0);
  const spend = sumField(rows, "cost_usd");
  const cachedSpend = sumField(rows, "cost_cached_usd");
  const drivers = driverTotals(rows);
  const unlabeled = drivers.find((d) => d.label === "unlabeled");

  // Money outranks token counts as a call to action, so it leads when it exists.
  if (spend > 0) {
    actions.push({
      title: `${formatUsd(cachedSpend)} of ${formatUsd(spend)} went on cache reads`,
      body: `${formatPercent(cachedSpend, spend)} of the bill re-reads context the model already saw. Cheapest token type, so a high share is normal on long sessions, and the first thing a tighter brief removes.`,
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
    // Calls are counted for Claude Code only, so divide Claude Code tokens by them,
    // not the window total (which also holds Codex, API lanes, and chat estimates).
    const claudeCodeTokens = rows.reduce((s, r) => s + r.claude_code_tokens, 0);
    actions.push({
      title: `${formatTokens(Math.round(claudeCodeTokens / calls))} tokens per Claude Code call`,
      body: `${calls.toLocaleString()} calls in view. This rises as sessions run long; subagents for search and review keep the main context small.`,
    });
  }

  const sorted = [...rows].sort((a, b) => b.total - a.total);
  const top3 = sorted.slice(0, 3).reduce((s, r) => s + r.total, 0);
  actions.push({
    title: `Top 3 days are ${formatPercent(top3, total)} of the window`,
    body: `Burn is spiky, not steady. ${sorted.slice(0, 3).map((r) => r.date).join(", ")} are the days worth an evidence note. Last recorded: ${rows[rows.length - 1].date}.`,
  });

  return actions.slice(0, 3);
}
