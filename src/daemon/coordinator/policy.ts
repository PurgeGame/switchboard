// Enforcement primitives for the coordinator. Pure and clock-injected so every rule is unit tested.
// These run in daemon code: the coordinator's prompt cannot talk its way past them.

export const PREFIX = "[coordinator]";

export const SCREEN_LABEL = "Best-effort destructive-intent screen (keyword heuristic, not a guarantee)";

const DESTRUCTIVE: [RegExp, string][] = [
  [/\bgit\s+reset\b|\breset\s+--hard\b|\bhard[- ]reset\b/i, "git reset"],
  [/\bforce[- ]?push|\bpush\s+(-f\b|--force)/i, "force-push"],
  [/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\brm\s+-rf?\b/i, "rm -rf"],
  [/\bdrop\s+(table|database|schema)\b|\btruncate\s+table\b/i, "drop table"],
  [/\bgit\s+clean\s+-[a-z]*f|\bgit\s+checkout\s+(--\s+)?\.(\s|$)|\bgit\s+restore\s+\.|\bgit\s+stash\s+(drop|clear)\b|\bbranch\s+-D\b/i, "discard git changes"],
  [/\b(delete|remove|wipe|erase|purge|nuke)\b[^.\n]{0,40}\b(files?|director(y|ies)|folders?|branch(es)?|repo(sitory)?|database|tables?|worktree|work|changes|commits?|data)\b/i, "delete"],
  [/\b(discard|throw away|revert|undo|roll ?back)\b[^.\n]{0,30}\b(changes|work|commits?|edits)\b/i, "discard/revert work"],
];

/** Best-effort: returns the matched label or null. */
export function screenDestructive(text: string): string | null {
  for (const [re, label] of DESTRUCTIVE) if (re.test(text)) return label;
  return null;
}

export function withPrefix(text: string): string {
  const t = text.trim();
  return t.startsWith(PREFIX) ? t : `${PREFIX} ${t}`;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/^\[coordinator\]\s*/, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function trigrams(s: string): Set<string> {
  const t = ` ${norm(s)} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Jaccard similarity over character trigrams, 0..1. */
export function similarity(a: string, b: string): number {
  const x = trigrams(a), y = trigrams(b);
  if (!x.size && !y.size) return 1;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}

export const NEAR_IDENTICAL = 0.85;

export interface SentRecord {
  sessionId: string;
  at: number;
  text: string;
}

export interface RateLimits {
  perSessionCooldownMs: number;
  perSessionPerHour: number;
  dedupeWindowMs: number;
}

/** Outgoing-message gate: cooldown, hourly cap, near-duplicate drop. */
export function checkSend(history: SentRecord[], sessionId: string, text: string, lim: RateLimits, now: number): { ok: true } | { ok: false; outcome: "refused" | "dropped"; reason: string } {
  const mine = history.filter((h) => h.sessionId === sessionId);
  const dup = mine.find((h) => now - h.at < lim.dedupeWindowMs && similarity(h.text, text) >= NEAR_IDENTICAL);
  if (dup) return { ok: false, outcome: "dropped", reason: `near-identical to a message sent ${Math.round((now - dup.at) / 60_000)} min ago` };
  const last = mine.reduce((m, h) => Math.max(m, h.at), 0);
  if (last && now - last < lim.perSessionCooldownMs)
    return { ok: false, outcome: "refused", reason: `cooldown: 1 message per ${Math.round(lim.perSessionCooldownMs / 60_000)} min per session (next allowed in ${Math.ceil((lim.perSessionCooldownMs - (now - last)) / 60_000)} min)` };
  const hour = mine.filter((h) => now - h.at < 3600_000).length;
  if (hour >= lim.perSessionPerHour) return { ok: false, outcome: "refused", reason: `rate limit: ${lim.perSessionPerHour} messages per session per hour` };
  return { ok: true };
}

/** Daily budget bookkeeping. stream-json `result.total_cost_usd` is cumulative per process. */
export class Budget {
  day: string;
  spentUsd = 0;
  inputTokens = 0;
  outputTokens = 0;
  private lastProcessCost = 0;

  constructor(
    public limitUsd: number,
    private today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {
    this.day = today();
  }

  private roll() {
    const d = this.today();
    if (d !== this.day) {
      this.day = d;
      this.spentUsd = this.inputTokens = this.outputTokens = 0;
    }
  }

  /** New coordinator process: its cumulative counter restarts at zero. */
  newProcess() {
    this.lastProcessCost = 0;
  }

  /** Record a `result` message. */
  record(totalCostUsd: number | undefined, usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }) {
    this.roll();
    if (typeof totalCostUsd === "number" && totalCostUsd >= 0) {
      const delta = totalCostUsd >= this.lastProcessCost ? totalCostUsd - this.lastProcessCost : totalCostUsd;
      this.lastProcessCost = totalCostUsd;
      this.spentUsd += delta;
    }
    if (usage) {
      this.inputTokens += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      this.outputTokens += usage.output_tokens ?? 0;
    }
  }

  get exhausted(): boolean {
    this.roll();
    return this.spentUsd >= this.limitUsd;
  }

  toJSON() {
    return { day: this.day, spentUsd: Math.round(this.spentUsd * 10000) / 10000, limitUsd: this.limitUsd, inputTokens: this.inputTokens, outputTokens: this.outputTokens, exhausted: this.exhausted };
  }

  restore(o: Partial<ReturnType<Budget["toJSON"]>>) {
    if (o.day === this.today()) {
      this.spentUsd = o.spentUsd ?? 0;
      this.inputTokens = o.inputTokens ?? 0;
      this.outputTokens = o.outputTokens ?? 0;
    }
  }
}

/** Failure counter per key within a window (retry limits). */
export class RetryLimiter {
  private fails = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs = 3600_000,
  ) {}
  private live(key: string, now: number) {
    const a = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.fails.set(key, a);
    return a;
  }
  allowed(key: string, now = Date.now()) {
    return this.live(key, now).length < this.max;
  }
  fail(key: string, now = Date.now()) {
    this.live(key, now).push(now);
  }
  clear(key: string) {
    this.fails.delete(key);
  }
}

/** Repeated-work detector: the same normalized action signature again and again within an hour. */
export class RepeatDetector {
  private seen: { sig: string; at: number; done: boolean }[] = [];
  /** threshold: successful repeats before the next one is refused; runaway: attempts of any outcome before a halt. */
  constructor(
    private threshold: number,
    private runaway: number,
  ) {}
  /**
   * Record an attempt. "repeat": it already worked `threshold - 1` times this hour, refuse this one.
   * "runaway": the same call keeps coming whatever happens to it, halt.
   */
  attempt(sig: string, now = Date.now()): "ok" | "repeat" | "runaway" {
    this.seen = this.seen.filter((s) => now - s.at < 3600_000);
    const n = norm(sig);
    // Exact (normalized) repeats only: similar-but-distinct work (n3.txt vs n4.txt) is legitimate.
    const same = this.seen.filter((s) => s.sig === n);
    this.seen.push({ sig: n, at: now, done: false });
    if (same.length + 1 >= this.runaway) return "runaway";
    // Refused or failed attempts don't count here: a gate saying no isn't the work being redone.
    if (same.filter((s) => s.done).length + 1 >= this.threshold) return "repeat";
    return "ok";
  }
  /** The attempt just recorded for this signature succeeded. */
  succeeded(sig: string) {
    const n = norm(sig);
    for (let i = this.seen.length - 1; i >= 0; i--)
      if (this.seen[i].sig === n) {
        this.seen[i].done = true;
        return;
      }
  }
  reset() {
    this.seen = [];
  }
}

/** Tools that change anything. Read-only tools stay usable while paused. */
export const READ_ONLY_TOOLS = new Set(["list_sessions", "get_session", "get_state", "get_resources", "get_group", "note", "get_updates", "get_instructions"]);
