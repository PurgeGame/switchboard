// Real compiled UI plus a deterministic UsageMonitor. No daemon or provider connection.
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { Store } from "../../src/daemon/db.ts";
import { UsageMonitor, CLAUDE_MIN_INTERVAL_MS, CLAUDE_ERROR_BACKOFF_MS, type ClaudeSource } from "../../src/daemon/usage.ts";
import { usageCache } from "../../src/daemon/usage-cache.ts";

const root = join(import.meta.dir, "../..");
const dist = join(root, "dist/web");
const shots = join(root, ".sandbox/usage-ui");
const BASE = "https://usage.test";
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const browser = await chromium.launch({ channel: "chrome", headless: true });
mkdirSync(shots, { recursive: true });
try {
  for (const width of [320, 390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 600, hasTouch: true });
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let now = Date.parse("2026-10-07T10:00:00Z");
    let fail = true;
    const db = new Store("", ":memory:");
    const source: ClaudeSource = {
      token: () => ({ token: "fixture", plan: "max" }),
      fetch: (async () => fail ? new Response("limited", { status: 429 }) : Response.json({
        five_hour: { utilization: 45, resets_at: new Date(now + 180_000).toISOString() },
        seven_day: { utilization: 83, resets_at: new Date(now + 86400_000).toISOString() },
      })) as unknown as typeof fetch,
    };
    const opts = { claudeSource: source, cache: usageCache(db.db), sessionsDir: join(shots, "missing"), now: () => now };
    let monitor = new UsageMonitor(opts);
    let socket: { send: (s: string) => void } | undefined;
    const push = () => socket!.send(JSON.stringify({ type: "usage", usage: monitor.snapshot() }));
    const advance = async (ms: number) => { now += ms; await page.clock.fastForward(ms); };
    try {
      await page.clock.install({ time: now });
      await page.route(`${BASE}/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.startsWith("/api/")) {
          const json = path === "/api/ws-ticket" ? { ticket: "test" }
            : path === "/api/usage" ? monitor.snapshot()
            : path === "/api/coordination" ? { objectives: [], tasks: [], claims: [], conflicts: [] }
            : path === "/api/coordinator" || path === "/api/system" ? null
            : path === "/api/governor" ? { gameMode: false, gameManual: null, sessions: [], log: [] } : [];
          return route.fulfill({ json });
        }
        const file = join(dist, path === "/" ? "index.html" : path);
        if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
        return route.fulfill({ body: readFileSync(file), contentType: ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      });
      await page.routeWebSocket(/\/api\/ws/, (ws) => {
        socket = ws;
        ws.send(JSON.stringify({ type: "hello", sessions: [], system: null, attention: [], groups: [], coordinatorAgent: "none" }));
      });
      await page.goto(BASE);
      const chip = page.getByRole("button", { name: "Claude and Codex usage limits" });
      const dialog = page.getByRole("dialog", { name: "Usage limits" });
      const detail = dialog.locator("section").filter({ has: page.getByRole("heading", { name: /Claude/ }) });
      await chip.waitFor();
      check(await chip.getByText("–", { exact: true }).count() === 2, "startup must show unknown, not zero");
      await chip.tap();
      await detail.getByText("Usage unknown; no successful reading yet.").waitFor();
      await page.keyboard.press("Escape");
      await monitor.refresh();
      push();
      await chip.tap();
      await detail.getByText("Claude usage fetch failed: HTTP 429").waitFor();
      check(await detail.getByText(/% used/).count() === 0, "failure before success must not invent a percentage");
      await page.keyboard.press("Escape");

      await advance(CLAUDE_ERROR_BACKOFF_MS);
      fail = false;
      await monitor.refresh();
      const asOf = monitor.snapshot().claude.asOf!;
      push();
      await chip.getByText("17%", { exact: true }).waitFor();
      check(await chip.getByText("stale", { exact: true }).count() === 0, "successful read must be fresh");
      await advance(CLAUDE_MIN_INTERVAL_MS);
      fail = true;
      await monitor.refresh();
      push();
      await chip.getByLabel("Claude stale; last updated 2m ago").waitFor();
      await chip.getByText("17%", { exact: true }).waitFor();
      check(await page.getByText("Claude usage fetch failed: HTTP 429").count() === 0, "error should stay in the details, not a warning bar");
      await page.screenshot({ path: join(shots, `stale-${width}.png`) });
      await chip.tap();
      await detail.getByText("Claude usage fetch failed: HTTP 429").waitFor();
      await detail.getByText("Stale · last observed 2m ago").waitFor();
      await detail.getByText("45% used · 55% left").waitFor();
      await detail.getByText("Next retry in 10m").waitFor();
      // Time advances without a daemon push: browser must not imply a reset either.
      await advance(60_000);
      await detail.getByText(/Recorded reset time passed; new usage unknown/).waitFor();
      await detail.getByText("45% used · 55% left").waitFor();
      check(await detail.getByText(/resets in 0m/i).count() === 0, "elapsed reset was presented as current");
      await page.screenshot({ path: join(shots, `detail-${width}.png`) });
      await page.keyboard.press("Escape");
      check(!await dialog.count(), "Escape should close usage details");
      check(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), "stale chip overflows viewport");
      const box = await chip.boundingBox();
      check(box && box.x >= 0 && box.x + box.width <= width && box.height <= 44, "stale indication should remain compact");

      monitor = new UsageMonitor(opts);
      push();
      await chip.getByLabel("Claude stale; last updated 3m ago").waitFor();
      await chip.getByText("17%", { exact: true }).waitFor();
      check(monitor.snapshot().claude.asOf === asOf, "restart changed observation time");
      fail = false;
      await monitor.refresh();
      push();
      await chip.getByText("stale", { exact: true }).waitFor({ state: "detached" });
      await chip.tap();
      await detail.getByText("Last updated just now").waitFor();
      check(await detail.getByText(/HTTP 429|Recorded reset time passed|Next retry/).count() === 0, "recovery retained stale/error state");
      check(errors.length === 0, errors.join(" | "));
      console.log(`PASS usage unknown, stale, reset expiry, restart and recovery at ${width}px`);
    } finally {
      db.db.close();
      await context.close();
    }
  }
} finally { await browser.close(); }
