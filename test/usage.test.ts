import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageMonitor, compactUsage, parseClaudeUsage, parseCodexRateLimits, readCodexUsage, windowLabel, retryAfterMs, CLAUDE_MIN_INTERVAL_MS, CLAUDE_ERROR_BACKOFF_MS, CLAUDE_MAX_BACKOFF_MS, type ClaudeSource } from "../src/daemon/usage.ts";

import { Store } from "../src/daemon/db.ts";
import { usageCache, type UsageCache } from "../src/daemon/usage-cache.ts";

const sandbox = join(import.meta.dir, "../.sandbox");
mkdirSync(sandbox, { recursive: true });
const testRoot = mkdtempSync(join(sandbox, "usage-test-"));
const missing = join(testRoot, "missing");
afterAll(() => rmSync(testRoot, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-07T10:00:00Z");
const tc = (ts: string, primary: number, resetsS: number, extra: object = {}) =>
  JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", rate_limits: { plan_type: "pro", primary: { used_percent: primary, window_minutes: 10080, resets_at: resetsS }, secondary: null, ...extra } } });

function rollouts(files: Record<string, string>) {
  const root = mkdtempSync(join(testRoot, "rollouts-"));
  const dir = join(root, "2026", "10", "07");
  mkdirSync(dir, { recursive: true });
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, `rollout-${n}.jsonl`), c);
  return root;
}

describe("Codex reader", () => {
  test("takes the last rate_limits in a log, and labels windows", () => {
    const r = parseCodexRateLimits([tc("2026-10-07T08:00:00Z", 1, 1791964018), "not json", tc("2026-10-07T09:00:00Z", 7, 1791964018, { secondary: { used_percent: 40, window_minutes: 300, resets_at: 1791900000 } })].join("\n"));
    expect(r?.windows.map((w) => [w.minutes, w.usedPct])).toEqual([[10080, 7], [300, 40]]);
    expect(r?.plan).toBe("pro");
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(10080)).toBe("7d");
    expect(windowLabel(null)).toBe("limit");
  });
  test("a log cut mid-line and logs without rate limits are skipped", () => {
    expect(parseCodexRateLimits('{"type":"x"}\n{"payload":{"rate_limits":{"prim')).toBeNull();
  });
  test("newest reading across rollouts wins; used/remaining/reset are computed", () => {
    const resets = Math.floor(NOW / 1000) + 3600;
    const root = rollouts({ a: tc("2026-10-07T09:00:00Z", 20, resets), b: tc("2026-10-07T09:30:00Z", 25.5, resets) });
    const u = readCodexUsage(NOW, root);
    expect(u.available).toBe(true);
    expect(u.windows).toEqual([{ label: "7d", usedPct: 25.5, remainingPct: 74.5, resetsAt: resets * 1000 }]);
    expect(u.asOf).toBe(Date.parse("2026-10-07T09:30:00Z"));
  });
  test("a window past its recorded reset keeps observed values", () => {
    const root = rollouts({ a: tc("2026-10-07T09:00:00Z", 90, Math.floor(NOW / 1000) - 60) });
    const w = readCodexUsage(NOW, root).windows[0]!;
    expect(w).toEqual({ label: "7d", usedPct: 90, remainingPct: 10, resetsAt: NOW - 60_000 });
  });
  test("no logs: unavailable with a reason, never a made-up number", () => {
    const u = readCodexUsage(NOW, missing);
    expect(u).toMatchObject({ available: false, windows: [] });
    expect(u.note).toBeTruthy();
  });
});

describe("Claude reader", () => {
  const body = {
    five_hour: { utilization: 45, resets_at: "2026-10-07T12:49:59.840919+00:00" },
    seven_day: { utilization: 83, resets_at: "2026-10-09T17:59:59+00:00" },
    seven_day_opus: null,
    iguana_necktie: { utilization: 0 },
  };
  test("maps known windows, skips null ones and unknown fields", () => {
    const w = parseClaudeUsage(body, NOW);
    expect(w.map((x) => [x.label, x.usedPct, x.remainingPct])).toEqual([["5h", 45, 55], ["7d", 83, 17]]);
    expect(w[0]!.resetsAt).toBe(Date.parse("2026-10-07T12:49:59.840919Z"));
  });
  const src = (f: typeof fetch, token: ReturnType<ClaudeSource["token"]> = { token: "t", plan: "max" }): ClaudeSource => ({ token: () => token, fetch: f });
  const ok = (calls: { n: number }) => (async () => (calls.n++, new Response(JSON.stringify(body)))) as unknown as typeof fetch;

  test("Claude usage polling is opt-in: off unless usage.claudeOAuth is true, and main.ts reads nothing without it", async () => {
    const { mergeConfig } = await import("../src/daemon/config.ts");
    expect(mergeConfig({}).usage).toEqual({ claudeOAuth: false });
    expect(mergeConfig({ usage: {} }).usage?.claudeOAuth).toBe(false);
    expect(mergeConfig({ usage: { claudeOAuth: true } }).usage?.claudeOAuth).toBe(true);
    const main = await Bun.file(new URL("../src/daemon/main.ts", import.meta.url)).text();
    expect(main).toContain("claudeSource: cfg.usage?.claudeOAuth === true ? claudeCredentialsSource() : null");
  });
  test("explicitly disabled: says why, and makes no call", async () => {
    const m = new UsageMonitor({ claudeSource: null, sessionsDir: missing });
    await m.refresh();
    expect(m.snapshot().claude).toMatchObject({ available: false });
    expect(m.snapshot().claude.note).toContain("usage.claudeOAuth to true");
  });
  test("polls at most every 2 minutes and pushes only on change", async () => {
    let t = NOW;
    const calls = { n: 0 };
    const m = new UsageMonitor({ claudeSource: src(ok(calls)), sessionsDir: missing, now: () => t });
    const pushes: unknown[] = [];
    m.onChange = (u) => pushes.push(u);
    await m.refresh();
    await m.refresh();
    expect(calls.n).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(m.snapshot().claude).toMatchObject({ available: true, plan: "max" });
    t += 121_000;
    await m.refresh();
    expect(calls.n).toBe(2);
  });
  test("a failed fetch keeps the last good reading, notes it, and backs off", async () => {
    let t = NOW;
    let fail = false;
    const calls = { n: 0 };
    const f = (async () => (calls.n++, fail ? new Response("no", { status: 429 }) : new Response(JSON.stringify(body)))) as unknown as typeof fetch;
    const m = new UsageMonitor({ claudeSource: src(f), sessionsDir: missing, now: () => t });
    await m.refresh();
    fail = true;
    t += 121_000;
    await m.refresh();
    const c = m.snapshot().claude;
    expect(c.windows).toHaveLength(2);
    expect(c.note).toContain("HTTP 429");
    t += 121_000;
    await m.refresh();
    expect(calls.n).toBe(2); // backed off for 10 minutes
  });
  test("an expired or missing token makes Claude unavailable without a call", async () => {
    const calls = { n: 0 };
    const m = new UsageMonitor({ claudeSource: src(ok(calls), { error: "Claude login token expired" }), sessionsDir: missing, now: () => NOW });
    await m.refresh();
    expect(calls.n).toBe(0);
    expect(m.snapshot().claude).toMatchObject({ available: false, error: "Claude usage fetch failed: Claude login token expired" });
  });
});

test("compactUsage is small: one short entry per window", () => {
  const m = new UsageMonitor({ claudeSource: null, sessionsDir: rollouts({ a: tc("2026-10-07T09:00:00Z", 3, Math.floor(NOW / 1000) + 600) }), now: () => NOW });
  const c = compactUsage(m.snapshot()) as any;
  expect(c.codex.windows).toEqual([{ w: "7d", used: 3, left: 97, resets: new Date(NOW + 600_000).toISOString() }]);
  expect(c.claude.available).toBe(false);
  expect(JSON.stringify(c).length).toBeLessThan(1100);
});

const readingBody = {
  five_hour: { utilization: 45, resets_at: new Date(NOW + 180_000).toISOString() },
  seven_day: { utilization: 83, resets_at: new Date(NOW + 7 * 86400_000).toISOString() },
};
function harness(cache?: UsageCache, sessionsDir = missing) {
  let clock = NOW;
  let calls = 0;
  let reply: () => Promise<Response> = async () => Response.json(readingBody);
  let login: ReturnType<ClaudeSource["token"]> = { token: "secret-access-token", plan: "max" };
  const source: ClaudeSource = {
    token: () => login,
    fetch: (async () => { calls++; return reply(); }) as unknown as typeof fetch,
  };
  const options = { claudeSource: source, sessionsDir, cache, now: () => clock };
  const monitor = new UsageMonitor(options);
  return {
    monitor, options, source, calls: () => calls, now: () => clock,
    advance: (ms: number) => { clock += ms; },
    setTime: (time: number) => { clock = time; },
    reply: (f: () => Promise<Response>) => { reply = f; },
    login: (value: ReturnType<ClaudeSource["token"]>) => { login = value; },
  };
}

describe("last-good invariant", () => {
  const failures: [string, () => Promise<Response>][] = [
    ["429", async () => new Response("rate limited", { status: 429 })],
    ["timeout", async () => { throw new DOMException("request timed out", "TimeoutError"); }],
    ["network", async () => { throw new TypeError("fetch failed"); }],
    ["503", async () => new Response("busy", { status: 503 })],
    ["invalid JSON", async () => new Response("{")],
    ["empty windows", async () => Response.json({ five_hour: null })],
    ["invalid percentage", async () => Response.json({ ...readingBody, five_hour: { utilization: "45" } })],
    ["out-of-range percentage", async () => Response.json({ ...readingBody, five_hour: { utilization: 120 } })],
    ["non-finite percentage", async () => new Response('{"five_hour":{"utilization":1e400}}')],
    ["invalid reset", async () => Response.json({ ...readingBody, five_hour: { utilization: 0, resets_at: "oops" } })],
  ];
  for (const [name, failure] of failures) {
    test(`success → ${name} → recovery preserves the entire observation`, async () => {
      const h = harness();
      await h.monitor.refresh();
      const good = h.monitor.snapshot().claude;
      expect(good).toMatchObject({ available: true, stale: false, ageMs: 0, error: null });
      h.advance(CLAUDE_MIN_INTERVAL_MS);
      h.reply(failure);
      await h.monitor.refresh();
      const stale = h.monitor.snapshot().claude;
      expect(stale).toMatchObject({ available: true, plan: good.plan, windows: good.windows, asOf: good.asOf,
        stale: true, ageMs: CLAUDE_MIN_INTERVAL_MS, lastAttemptAt: h.now(), nextRetryAt: h.now() + CLAUDE_ERROR_BACKOFF_MS });
      expect(stale.error).toBeTruthy();
      const compact = compactUsage(h.monitor.snapshot()) as any;
      expect(compact.claude).toMatchObject({ available: true, stale: true, ageMs: CLAUDE_MIN_INTERVAL_MS,
        asOf: new Date(NOW).toISOString(), error: stale.error, nextRetryAt: new Date(stale.nextRetryAt!).toISOString() });
      expect(compact.claude.windows.map((w: any) => [w.used, w.left])).toEqual([[45, 55], [83, 17]]);
      // A recorded reset passes during backoff. Neither the reader nor the coordinator invents a reset.
      h.advance(120_000);
      await h.monitor.refresh();
      expect(h.calls()).toBe(2);
      expect(h.monitor.snapshot().claude.windows).toEqual(good.windows);
      expect((compactUsage(h.monitor.snapshot()) as any).claude.windows[0]).toMatchObject({ used: 45, left: 55, resetElapsed: true });
      h.setTime(stale.nextRetryAt!);
      h.reply(async () => Response.json({ five_hour: { utilization: 0, resets_at: new Date(h.now() + 3600_000).toISOString() } }));
      await h.monitor.refresh();
      expect(h.monitor.snapshot().claude).toMatchObject({ available: true, stale: false, staleReason: null,
        asOf: h.now(), ageMs: 0, error: null, nextRetryAt: null, windows: [{ usedPct: 0, remainingPct: 100 }] });
      expect(h.monitor.snapshot().claude.note).toBeUndefined();
    });
    test(`${name} without a successful reading stays unknown`, async () => {
      const h = harness();
      expect(h.monitor.snapshot().claude).toMatchObject({ available: false, asOf: null, ageMs: null, windows: [] });
      h.reply(failure);
      await h.monitor.refresh();
      expect(h.monitor.snapshot().claude).toMatchObject({ available: false, asOf: null, ageMs: null, windows: [], stale: true });
      expect(h.monitor.snapshot().claude.error).toBeTruthy();
      h.advance(CLAUDE_ERROR_BACKOFF_MS);
      h.reply(async () => Response.json(readingBody));
      await h.monitor.refresh();
      expect(h.monitor.snapshot().claude).toMatchObject({ available: true, error: null, asOf: h.now() });
    });
  }

  test("missing/expired credentials also retain last-good; thrown token errors are contained", async () => {
    const h = harness();
    await h.monitor.refresh();
    const good = h.monitor.snapshot().claude;
    h.advance(CLAUDE_MIN_INTERVAL_MS);
    h.login({ error: "token expired" });
    await h.monitor.refresh();
    expect(h.calls()).toBe(1);
    expect(h.monitor.snapshot().claude).toMatchObject({ available: true, stale: true, windows: good.windows, asOf: good.asOf });
    h.advance(CLAUDE_ERROR_BACKOFF_MS);
    h.source.token = () => { throw new Error("credentials temporarily unreadable"); };
    await h.monitor.refresh();
    expect(h.monitor.snapshot().claude).toMatchObject({ available: true, windows: good.windows, asOf: good.asOf });
  });

  test("the clock alone never creates new observations or resets", async () => {
    const h = harness();
    await h.monitor.refresh();
    const good = h.monitor.snapshot().claude;
    h.advance(8 * 86400_000);
    expect(h.monitor.snapshot().claude).toMatchObject({ windows: good.windows, asOf: NOW, stale: true, error: null });
    // Snapshots are safe to hand to callers: mutating one cannot corrupt the cache.
    h.monitor.snapshot().claude.windows[0].usedPct = 99;
    expect(h.monitor.snapshot().claude.windows).toEqual(good.windows);
  });

  test("valid responses with past reset times keep their reported percentages", () => {
    expect(parseClaudeUsage(readingBody, NOW + 86400_000)[0]).toEqual({ label: "5h", usedPct: 45, remainingPct: 55, resetsAt: NOW + 180_000 });
    for (const utilization of [NaN, Infinity, -1, 101]) expect(() => parseClaudeUsage({ five_hour: { utilization } })).toThrow();
  });

  test("Codex read failures and invalid data preserve the same cache invariant", async () => {
    const dir = rollouts({ a: tc(new Date(NOW).toISOString(), 25, (NOW + 180_000) / 1000) });
    const h = harness(undefined, dir);
    const good = h.monitor.snapshot().codex;
    const file = join(dir, "2026/10/07/rollout-a.jsonl");
    for (const bad of ["not json", tc(new Date(NOW).toISOString(), 150, NOW / 1000)]) {
      writeFileSync(file, bad);
      h.advance(CLAUDE_MIN_INTERVAL_MS);
      await h.monitor.refresh();
      expect(h.monitor.snapshot().codex).toMatchObject({ available: true, windows: good.windows, asOf: NOW, stale: true });
    }
    rmSync(dir, { recursive: true });
    writeFileSync(dir, "not a directory");
    await h.monitor.refresh();
    expect(h.monitor.snapshot().codex.error).toContain("could not read Codex logs");
    expect(h.monitor.snapshot().codex.windows).toEqual(good.windows);
    rmSync(dir);
    mkdirSync(join(dir, "2026/10/07"), { recursive: true });
    writeFileSync(file, tc(new Date(h.now()).toISOString(), 12, (h.now() + 3600_000) / 1000));
    await h.monitor.refresh();
    expect(h.monitor.snapshot().codex).toMatchObject({ available: true, stale: false, error: null, asOf: h.now(), windows: [{ usedPct: 12 }] });
  });
});

describe("persistence", () => {
  test("restart restores last-good for both providers, even after errors and elapsed resets", async () => {
    const dataDir = mkdtempSync(join(testRoot, "db-"));
    let store = new Store(dataDir);
    const dir = rollouts({ a: tc(new Date(NOW).toISOString(), 25, (NOW + 180_000) / 1000) });
    const h = harness(usageCache(store.db), dir);
    await h.monitor.refresh();
    const good = h.monitor.snapshot();
    const saved = store.db.query("SELECT * FROM usage_cache ORDER BY provider").all();
    h.advance(CLAUDE_MIN_INTERVAL_MS);
    h.reply(async () => new Response("limited", { status: 429 }));
    rmSync(dir, { recursive: true });
    await h.monitor.refresh();
    expect(store.db.query("SELECT * FROM usage_cache ORDER BY provider").all()).toEqual(saved);
    expect(JSON.stringify(saved)).not.toMatch(/secret-access-token|Authorization|token|HTTP|error|nextRetryAt/);
    store.db.close();
    h.advance(8 * 86400_000);
    store = new Store(dataDir);
    try {
      const restarted = new UsageMonitor({ ...h.options, cache: usageCache(store.db) });
      for (const p of ["claude", "codex"] as const) {
        expect(restarted.snapshot()[p]).toMatchObject({ available: true, windows: good[p].windows, asOf: good[p].asOf, stale: true });
      }
      expect(restarted.snapshot().claude.staleReason).toContain("restored");
      await restarted.refresh();
      expect(restarted.snapshot().claude).toMatchObject({ available: true, windows: good.claude.windows, asOf: NOW, stale: true });
      h.setTime(restarted.snapshot().claude.nextRetryAt!);
      h.reply(async () => Response.json({ seven_day: { utilization: 15, resets_at: new Date(h.now() + 86400_000).toISOString() } }));
      await restarted.refresh();
      expect(restarted.snapshot().claude).toMatchObject({ available: true, stale: false, error: null, asOf: h.now(), windows: [{ usedPct: 15 }] });
      const again = new UsageMonitor({ ...h.options, cache: usageCache(store.db) });
      expect(again.snapshot().claude).toMatchObject({ available: true, stale: true, asOf: h.now(), windows: [{ usedPct: 15 }] });
      const disabled = new UsageMonitor({ ...h.options, cache: usageCache(store.db), claudeSource: null });
      expect(disabled.snapshot().claude).toMatchObject({ available: false, windows: [] });
    } finally { store.db.close(); }
  });

  test("empty, malformed and invalid persisted snapshots stay unknown until a successful read", async () => {
    const store = new Store("", ":memory:");
    try {
      const cache = usageCache(store.db);
      expect(harness(cache).monitor.snapshot().claude.available).toBe(false);
      for (const data of ["{", "null", "{}", JSON.stringify({ asOf: NOW, windows: [] }), JSON.stringify({ asOf: NOW, windows: [{ label: "5h", usedPct: 0, remainingPct: 100, resetsAt: NOW, reset: true }] })]) {
        store.db.query("INSERT OR REPLACE INTO usage_cache VALUES ('claude', ?)").run(data);
        const h = harness(cache);
        expect(h.monitor.snapshot().claude).toMatchObject({ available: false, windows: [], asOf: null });
        await h.monitor.refresh();
        expect(h.monitor.snapshot().claude.available).toBe(true);
      }
    } finally { store.db.close(); }
  });

  test("cache I/O failures cannot erase a valid in-memory reading", async () => {
    const h = harness({ load: () => { throw new Error("disk read failed"); }, save: () => { throw new Error("disk full"); } });
    await h.monitor.refresh();
    const good = h.monitor.snapshot().claude;
    h.advance(CLAUDE_MIN_INTERVAL_MS);
    h.reply(async () => { throw new Error("network failed"); });
    await h.monitor.refresh();
    expect(h.monitor.snapshot().claude).toMatchObject({ available: true, windows: good.windows, asOf: NOW, stale: true });
  });

  test("Codex cannot replace a restored observation with an older log", () => {
    const store = new Store("", ":memory:");
    try {
      const cache = usageCache(store.db);
      cache.save("codex", { available: true, source: "s", asOf: NOW, windows: [{ label: "7d", usedPct: 70, remainingPct: 30, resetsAt: NOW + 3600_000 }] });
      const dir = rollouts({ a: tc(new Date(NOW - 60_000).toISOString(), 5, (NOW + 3600_000) / 1000) });
      expect(harness(cache, dir).monitor.snapshot().codex).toMatchObject({ available: true, stale: true, asOf: NOW, windows: [{ usedPct: 70 }] });
    } finally { store.db.close(); }
  });

  test("an unchanged Codex observation is persisted when a failed disk write recovers", async () => {
    const store = new Store("", ":memory:");
    try {
      const disk = usageCache(store.db);
      let fail = true;
      const cache: UsageCache = { load: disk.load, save: (provider, reading) => {
        if (fail) throw new Error("disk full");
        disk.save(provider, reading);
      } };
      const dir = rollouts({ a: tc(new Date(NOW).toISOString(), 25, (NOW + 180_000) / 1000) });
      const h = harness(cache, dir);
      expect(disk.load("codex")).toBeNull();
      fail = false;
      await h.monitor.refresh();
      rmSync(dir, { recursive: true });
      const restarted = new UsageMonitor(h.options);
      expect(restarted.snapshot().codex).toMatchObject({ available: true, asOf: NOW, stale: true, windows: [{ usedPct: 25 }] });
    } finally { store.db.close(); }
  });
});

describe("retry scheduling", () => {
  test("Retry-After seconds and HTTP dates set the earliest poll, with a two-minute floor", async () => {
    for (const [header, delay] of [["1800", 1800_000], [new Date(NOW + 7200_000).toUTCString(), 7200_000], ["0", CLAUDE_MIN_INTERVAL_MS], [new Date(NOW - 60_000).toUTCString(), CLAUDE_MIN_INTERVAL_MS]] as const) {
      const h = harness();
      h.reply(async () => new Response("limited", { status: 429, headers: { "Retry-After": header } }));
      await h.monitor.refresh();
      expect(h.monitor.snapshot().claude.nextRetryAt).toBe(NOW + delay);
      for (let elapsed = 30_000; elapsed < delay; elapsed += 30_000) {
        h.setTime(NOW + elapsed);
        await h.monitor.refresh();
      }
      expect(h.calls()).toBe(1);
      h.setTime(NOW + delay);
      await h.monitor.refresh();
      expect(h.calls()).toBe(2);
    }
  });

  test("invalid/missing Retry-After uses bounded exponential backoff; success resets it", async () => {
    for (const header of [null, "", "soon", "-1", "1.5", "1e3", "Infinity", "99999999999999999999999"]) {
      expect(retryAfterMs(header, NOW)).toBeNull();
      const h = harness();
      h.reply(async () => new Response("limited", { status: 429, headers: header === null ? {} : { "Retry-After": header } }));
      for (const delay of [600_000, 1200_000, 2400_000, CLAUDE_MAX_BACKOFF_MS, CLAUDE_MAX_BACKOFF_MS]) {
        await h.monitor.refresh();
        expect(h.monitor.snapshot().claude.nextRetryAt).toBe(h.now() + delay);
        const calls = h.calls();
        h.advance(delay - 1);
        await h.monitor.refresh();
        expect(h.calls()).toBe(calls);
        h.advance(1);
      }
      h.reply(async () => Response.json(readingBody));
      await h.monitor.refresh();
      const calls = h.calls();
      h.advance(CLAUDE_MIN_INTERVAL_MS - 1);
      await h.monitor.refresh();
      expect(h.calls()).toBe(calls);
      h.advance(1);
      h.reply(async () => new Response("limited", { status: 429 }));
      await h.monitor.refresh();
      expect(h.monitor.snapshot().claude.nextRetryAt).toBe(h.now() + CLAUDE_ERROR_BACKOFF_MS);
    }
  });

  test("backoff starts at failure completion and simultaneous refreshes are coalesced", async () => {
    const h = harness();
    let complete!: (value: Response) => void;
    h.reply(() => new Promise((resolve) => { complete = resolve; }));
    const running = h.monitor.refresh();
    await h.monitor.refresh();
    expect(h.calls()).toBe(1);
    h.advance(10_000);
    complete(new Response("limited", { status: 429 }));
    await running;
    expect(h.monitor.snapshot().claude.nextRetryAt).toBe(h.now() + CLAUDE_ERROR_BACKOFF_MS);
  });
});
