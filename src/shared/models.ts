// Model display names and context windows. Codex reports its window; Claude's transcripts
// don't, so Claude windows come from this table (override per model in config: contextWindows).

const CLAUDE_WINDOWS: [RegExp, number][] = [
  [/\[1m\]/i, 1_000_000],
  [/claude-(opus|sonnet|fable)-5/i, 1_000_000],
  [/claude-(opus|sonnet)-4/i, 200_000],
  [/haiku/i, 200_000],
];

/** Context window for a model id, or null when unknown. */
export function contextWindowFor(model: string, overrides: Record<string, number> = {}): number | null {
  if (overrides[model]) return overrides[model];
  for (const [re, n] of CLAUDE_WINDOWS) if (re.test(model)) return n;
  return null;
}

/** "claude-opus-5-5" -> "Opus 5.5"; "gpt-6-astra" stays as is. */
export function modelLabel(model: string | null): string | null {
  if (!model) return null;
  const m = model.replace(/\[.*?\]/g, "").match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ""}`;
  return model;
}

/** Percent of the context window in use, or null. */
export function contextPct(tokens: number | null, window: number | null): number | null {
  return tokens && window ? Math.min(100, Math.round((tokens / window) * 100)) : null;
}
