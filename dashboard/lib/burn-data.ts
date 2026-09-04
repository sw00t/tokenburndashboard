export const sourceColumns = [
  { key: "codex_tokens", label: "Codex", fidelity: "exact", cachedKey: "codex_cached" },
  { key: "claude_code_tokens", label: "Claude Code", fidelity: "exact", cachedKey: "claude_code_cached" },
  { key: "console_tokens", label: "Console API", fidelity: "billed", cachedKey: "console_cached" },
  { key: "claude_chat_est", label: "Claude chat", fidelity: "estimated", cachedKey: null },
  { key: "chatgpt_est", label: "ChatGPT", fidelity: "estimated", cachedKey: null },
] as const;

export type SourceKey = (typeof sourceColumns)[number]["key"];

/**
 * Trust tiers, best first.
 *   billed    - Anthropic's own meter (Usage & Cost Admin API). Settles the bill.
 *   exact     - measured from a local session log on this machine.
 *   derived   - a local aggregate scaled by a measured correction factor.
 *   estimated - interview-based, or spread across days by message share.
 */
export type Fidelity = "billed" | "exact" | "derived" | "estimated" | "none";

export type RawBurnRow = {
  date: string;
  codex_tokens?: number;
  claude_code_tokens?: number;
  claude_code_calls?: number;
  claude_chat_est?: number;
  chatgpt_est?: number;
  total?: number;
  driver: string;
  evidence?: string;
  // Optional extras produced by scripts/build-rows.mjs
  codex_cached?: number;
  claude_code_cached?: number;
  codex_fidelity?: string;
  claude_code_fidelity?: string;
  chat_fidelity?: string;
  // Optional extras produced by scripts/fetch-console.mjs, merged by build-rows.mjs
  console_tokens?: number;
  console_cached?: number;
  console_fidelity?: string;
  cost_usd?: number;
  cost_cached_usd?: number;
  cost_fidelity?: string;
  billed_claude_code_tokens?: number;
  console_models?: Record<string, number>;
  driver_split?: Record<string, number>;
};

export type BurnRow = {
  date: string;
  codex_tokens: number;
  claude_code_tokens: number;
  claude_code_calls: number;
  claude_chat_est: number;
  chatgpt_est: number;
  console_tokens: number;
  total: number;
  driver: string;
  /** Fractional attribution across drivers, summing to 1. Empty when a day has one driver. */
  driver_split: Record<string, number>;
  evidence: string;
  codex_cached: number;
  claude_code_cached: number;
  console_cached: number;
  /** cache-read tokens across measured sources */
  cached: number;
  /** everything that was not a cache read: fresh input, cache writes, output, and chat estimates */
  fresh: number;
  exact_tokens: number;
  billed_tokens: number;
  estimated_tokens: number;
  /** real money for the day, from the Console cost report. 0 when unbilled. */
  cost_usd: number;
  /** the slice of cost_usd spent re-reading cached context */
  cost_cached_usd: number;
  /**
   * What Anthropic metered for Claude Code that day. Never added to `total` -
   * it exists so the dashboard can check the local extraction against the bill.
   */
  billed_claude_code_tokens: number;
  /** Per-model token split of the console lane. Empty when the meter reported none. */
  console_models: Record<string, number>;
  codex_fidelity: Fidelity;
  claude_code_fidelity: Fidelity;
  chat_fidelity: Fidelity;
  console_fidelity: Fidelity;
  cost_fidelity: Fidelity;
};

export function normalizeRows(rows: RawBurnRow[]): BurnRow[] {
  return rows
    .map((row) => {
      const codex = asNumber(row.codex_tokens);
      const claudeCode = asNumber(row.claude_code_tokens);
      const consoleTokens = asNumber(row.console_tokens);
      const claudeChat = asNumber(row.claude_chat_est);
      const chatgpt = asNumber(row.chatgpt_est);
      const computedTotal = codex + claudeCode + consoleTokens + claudeChat + chatgpt;
      const total = asNumber(row.total) || computedTotal;
      const codexCached = Math.min(codex, asNumber(row.codex_cached));
      const claudeCodeCached = Math.min(claudeCode, asNumber(row.claude_code_cached));
      const consoleCached = Math.min(consoleTokens, asNumber(row.console_cached));
      const cached = codexCached + claudeCodeCached + consoleCached;

      return {
        date: row.date,
        codex_tokens: codex,
        claude_code_tokens: claudeCode,
        claude_code_calls: asNumber(row.claude_code_calls),
        claude_chat_est: claudeChat,
        chatgpt_est: chatgpt,
        console_tokens: consoleTokens,
        total,
        driver: row.driver || "unlabeled",
        driver_split: row.driver_split || {},
        evidence: row.evidence || "",
        codex_cached: codexCached,
        claude_code_cached: claudeCodeCached,
        console_cached: consoleCached,
        cached,
        fresh: total - cached,
        exact_tokens: codex + claudeCode,
        billed_tokens: consoleTokens,
        estimated_tokens: claudeChat + chatgpt,
        cost_usd: asNumber(row.cost_usd),
        cost_cached_usd: asNumber(row.cost_cached_usd),
        billed_claude_code_tokens: asNumber(row.billed_claude_code_tokens),
        console_models: row.console_models || {},
        codex_fidelity: asFidelity(row.codex_fidelity, codex ? "exact" : "none"),
        claude_code_fidelity: asFidelity(row.claude_code_fidelity, claudeCode ? "exact" : "none"),
        chat_fidelity: asFidelity(row.chat_fidelity, claudeChat + chatgpt ? "estimated" : "none"),
        console_fidelity: asFidelity(row.console_fidelity, consoleTokens ? "billed" : "none"),
        cost_fidelity: asFidelity(row.cost_fidelity, asNumber(row.cost_usd) ? "billed" : "none"),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function sumSource(rows: BurnRow[], key: SourceKey) {
  return rows.reduce((sum, row) => sum + row[key], 0);
}

export type SumField =
  | "cached"
  | "fresh"
  | "exact_tokens"
  | "billed_tokens"
  | "estimated_tokens"
  | "codex_cached"
  | "claude_code_cached"
  | "console_cached"
  | "cost_usd"
  | "cost_cached_usd"
  | "billed_claude_code_tokens";

export function sumField(rows: BurnRow[], key: SumField) {
  return rows.reduce((sum, row) => sum + row[key], 0);
}

/** Does this window carry any real money? Drives whether cost UI renders at all. */
export function hasCostData(rows: BurnRow[]) {
  return rows.some((row) => row.cost_usd > 0);
}

/** Sentence-cased for display: driver labels and headings are stored lowercase. */
export function titleCase(value: string) {
  return value
    .split(/([\s-])/)
    .map((part) => (/^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part))
    .join("");
}

export type ModelTotal = { model: string; label: string; tokens: number; share: number };

/**
 * Per-model token totals across the window, largest first. Only the console lane
 * carries model attribution - local logs record a model per call but the merge
 * does not publish it, so this is billed usage only.
 */
export function modelTotals(rows: BurnRow[]): ModelTotal[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    for (const [model, tokens] of Object.entries(row.console_models)) {
      totals.set(model, (totals.get(model) || 0) + tokens);
    }
  }
  const sum = [...totals.values()].reduce((s, v) => s + v, 0);
  return [...totals]
    .map(([model, tokens]) => ({
      model,
      label: prettyModel(model),
      tokens,
      share: sum ? tokens / sum : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

/** "claude-opus-4-5-20251101" -> "Claude Opus 4.5". Falls back to the raw id. */
export function prettyModel(id: string) {
  const cleaned = id
    .replace(/^(anthropic|us|eu|apac)\./, "")
    .replace(/[@-]?\d{8}$/, "")
    .replace(/-v\d+:\d+$/, "");
  const match = cleaned.match(/^claude-([a-z]+)(?:-(\d+))?(?:-(\d+))?/);
  if (!match) return cleaned || id;
  const [, family, major, minor] = match;
  const name = family[0].toUpperCase() + family.slice(1);
  const version = major ? (minor ? `${major}.${minor}` : major) : "";
  return `Claude ${name}${version ? ` ${version}` : ""}`.trim();
}

/** Days where both a local log and Anthropic's meter saw Claude Code, for reconciliation. */
export function reconcilableRows(rows: BurnRow[]) {
  return rows.filter((row) => row.billed_claude_code_tokens > 0 && row.claude_code_tokens > 0);
}

/**
 * Compare local session logs against Anthropic's meter for Claude Code.
 *
 * The two are NOT symmetric, and reading them as a single drift percentage is
 * wrong whenever Claude Code runs on mixed billing:
 *
 *   local > billed  Expected. Subscription-billed Claude Code never reaches the
 *                   organization's usage meter, so local logs legitimately see
 *                   work the bill does not. This is a billing split, not an error.
 *
 *   billed > local  Actionable. The invoice records Claude Code work that the
 *                   local extraction did not capture - pruned session logs, a
 *                   de-duplication bug, or a machine whose logs we never read.
 *                   This is the only direction that indicates missing data.
 *
 * So the headline is the gap in the second direction, not a ratio of the two.
 */
export function reconciliation(rows: BurnRow[]) {
  const pairs = reconcilableRows(rows);
  if (pairs.length === 0) return null;

  const local = pairs.reduce((s, r) => s + r.claude_code_tokens, 0);
  const billed = pairs.reduce((s, r) => s + r.billed_claude_code_tokens, 0);

  // Days where the bill proves work the local logs missed.
  const gaps = pairs.filter((r) => r.billed_claude_code_tokens > r.claude_code_tokens);
  const missingTokens = gaps.reduce(
    (s, r) => s + (r.billed_claude_code_tokens - r.claude_code_tokens),
    0,
  );
  const billedOnGapDays = gaps.reduce((s, r) => s + r.billed_claude_code_tokens, 0);
  const worstGap = gaps.reduce(
    (acc, r) => {
      const miss = r.billed_claude_code_tokens - r.claude_code_tokens;
      return miss > acc.miss ? { miss, row: r } : acc;
    },
    { miss: 0, row: gaps[0] },
  );

  // Days where local exceeds the bill: the subscription-billed share.
  const subscriptionDays = pairs.length - gaps.length;

  return {
    days: pairs.length,
    local,
    billed,
    gapDays: gaps.length,
    gaps,
    missingTokens,
    /** Of the billed tokens on gap days, the share the local logs did capture. */
    coverage: billedOnGapDays ? 1 - missingTokens / billedOnGapDays : 1,
    worstGap: worstGap.row || null,
    worstGapTokens: worstGap.miss,
    subscriptionDays,
  };
}

/** One short trust label per row for tables and tooltips. */
export function rowFidelityLabel(row: BurnRow): { text: string; tone: "billed" | "exact" | "derived" | "estimated" } {
  const hasEst = row.estimated_tokens > 0;
  const suffix = hasEst ? " + est. chat" : "";
  // A settled bill outranks anything measured locally.
  if (row.cost_fidelity === "billed") return { text: `billed${suffix}`, tone: "billed" };
  const codeTone = row.claude_code_fidelity === "none" ? row.codex_fidelity : row.claude_code_fidelity;
  const base = codeTone === "none" ? "estimated" : codeTone;
  if (base === "billed") return { text: `billed${suffix}`, tone: "billed" };
  if (base === "exact") return { text: `exact${suffix}`, tone: "exact" };
  if (base === "derived") return { text: `derived${suffix}`, tone: "derived" };
  return { text: "estimated", tone: "estimated" };
}

function asNumber(value: number | undefined) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function asFidelity(value: string | undefined, fallback: Fidelity): Fidelity {
  return value === "billed" || value === "exact" || value === "derived" || value === "estimated" || value === "none"
    ? value
    : fallback;
}
