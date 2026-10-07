// Claude and Codex rate-limit usage: how much of each window is used and when it resets.
//
// Codex: every `token_count` event in a rollout log (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
//   carries `rate_limits {primary, secondary: {used_percent, window_minutes, resets_at (epoch s)}}`,
//   the account's windows as the server last reported them. We read the newest such event. It is as
//   fresh as the last Codex turn anywhere on this machine. Past reset times remain unconfirmed.
// Claude: the CLI's own usage call, GET https://api.anthropic.com/api/oauth/usage with the login's
//   OAuth access token (five_hour / seven_day / seven_day_opus / seven_day_sonnet: utilization %,
//   resets_at ISO). It's undocumented and could change, and it needs the login token, so it is off by default;
//   config `usage.claudeOAuth: true` turns it on. We never refresh the token (the CLI does that when it runs);
//   failed reads retain the last observation. Polled at most every 2 minutes, backed off on errors.
// Nothing else is estimated: no source, no number.
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderUsage, UsageSnapshot, UsageWindow } from "../shared/types.ts";
import { usageStatus } from "../shared/usage.ts";
import type { UsageCache } from "./usage-cache.ts";

const TAIL_BYTES = 512 * 1024;
export const CLAUDE_MIN_INTERVAL_MS = 120_000;
export const CLAUDE_ERROR_BACKOFF_MS = 600_000;
export const CLAUDE_MAX_BACKOFF_MS = 3_600_000;

const validPct = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
const validTime = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 8.64e15;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function windowLabel(minutes: number | null | undefined): string {
  if (!minutes) return "limit";
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "7d";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function makeWindow(label: string, usedPct: number, resetsAt: number | null): UsageWindow {
  const used = round1(usedPct);
  return { label, usedPct: used, remainingPct: round1(100 - used), resetsAt };
}

// ---- Codex ----

export interface CodexReading {
  at: number;
  plan: string | null;
  windows: { minutes: number | null; usedPct: number; resetsAt: number | null }[];
}

/** The last `rate_limits` in a chunk of rollout JSONL (newest wins). */
export function parseCodexRateLimits(text: string): CodexReading | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"rate_limits"')) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a line cut by the tail window
    }
    const rl = o?.payload?.rate_limits;
    if (!rl || typeof rl !== "object") continue;
    const windows: CodexReading["windows"] = [];
    let invalid = false;
    for (const k of ["primary", "secondary"]) {
      const w = rl[k];
      if (w == null) continue;
      if (!validPct(w.used_percent) || (w.resets_at != null && !validTime(w.resets_at * 1000)) ||
          (w.resets_at != null && typeof w.resets_at !== "number") ||
          (w.window_minutes != null && (typeof w.window_minutes !== "number" || !Number.isFinite(w.window_minutes) || w.window_minutes <= 0))) {
        invalid = true;
        break;
      }
      windows.push({ minutes: w.window_minutes ?? null, usedPct: w.used_percent, resetsAt: w.resets_at == null ? null : w.resets_at * 1000 });
    }
    const at = Date.parse(o.timestamp);
    if (invalid || !windows.length || !validTime(at)) continue;
    return { at, plan: typeof rl.plan_type === "string" ? rl.plan_type : null, windows };
  }
  return null;
}

function tailOf(file: string): string {
  const size = statSync(file).size;
  const len = Math.min(size, TAIL_BYTES);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Newest rollout files first (by date directory, then mtime), at most `max`. */
function newestRollouts(root: string, max: number): string[] {
  const out: { f: string; m: number }[] = [];
  const sub = (d: string) => (existsSync(d) ? readdirSync(d).sort().reverse() : []);
  outer: for (const y of sub(root))
    for (const mo of sub(join(root, y)))
      for (const d of sub(join(root, y, mo))) {
        const dir = join(root, y, mo, d);
        for (const f of readdirSync(dir))
          if (f.startsWith("rollout-") && f.endsWith(".jsonl")) out.push({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs });
        if (out.length >= max) break outer;
      }
  return out.sort((a, b) => b.m - a.m).slice(0, max).map((x) => x.f);
}

export function readCodexUsage(now = Date.now(), sessionsDir = join(homedir(), ".codex", "sessions")): ProviderUsage {
  const source = CODEX_SOURCE;
  let best: CodexReading | null = null;
  try {
    for (const f of newestRollouts(sessionsDir, 8)) {
      const r = parseCodexRateLimits(tailOf(f));
      if (r && (!best || r.at > best.at)) best = r;
    }
  } catch (e) {
    return { available: false, source, asOf: null, windows: [], note: `could not read Codex logs: ${(e as Error).message}` };
  }
  if (!best) return { available: false, source, asOf: null, windows: [], note: "no Codex rate-limit reading yet (it appears after a Codex turn)" };
  const windows = best.windows.map((w) => makeWindow(windowLabel(w.minutes), w.usedPct, w.resetsAt));
  const reading = { available: true, source, asOf: best.at, plan: best.plan, windows };
  return { ...reading, ...usageStatus(reading, now) };
}

// ---- Claude ----

const CLAUDE_WINDOWS: [string, string][] = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
  ["seven_day_opus", "7d opus"],
  ["seven_day_sonnet", "7d sonnet"],
];

/** Claude's /api/oauth/usage body → windows. Null windows (no such limit on this plan) are skipped. */
export function parseClaudeUsage(body: any, _now?: number): UsageWindow[] {
  const out: UsageWindow[] = [];
  for (const [key, label] of CLAUDE_WINDOWS) {
    const w = body?.[key];
    if (w == null) continue;
    if (!validPct(w.utilization)) throw new Error(`invalid ${key} utilization`);
    const resetsAt = w.resets_at == null ? null : typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
    if (resetsAt !== null && !validTime(resetsAt)) throw new Error(`invalid ${key} reset time`);
    out.push(makeWindow(label, w.utilization, resetsAt));
  }
  return out;
}

export interface ClaudeSource {
  /** The OAuth access token, or null when there is none / it has expired. Never refreshes. */
  token(): { token: string; plan: string | null } | { error: string };
  fetch: typeof fetch;
}

/** Retry-After accepts nonnegative integer seconds or an HTTP date. Never retry before the poll floor. */
export function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  const delay = /^\d+$/.test(text) ? Number(text) * 1000
    : /^[A-Za-z]{3,9}[, ]/.test(text) ? Date.parse(text) - now : NaN;
  return Number.isFinite(delay) && validTime(now + Math.max(0, delay)) ? Math.max(CLAUDE_MIN_INTERVAL_MS, delay) : null;
}

/** Cache input is untrusted; reject partial/legacy fabricated readings and whitelist snapshot fields. */
function restoredUsage(value: any, source: string): ProviderUsage | null {
  if (!value || !validTime(value.asOf) || !Array.isArray(value.windows) || !value.windows.length) return null;
  const windows: UsageWindow[] = [];
  for (const w of value.windows) {
    if (!w || typeof w.label !== "string" || !w.label || w.reset || !validPct(w.usedPct) || !validPct(w.remainingPct) ||
        Math.abs(w.usedPct + w.remainingPct - 100) > 0.11 || (w.resetsAt !== null && !validTime(w.resetsAt)) ||
        windows.some((other) => other.label === w.label)) return null;
    windows.push({ label: w.label, usedPct: w.usedPct, remainingPct: w.remainingPct, resetsAt: w.resetsAt });
  }
  return { available: true, source, asOf: value.asOf, plan: typeof value.plan === "string" ? value.plan : null, windows,
    stale: true, staleReason: "restored last observation; awaiting refresh", error: null };
}

function failedUsage(previous: ProviderUsage, error: string, now: number, nextRetryAt: number | null = null): ProviderUsage {
  return { ...previous, stale: true, staleReason: "refresh failed", error, note: error, lastAttemptAt: now, nextRetryAt };
}

export class UsageMonitor {
  onChange: ((u: UsageSnapshot) => void) | null = null;
  private codex: ProviderUsage;
  private claude: ProviderUsage;
  private claudeNext = 0;
  private claudeFailures = 0;
  private cacheDirty = new Set<"claude" | "codex">();
  private busy = false;

  constructor(
    private opts: { claudeSource: ClaudeSource | null; sessionsDir?: string; now?: () => number; cache?: UsageCache },
  ) {
    this.codex = this.restore("codex", CODEX_SOURCE) ?? { available: false, source: CODEX_SOURCE, asOf: null, windows: [] };
    this.codex = this.accept("codex", this.codex, readCodexUsage(this.now(), opts.sessionsDir));
    this.claude = (opts.claudeSource && this.restore("claude", CLAUDE_SOURCE)) || {
      available: false, source: CLAUDE_SOURCE, asOf: null, windows: [],
      note: opts.claudeSource ? "not read yet" : "off: set usage.claudeOAuth to true in the daemon config to read Claude usage",
    };
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private restore(provider: "claude" | "codex", source: string): ProviderUsage | null {
    try {
      return restoredUsage(this.opts.cache?.load(provider), source);
    } catch {
      console.warn(`Could not restore ${provider} usage cache`);
      return null;
    }
  }

  /** Both providers share the same invariant: a failed read cannot erase an observation. */
  private accept(provider: "claude" | "codex", previous: ProviderUsage, incoming: ProviderUsage): ProviderUsage {
    if (!incoming.available) return failedUsage(previous, incoming.note ?? "usage reading unavailable", this.now());
    if (previous.asOf !== null && incoming.asOf !== null && incoming.asOf < previous.asOf) {
      return failedUsage(previous, "source returned an older usage reading; retaining last observation", this.now());
    }
    const next = { ...incoming, error: null, lastAttemptAt: this.now(), nextRetryAt: null };
    if (this.cacheDirty.has(provider) || previous.asOf !== next.asOf || JSON.stringify(previous.windows) !== JSON.stringify(next.windows) || previous.plan !== next.plan) {
      try {
        this.opts.cache?.save(provider, next);
        this.cacheDirty.delete(provider);
      } catch {
        // Disk trouble must not discard an otherwise successful reading in memory.
        this.cacheDirty.add(provider);
        console.warn(`Could not persist ${provider} usage cache`);
      }
    }
    return next;
  }

  snapshot(): UsageSnapshot {
    const now = this.now();
    const status = (p: ProviderUsage): ProviderUsage => ({
      ...p, ...usageStatus(p, now), error: p.error ?? null, lastAttemptAt: p.lastAttemptAt ?? null,
      nextRetryAt: p.nextRetryAt ?? null, windows: p.windows.map((w) => ({ ...w })),
    });
    return { ts: now, claude: status(this.claude), codex: status(this.codex) };
  }

  /** Re-reads Codex (cheap, local) always, and Claude when its interval has passed. */
  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const before = JSON.stringify([this.claude, this.codex]);
      this.codex = this.accept("codex", this.codex, readCodexUsage(this.now(), this.opts.sessionsDir));
      if (this.opts.claudeSource && this.now() >= this.claudeNext) await this.refreshClaude(this.opts.claudeSource);
      if (JSON.stringify([this.claude, this.codex]) !== before) this.onChange?.(this.snapshot());
    } finally {
      this.busy = false;
    }
  }

  private async refreshClaude(src: ClaudeSource) {
    let retryDelay: number | null = null;
    try {
      const t = src.token();
      if ("error" in t) throw new Error(t.error);
      const res = await src.fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: { Authorization: `Bearer ${t.token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "switchboard-usage" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 429) retryDelay = retryAfterMs(res.headers.get("Retry-After"), this.now());
        throw new Error(`HTTP ${res.status}`);
      }
      const windows = parseClaudeUsage(await res.json());
      if (!windows.length) throw new Error("the usage endpoint returned no limit windows");
      const now = this.now();
      this.claude = this.accept("claude", this.claude, { available: true, source: CLAUDE_SOURCE, asOf: now, plan: t.plan, windows, stale: false, staleReason: null });
      this.claudeFailures = 0;
      this.claudeNext = now + CLAUDE_MIN_INTERVAL_MS;
    } catch (e) {
      const now = this.now();
      this.claudeFailures = Math.min(this.claudeFailures + 1, 10);
      const backoff = Math.min(CLAUDE_MAX_BACKOFF_MS, CLAUDE_ERROR_BACKOFF_MS * 2 ** (this.claudeFailures - 1));
      this.claudeNext = now + (retryDelay ?? backoff);
      this.claude = failedUsage(this.claude, `Claude usage fetch failed: ${e instanceof Error ? e.message : String(e)}`, now, this.claudeNext);
    }
  }
}

export const CLAUDE_SOURCE = "Claude Code's usage endpoint (api.anthropic.com/api/oauth/usage, the same call the CLI makes)";
export const CODEX_SOURCE = "Codex rollout logs (~/.codex/sessions): rate_limits in the newest token_count event";

/** Compact coordinator contract: values are last-observed, and freshness is always explicit. */
export function compactUsage(u: UsageSnapshot): Record<string, unknown> {
  const iso = (t: number | null | undefined) => t == null ? null : new Date(t).toISOString();
  const one = (p: ProviderUsage) => ({
    available: p.available, plan: p.plan ?? undefined, asOf: iso(p.asOf), ...usageStatus(p, u.ts),
    error: p.error ?? null, lastAttemptAt: iso(p.lastAttemptAt), nextRetryAt: iso(p.nextRetryAt),
    windows: p.windows.map((w) => ({ w: w.label, used: w.usedPct, left: w.remainingPct, resets: iso(w.resetsAt),
      ...(w.resetsAt !== null && w.resetsAt <= u.ts ? { resetElapsed: true } : {}) })), note: p.note,
  });
  return { now: new Date(u.ts).toISOString(), claude: one(u.claude), codex: one(u.codex) };
}

/** Reads the access token from the Claude CLI's credentials file. Only when usage.claudeOAuth is on. */
export function claudeCredentialsSource(path = join(homedir(), ".claude", ".credentials.json"), f: typeof fetch = fetch): ClaudeSource {
  return {
    fetch: f,
    token() {
      try {
        const o = JSON.parse(readFileSync(path, "utf8"))?.claudeAiOauth;
        if (!o?.accessToken) return { error: "no Claude login found" };
        if (typeof o.expiresAt === "number" && o.expiresAt <= Date.now()) return { error: "Claude login token expired; it refreshes when a Claude session runs" };
        return { token: o.accessToken, plan: typeof o.subscriptionType === "string" ? o.subscriptionType : null };
      } catch {
        return { error: "could not read the Claude login" };
      }
    },
  };
}
