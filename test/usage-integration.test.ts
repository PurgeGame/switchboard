// Combined last-good cache and routing: real monitor/cache, deterministic provider transport.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/daemon/db.ts";
import { usageCache } from "../src/daemon/usage-cache.ts";
import { UsageMonitor, CLAUDE_MIN_INTERVAL_MS, CLAUDE_ERROR_BACKOFF_MS, type ClaudeSource } from "../src/daemon/usage.ts";
import { recommendWorker } from "../src/daemon/coordinator/recommendations.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";

test("last-good failure, restart, backoff and recovery feed conservative usage recommendations", async () => {
  mkdirSync(join(import.meta.dir, "../.sandbox"), { recursive: true });
  const dir = mkdtempSync(join(import.meta.dir, "../.sandbox/usage-combined-"));
  const store = new Store("", ":memory:");
  try {
    let now = Date.parse("2026-10-07T12:00:00Z"), fail = false, calls = 0;
    const logs = join(dir, "sessions/2026/10/07");
    mkdirSync(logs, { recursive: true });
    const codex = () => writeFileSync(join(logs, "rollout-fixture.jsonl"), JSON.stringify({ timestamp: new Date(now).toISOString(), payload: { rate_limits: { primary: { used_percent: 85, window_minutes: 300, resets_at: (now + 18_000_000) / 1000 } } } }));
    codex();
    const source: ClaudeSource = { token: () => ({ token: "fixture-only", plan: null }), fetch: (async () => {
      calls++;
      return fail ? new Response("limited", { status: 429 }) : Response.json({ five_hour: { utilization: 90, resets_at: new Date(now + 18_000_000).toISOString() } });
    }) as unknown as typeof fetch };
    const options = { claudeSource: source, sessionsDir: join(dir, "sessions"), cache: usageCache(store.db), now: () => now };
    let monitor = new UsageMonitor(options);
    const choose = () => recommendWorker({ title: "Add pagination" }, mergeCoordinatorConfig({}), monitor.snapshot(), now);
    await monitor.refresh();
    expect(choose().tier).toBe("light");
    const original = monitor.snapshot().claude;
    now += CLAUDE_MIN_INTERVAL_MS; fail = true;
    await monitor.refresh();
    expect(monitor.snapshot().claude).toMatchObject({ windows: original.windows, asOf: original.asOf, stale: true, nextRetryAt: now + CLAUDE_ERROR_BACKOFF_MS });
    expect(choose()).toMatchObject({ provider: "codex", tier: "standard" });
    expect(choose().reason).toContain("HTTP 429");
    await monitor.refresh();
    expect(calls).toBe(2);
    monitor = new UsageMonitor(options);
    expect(monitor.snapshot().claude).toMatchObject({ windows: original.windows, asOf: original.asOf, stale: true });
    expect(choose()).toMatchObject({ provider: "codex", tier: "standard" });
    expect(choose().reason).toContain("restored last observation");
    await monitor.refresh(); // retry failure after restart; retain restored numbers
    const retry = monitor.snapshot().claude.nextRetryAt!;
    now = retry - 1; await monitor.refresh(); expect(calls).toBe(3);
    now = retry; fail = false; codex(); await monitor.refresh();
    expect(calls).toBe(4);
    expect(monitor.snapshot().claude).toMatchObject({ stale: false, error: null, asOf: now });
    expect(choose().tier).toBe("light");
    now += 18_000_001;
    expect(monitor.snapshot().claude.windows).toEqual(original.windows.map((w) => ({ ...w, resetsAt: retry + 18_000_000 })));
    expect(choose().tier).toBe("standard");
    expect(choose().reason).toContain("recorded reset time passed");
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
