export const sourceColumns = [
  { key: "codex_tokens", vendor: "openai", label: "Codex", fidelity: "exact", cachedKey: "codex_cached" },
  { key: "claude_code_tokens", vendor: "anthropic", label: "Claude Code", fidelity: "exact", cachedKey: "claude_code_cached" },
  { key: "console_tokens", vendor: "anthropic", label: "Console API", fidelity: "billed", cachedKey: "console_cached" },
  { key: "openai_api_tokens", vendor: "openai", label: "OpenAI API", fidelity: "billed", cachedKey: "openai_api_cached" },
  { key: "local_model_tokens", vendor: "ollama", label: "Local models", fidelity: "exact", cachedKey: null },
  { key: "claude_chat_est", vendor: "anthropic", label: "Claude chat", fidelity: "estimated", cachedKey: null },
  { key: "chatgpt_est", vendor: "openai", label: "ChatGPT", fidelity: "estimated", cachedKey: null },
] as const;

export type SourceKey = (typeof sourceColumns)[number]["key"];

/** Trust tiers, best first. "none" means the lane had no tokens that day. */
export type Fidelity = "billed" | "exact" | "derived" | "estimated" | "none";

/**
 * One line per trust tier. Shown on hover wherever a figure carries a tier, and
 * in the "i" panel, so the labels never have to sit on screen.
 */
export const FIDELITY_TEXT: Record<Exclude<Fidelity, "none">, string> = {
  billed: "billed: the provider's own meter, the number on the invoice",
  exact: "exact: measured from local logs on this machine",
  derived: "derived: rebuilt from a local aggregate after the session logs were pruned",
  estimated: "estimated: from an interview, not measured",
};

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
  anthropic_billed_tokens?: number;
  console_models?: Record<string, number>;
  driver_split?: Record<string, number>;
  // Optional extras produced by scripts/import-openai.mjs, merged by build-rows.mjs
  openai_api_tokens?: number;
  openai_api_cached?: number;
  openai_api_requests?: number;
  openai_api_usd?: number;
  openai_api_fidelity?: string;
  openai_api_models?: Record<string, number>;
  // Per-model split of the local lanes, produced by extract-exact.mjs
  codex_models?: Record<string, number>;
  claude_code_models?: Record<string, number>;
  // Claude subscription rate-limit meters, peak percent for the day (extract-plan-usage.mjs)
  claude_plan_5h_pct?: number;
  claude_plan_7d_pct?: number;
  // Models run on this machine (extract-ollama.mjs); model keys are "<runner>:<model>"
  local_model_tokens?: number;
  local_model_requests?: number;
  local_model_models?: Record<string, number>;
  local_model_fidelity?: string;
};

export type BurnRow = {
  date: string;
  codex_tokens: number;
  claude_code_tokens: number;
  claude_code_calls: number;
  claude_chat_est: number;
  chatgpt_est: number;
  console_tokens: number;
  /** OpenAI platform export: API-key traffic metered by OpenAI. UTC-day buckets. */
  openai_api_tokens: number;
  openai_api_requests: number;
  /** real money from the OpenAI cost export. Kept apart from cost_usd (Anthropic). */
  openai_api_usd: number;
  openai_api_models: Record<string, number>;
  /** Per-model split of the local exact lanes: Codex session logs and Claude Code logs. */
  codex_models: Record<string, number>;
  claude_code_models: Record<string, number>;
  /** Models run on this machine, as the runner logged them (Ollama today). Free, so no money. */
  local_model_tokens: number;
  local_model_requests: number;
  /** "<runner>:<model>" -> tokens, e.g. "ollama:llama3.2:3b". */
  local_model_models: Record<string, number>;
  /** Peak utilization of the Claude plan's 5-hour and 7-day limits that day, percent. -1 = not sampled. */
  claude_plan_5h_pct: number;
  claude_plan_7d_pct: number;
  total: number;
  driver: string;
  /** Fractional attribution across drivers, summing to 1. Empty when a day has one driver. */
  driver_split: Record<string, number>;
  evidence: string;
  codex_cached: number;
  claude_code_cached: number;
  console_cached: number;
  openai_api_cached: number;
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
  /**
   * Everything Anthropic's meter billed that day, Claude Code overlap included.
   * The tokens cost_usd paid for, so the only honest denominator for a rate.
   * Never added to `total`.
   */
  anthropic_billed_tokens: number;
  /** Per-model token split of the console lane. Empty when the meter reported none. */
  console_models: Record<string, number>;
  codex_fidelity: Fidelity;
  claude_code_fidelity: Fidelity;
  chat_fidelity: Fidelity;
  console_fidelity: Fidelity;
  openai_api_fidelity: Fidelity;
  local_model_fidelity: Fidelity;
  cost_fidelity: Fidelity;
};

export function normalizeRows(rows: RawBurnRow[]): BurnRow[] {
  return rows
    .map((row) => {
      const codex = asNumber(row.codex_tokens);
      const claudeCode = asNumber(row.claude_code_tokens);
      const consoleTokens = asNumber(row.console_tokens);
      const openaiTokens = asNumber(row.openai_api_tokens);
      const localTokens = asNumber(row.local_model_tokens);
      const claudeChat = asNumber(row.claude_chat_est);
      const chatgpt = asNumber(row.chatgpt_est);
      const computedTotal = codex + claudeCode + consoleTokens + openaiTokens + localTokens + claudeChat + chatgpt;
      const total = asNumber(row.total) || computedTotal;
      const codexCached = Math.min(codex, asNumber(row.codex_cached));
      const claudeCodeCached = Math.min(claudeCode, asNumber(row.claude_code_cached));
      const consoleCached = Math.min(consoleTokens, asNumber(row.console_cached));
      const openaiCached = Math.min(openaiTokens, asNumber(row.openai_api_cached));
      const cached = codexCached + claudeCodeCached + consoleCached + openaiCached;

      return {
        date: row.date,
        codex_tokens: codex,
        claude_code_tokens: claudeCode,
        claude_code_calls: asNumber(row.claude_code_calls),
        claude_chat_est: claudeChat,
        chatgpt_est: chatgpt,
        console_tokens: consoleTokens,
        openai_api_tokens: openaiTokens,
        openai_api_requests: asNumber(row.openai_api_requests),
        openai_api_usd: asNumber(row.openai_api_usd),
        openai_api_models: row.openai_api_models || {},
        codex_models: row.codex_models || {},
        claude_code_models: row.claude_code_models || {},
        local_model_tokens: localTokens,
        local_model_requests: asNumber(row.local_model_requests),
        local_model_models: row.local_model_models || {},
        claude_plan_5h_pct: Number.isFinite(row.claude_plan_5h_pct) ? Number(row.claude_plan_5h_pct) : -1,
        claude_plan_7d_pct: Number.isFinite(row.claude_plan_7d_pct) ? Number(row.claude_plan_7d_pct) : -1,
        total,
        driver: row.driver || "unlabeled",
        driver_split: row.driver_split || {},
        evidence: row.evidence || "",
        codex_cached: codexCached,
        claude_code_cached: claudeCodeCached,
        console_cached: consoleCached,
        openai_api_cached: openaiCached,
        cached,
        fresh: total - cached,
        exact_tokens: codex + claudeCode + localTokens,
        billed_tokens: consoleTokens + openaiTokens,
        estimated_tokens: claudeChat + chatgpt,
        cost_usd: asNumber(row.cost_usd),
        cost_cached_usd: asNumber(row.cost_cached_usd),
        billed_claude_code_tokens: asNumber(row.billed_claude_code_tokens),
        // Older files lack the field; console + overlap is the closest reconstruction.
        anthropic_billed_tokens:
          asNumber(row.anthropic_billed_tokens) || consoleTokens + asNumber(row.billed_claude_code_tokens),
        console_models: row.console_models || {},
        codex_fidelity: asFidelity(row.codex_fidelity, codex ? "exact" : "none"),
        claude_code_fidelity: asFidelity(row.claude_code_fidelity, claudeCode ? "exact" : "none"),
        chat_fidelity: asFidelity(row.chat_fidelity, claudeChat + chatgpt ? "estimated" : "none"),
        console_fidelity: asFidelity(row.console_fidelity, consoleTokens ? "billed" : "none"),
        openai_api_fidelity: asFidelity(row.openai_api_fidelity, openaiTokens ? "billed" : "none"),
        local_model_fidelity: asFidelity(row.local_model_fidelity, localTokens ? "exact" : "none"),
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
  | "openai_api_cached"
  | "openai_api_usd"
  | "cost_usd"
  | "cost_cached_usd"
  | "billed_claude_code_tokens"
  | "anthropic_billed_tokens";

export function sumField(rows: BurnRow[], key: SumField) {
  return rows.reduce((sum, row) => sum + row[key], 0);
}

export type PlanPeaks = {
  sampledDays: number;
  fiveHour: { pct: number; date: string };
  sevenDay: { pct: number; date: string };
  latest: { pct7d: number; pct5h: number; date: string };
};

/** Peak Claude plan utilization in the window, from the desktop app's sampled meters. */
export function planPeaks(rows: BurnRow[]): PlanPeaks | null {
  const sampled = rows.filter((r) => r.claude_plan_7d_pct >= 0);
  if (sampled.length === 0) return null;
  const top = (key: "claude_plan_5h_pct" | "claude_plan_7d_pct") =>
    sampled.reduce((a, b) => (b[key] > a[key] ? b : a), sampled[0]);
  const five = top("claude_plan_5h_pct");
  const seven = top("claude_plan_7d_pct");
  const last = sampled[sampled.length - 1];
  return {
    sampledDays: sampled.length,
    fiveHour: { pct: five.claude_plan_5h_pct, date: five.date },
    sevenDay: { pct: seven.claude_plan_7d_pct, date: seven.date },
    latest: { pct7d: last.claude_plan_7d_pct, pct5h: last.claude_plan_5h_pct, date: last.date },
  };
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

export type ModelVendor = "anthropic" | "openai" | "ollama";

/** The left-column label in the models list: the company, or the local runner. */
export const VENDOR_LABEL: Record<ModelVendor, string> = { anthropic: "Anthropic", openai: "OpenAI", ollama: "Ollama" };
export type ModelLane = "billed" | "local";
export type ModelTotal = { model: string; label: string; vendor: ModelVendor; lane: ModelLane; tokens: number; share: number };

/**
 * Per-model token totals across the window, largest first, from every lane that
 * attributes tokens to a model: the two billed meters, the two local session
 * logs, and local runners (Ollama), whose runner name is the label. The same model id is kept separate per lane, so a Claude model billed via
 * the Console and the same model seen in local Claude Code logs are two rows.
 * Lanes never overlap (the console lane already subtracts Claude Code traffic it
 * metered), so the rows sum to the window's attributable burn.
 */
export function modelTotals(rows: BurnRow[]): ModelTotal[] {
  const totals = new Map<string, { model: string; tokens: number; vendor: ModelVendor; lane: ModelLane }>();
  const add = (model: string, tokens: number, vendor: ModelVendor, lane: ModelLane) => {
    const key = `${lane}:${vendor}:${model}`;
    const entry = totals.get(key) || { model, tokens: 0, vendor, lane };
    entry.tokens += tokens;
    totals.set(key, entry);
  };
  for (const row of rows) {
    for (const [model, tokens] of Object.entries(row.console_models)) add(model, tokens, "anthropic", "billed");
    for (const [model, tokens] of Object.entries(row.openai_api_models)) add(model, tokens, "openai", "billed");
    for (const [model, tokens] of Object.entries(row.codex_models)) add(model, tokens, "openai", "local");
    for (const [model, tokens] of Object.entries(row.claude_code_models)) add(model, tokens, "anthropic", "local");
    for (const [key, tokens] of Object.entries(row.local_model_models)) {
      // "<runner>:<model>"; the model tag has colons of its own ("llama3.2:3b").
      const split = key.indexOf(":");
      const runner = key.slice(0, split);
      if (runner === "ollama") add(key.slice(split + 1), tokens, "ollama", "local");
    }
  }
  const sum = [...totals.values()].reduce((s, v) => s + v.tokens, 0);
  return [...totals.values()]
    .map(({ model, tokens, vendor, lane }) => ({
      // Local runner tags read best as the user typed them ("llama3.2:3b").
      model, label: vendor === "ollama" ? model : prettyModel(model), vendor, lane, tokens, share: sum ? tokens / sum : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * "claude-opus-4-5-20251101" -> "Claude Opus 4.5"; "gpt-5.4-mini-2026-03-17" -> "GPT-5.4 mini".
 * Falls back to the raw id.
 */
export function prettyModel(id: string) {
  const cleaned = id
    .replace(/^(anthropic|us|eu|apac)\./, "")
    .replace(/[@-]?\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-v\d+:\d+$/, "");
  const gpt = cleaned.match(/^(gpt|o\d|chatgpt)-?([\d.]+)?(?:-(.+))?$/i);
  if (gpt) {
    const [, family, version, variant] = gpt;
    const name = family.toLowerCase().startsWith("o") ? family : family.toUpperCase();
    const words = variant ? variant.split("-").map(capitalize).join(" ") : "";
    return `${name}${version ? `-${version}` : ""}${words ? ` ${words}` : ""}`.trim();
  }
  const match = cleaned.match(/^claude-([a-z]+)(?:-(\d+))?(?:-(\d+))?/);
  if (!match) return capitalize(cleaned || id);
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

/**
 * One short trust label per row for tables and tooltips. The label follows the
 * measured lane that carried most of the day's tokens, so a day of 500M exact
 * Claude Code tokens is not called "billed" because a background API job spent
 * two cents. Chat estimates never set the tone while anything was measured;
 * they only add the suffix.
 */
export function rowFidelityLabel(row: BurnRow): { text: string; tone: "billed" | "exact" | "derived" | "estimated" } {
  const suffix = row.estimated_tokens > 0 ? " + est. chat" : "";
  const lanes: { tokens: number; fidelity: Fidelity }[] = [
    { tokens: row.claude_code_tokens, fidelity: row.claude_code_fidelity },
    { tokens: row.codex_tokens, fidelity: row.codex_fidelity },
    { tokens: row.console_tokens, fidelity: row.console_fidelity },
    { tokens: row.openai_api_tokens, fidelity: row.openai_api_fidelity },
    { tokens: row.local_model_tokens, fidelity: row.local_model_fidelity },
  ].filter((lane) => lane.tokens > 0 && lane.fidelity !== "none");
  if (lanes.length === 0) return { text: "estimated", tone: "estimated" };
  const top = lanes.reduce((a, b) => (b.tokens > a.tokens ? b : a));
  const tone = top.fidelity === "none" ? "estimated" : top.fidelity;
  return { text: `${tone}${suffix}`, tone };
}

function capitalize(word: string) {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

function asNumber(value: number | undefined) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function asFidelity(value: string | undefined, fallback: Fidelity): Fidelity {
  return value === "billed" || value === "exact" || value === "derived" || value === "estimated" || value === "none"
    ? value
    : fallback;
}

export type SourceVisibility = Record<SourceKey, boolean>;

export const allSourcesVisible = Object.fromEntries(
  sourceColumns.map((source) => [source.key, true]),
) as SourceVisibility;

/**
 * Rows as they look with some sources hidden: every total, cache split, model
 * split, and fidelity is recomputed from the visible lanes only, and days left
 * with nothing are dropped. Money is billed against the Console lane, so it
 * hides with that lane.
 */
export function applySourceVisibility(rows: BurnRow[], visible: SourceVisibility): BurnRow[] {
  if (sourceColumns.every((source) => visible[source.key])) return rows;
  const show = {
    codex: visible.codex_tokens,
    claudeCode: visible.claude_code_tokens,
    console: visible.console_tokens,
    openai: visible.openai_api_tokens,
    local: visible.local_model_tokens,
  };
  return rows
    .map((row) => {
      const codex = show.codex ? row.codex_tokens : 0;
      const claudeCode = show.claudeCode ? row.claude_code_tokens : 0;
      const consoleTokens = show.console ? row.console_tokens : 0;
      const openaiTokens = show.openai ? row.openai_api_tokens : 0;
      const localTokens = show.local ? row.local_model_tokens : 0;
      const claudeChat = visible.claude_chat_est ? row.claude_chat_est : 0;
      const chatgpt = visible.chatgpt_est ? row.chatgpt_est : 0;
      const codexCached = show.codex ? row.codex_cached : 0;
      const claudeCodeCached = show.claudeCode ? row.claude_code_cached : 0;
      const consoleCached = show.console ? row.console_cached : 0;
      const openaiCached = show.openai ? row.openai_api_cached : 0;
      const cached = codexCached + claudeCodeCached + consoleCached + openaiCached;
      const total = codex + claudeCode + consoleTokens + openaiTokens + localTokens + claudeChat + chatgpt;
      const costUsd = show.console ? row.cost_usd : 0;
      return {
        ...row,
        codex_tokens: codex,
        claude_code_tokens: claudeCode,
        claude_code_calls: show.claudeCode ? row.claude_code_calls : 0,
        console_tokens: consoleTokens,
        openai_api_tokens: openaiTokens,
        openai_api_requests: show.openai ? row.openai_api_requests : 0,
        openai_api_usd: show.openai ? row.openai_api_usd : 0,
        openai_api_models: show.openai ? row.openai_api_models : {},
        local_model_tokens: localTokens,
        local_model_requests: show.local ? row.local_model_requests : 0,
        local_model_models: show.local ? row.local_model_models : {},
        claude_chat_est: claudeChat,
        chatgpt_est: chatgpt,
        total,
        codex_cached: codexCached,
        claude_code_cached: claudeCodeCached,
        console_cached: consoleCached,
        openai_api_cached: openaiCached,
        cached,
        fresh: total - cached,
        exact_tokens: codex + claudeCode + localTokens,
        billed_tokens: consoleTokens + openaiTokens,
        estimated_tokens: claudeChat + chatgpt,
        cost_usd: costUsd,
        cost_cached_usd: show.console ? row.cost_cached_usd : 0,
        anthropic_billed_tokens: show.console ? row.anthropic_billed_tokens : 0,
        console_models: show.console ? row.console_models : {},
        codex_models: show.codex ? row.codex_models : {},
        claude_code_models: show.claudeCode ? row.claude_code_models : {},
        billed_claude_code_tokens: show.claudeCode ? row.billed_claude_code_tokens : 0,
        codex_fidelity: codex ? row.codex_fidelity : "none",
        claude_code_fidelity: claudeCode ? row.claude_code_fidelity : "none",
        chat_fidelity: claudeChat + chatgpt ? row.chat_fidelity : "none",
        console_fidelity: consoleTokens ? row.console_fidelity : "none",
        openai_api_fidelity: openaiTokens ? row.openai_api_fidelity : "none",
        local_model_fidelity: localTokens ? row.local_model_fidelity : "none",
        cost_fidelity: costUsd ? row.cost_fidelity : "none",
      } satisfies BurnRow;
    })
    .filter((row) => row.total > 0 || row.cost_usd > 0);
}

/** Days where a local lane had to be rebuilt because its logs were pruned. */
export function derivedDayCount(rows: BurnRow[]) {
  const notExact = (f: Fidelity) => f !== "exact" && f !== "none";
  return rows.filter((row) => notExact(row.claude_code_fidelity) || notExact(row.codex_fidelity)).length;
}
