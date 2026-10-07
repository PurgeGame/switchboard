#!/usr/bin/env bun
// Phone width (390 x 844): pending coordinator cards (plans, messages) and tasks waiting for
// "Looks good" must be visible and tappable, starting from what a phone shows first.
// The built UI is served from inside the page and the daemon's API and websocket are mocked with
// fixed state, so no daemon runs and nothing live is touched. Uses the installed Google Chrome.
//   bun test/e2e/phone.ts [dist dir (default dist/web)] [screenshot dir]     (SB_PHONE_BROWSER=webkit for Safari's engine)
import { chromium, webkit, type Page } from "playwright-core";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { blankSession } from "../../src/daemon/state.ts";
import { usageSettingsUI } from "./usage-ui.ts";
import { memoryUI } from "./memory-ui.ts";
import { Database } from "bun:sqlite";
import { CoordinatorMemory } from "../../src/daemon/coordinator/memory.ts";
import { happeningChecks } from "./happening.ts";
import { checkFullCard, longCardText } from "./card-content.ts";
import { checkSessionPlacement } from "./session-placement.ts";
import type { SbEvent } from "../../src/shared/types.ts";

const root = join(import.meta.dir, "../..");
const dist = process.argv[2] ?? join(root, "dist/web");
const shots = process.argv[3] ?? null;
if (!existsSync(join(dist, "index.html"))) throw new Error(`no built UI in ${dist}: run bun run build`);
if (shots) mkdirSync(shots, { recursive: true });
// HTTPS, as the phone reaches it (tailscale serve): a secure context, like the real one (crypto.randomUUID etc.).
const BASE = "https://phone.test";
const now = Date.now();
const memoryDb = new Database(":memory:");
const memory = new CoordinatorMemory(memoryDb);

const usage = {
  ts: now,
  claude: { available: true, source: "test", asOf: now, plan: "max", windows: [{ label: "5h", usedPct: 45, remainingPct: 55, resetsAt: now + 2 * 3600_000 + 13 * 60_000 }, { label: "7d", usedPct: 83, remainingPct: 17, resetsAt: now + 2 * 86400_000 }] },
  codex: { available: true, source: "test", asOf: now, plan: "pro", windows: [{ label: "7d", usedPct: 1, remainingPct: 99, resetsAt: now + 6 * 86400_000 }] },
};

// ---------------------------------------------------------------- the state the user reported
const session = (id: string, name: string, extra: any = {}) => ({ ...blankSession(id, "claude", "tui", id), name, cwd: "/home/u/Dev/app", execution: "idle", startedAt: now - 3600_000, lastActivityAt: now - 600_000, firstPrompt: `Work on ${name}`, ...extra });
const sessions = [
  session("claude:w1", "sb-2ab448aa-standard"),
  session("codex:01a11391", "sb-8f5a8724-standard", { provider: "codex" }),
  session("claude:w3", "sb-a89c9ab8-standard"),
  // Working, with a command it started 1d 10h ago still running (the row in the user's screenshot).
  session("claude:mine", "my-session", {
    execution: "working",
    sendMethods: ["terminal"],
    pidConfidence: "confirmed",
    turnStartedAt: now - 15 * 60_000,
    resources: { running: { kind: "command", cmd: "bun run dev", since: now - 34 * 3600_000 } },
    // Its subagents: one it started, one that one started, and one that finished.
    subagents: [
      { id: "a1", type: "general-purpose", description: "Phase F integration", model: "opus", parentId: null, status: "running", activity: "Rerunning FlipHundredsInvariant tests", startedAt: now - 54 * 60_000, lastActivityAt: now - 5000, endedAt: null },
      { id: "a2", type: "general-purpose", description: "Migrate core game tests", model: "sonnet", parentId: "a1", status: "running", activity: "Editing Game.t.sol", startedAt: now - 13 * 60_000, lastActivityAt: now - 5000, endedAt: null },
      { id: "a3", type: "Explore", description: "Inventory the interfaces", model: "haiku", parentId: null, status: "completed", activity: null, startedAt: now - 90 * 60_000, lastActivityAt: now - 80 * 60_000, endedAt: now - 80 * 60_000 },
    ],
  }),
  // A worker after a /clear: a new id the coordinator doesn't know (no meta.background), still in its worktree.
  session("claude:cleared", "sb-a89c9ab8-3333-4000-8000-000000000003-deep", { cwd: "/home/u/Dev/.switchboard-worktrees/app/a89c9ab8-chat-instructions-count-as-approval" }),
];
const sessionEvents = new Map<string, SbEvent[]>();
function activity(s: typeof sessions[number], id: number, type: SbEvent["type"], text = "") {
  const event: SbEvent = { id, sessionId: s.id, sourceId: `unread-${id}`, type, ts: Date.now(), data: { text } };
  sessionEvents.set(s.id, [...(sessionEvents.get(s.id) ?? []), event]);
  s.lastEventId = id;
  s.lastActivityAt = event.ts;
  push({ type: "event", event });
  push({ type: "session", session: s });
}
const grant = { id: "g1", root: "/home/u/Dev/app", rootId: "1:2", resources: [], verification: [], issuedBy: "human", issuedAt: now, revokedAt: null, provenance: "human approved plan #12" };
const objective = { id: "o1", title: "Coordinator fixes", description: "", status: "active", priority: "normal", createdAt: now, updatedAt: now, grant };
const task = (id: string, title: string, owner: string) => ({
  id, objectiveId: "o1", title, description: "", owner, scope: { paths: [], resources: [] }, priority: "normal", tier: "standard", tierReason: null, prerequisites: [],
  acceptance: ["tests pass", "typecheck passes"], status: "finished_unverified", result: `${title}: done, full suite passes.`, evidence: [], verifiedEvidence: [], worktree: null, createdAt: now, updatedAt: now,
});
const tasks = [
  task("2ab448aa-1111-4000-8000-000000000001", "Make coordinator send_message proposals approvable", "claude:w1"),
  task("8f5a8724-2222-4000-8000-000000000002", "Link Codex workers to their task", "codex:01a11391"),
  task("a89c9ab8-3333-4000-8000-000000000003", "Chat instructions count as approval", "claude:w3"),
];
tasks[0].result = longCardText;
const recommendation = { provider: "claude" as const, tier: "standard" as const, model: "sonnet", effort: null, reason: "Claude: spend available capacity resetting soon. Codex: usage stale (as of yesterday).", at: now - 60000, queued: false, baseTier: "standard" as const, baseReason: "Routine work", tierSelected: false, providerSelected: false };
const planTask = (key: string) => ({ key, title: `Do ${key}`, brief: `Implement ${key} with tests. `.repeat(6), acceptance: [`${key} works`, "bun test passes"], prerequisites: [], provider: "claude", model: "sonnet", effort: null, tier: "standard", requestedTier: "standard", tierReason: "", tierOverride: null, recommendation, paths: [`/home/u/Dev/app/src/${key}.ts`] });
// A real plan lists up to 8 tasks: the small-phone run uses 6, so a card is taller than the screen.
const PLAN_TASKS = ["api", "tests", "docs", "cli", "ui", "migration"];
let planSize = 3;
const plan = (id: number, title: string) => ({
  id, createdAt: now - 60_000, kind: "action", sessionId: null, taskId: null, title, text: "", reason: "you asked for it in chat", heldBecause: "outside_authority", state: "pending", resolvedAt: null, detail: null,
  payload: { action: "plan", title, root: "/home/u/Dev/app", resources: [], tasks: PLAN_TASKS.slice(0, planSize).map(planTask) }, digest: `d${id}`,
});
const proposals = () => [plan(20, "Show finished toggle"), plan(19, "Phone layout fixes")];
const chat = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, at: now - (30 - i) * 60_000, role: i % 2 ? "coordinator" : "user", text: i % 2 ? `Reply ${i}: on it, here's what I found and what I'll do next.` : `Message ${i}: please look at the coordinator.` }));
// A reply with paragraphs and a list, as the coordinator writes them.
chat.push({ id: 31, at: now - 30_000, role: "coordinator", text: "Here are your limits.\n\n**Workers**\n- Cap: 10 at once\n- Only real workers count\n\nThat's all." });
const coordinator = {
  agent: "builtin", lastToolCallAt: now, mode: "active", model: "opus", running: true, busy: false,
  budget: { day: "2026-10-07", spentUsd: 1, limitUsd: 10, inputTokens: 0, outputTokens: 0, exhausted: false },
  limits: { perSessionCooldownMs: 600_000, perSessionPerHour: 6, maxLaunched: 3, maxRelayHops: 4 },
  excluded: [], autopilot: [], launched: [], nextWakeAt: null, pendingEvents: 0, activity: [], proposals: [] as unknown[], plans: [] as any[], chat, needsVerification: [], screenLabel: "",
};
const coordination = { objectives: [objective], tasks, claims: [], conflicts: [], reservations: [] };
const hello = { type: "hello", sessions, system: null, attention: [], groups: [], coordinatorAgent: "builtin" };

// ---------------------------------------------------------------- the page, served and mocked
const calls: string[] = [];
const END_REFUSAL = "No claude process in this folder has this session's transcript open; nothing was ended.";
let endRefusal = END_REFUSAL;
let attention: any[] = [];
let autoApproveSafe = true;
let refuseEnd = true;
let usageSettings = { enabled: true, lowRemainingPct: 20, stopRemainingPct: 5, resetSoonMinutes: 60, maxAgeMinutes: 15 };
let ws: { send: (m: string) => void } | null = null;
const push = (m: unknown) => ws?.send(JSON.stringify(m));
/** What the daemon does after each tap, pushed over the websocket like the real one. */
function settle(path: string, body: any) {
  if (path === "/api/coordinator/usage-recommendations") return usageSettings = body;
  if (path === "/api/coordinator/memory") return memory.remember(body, "user");
  const memoryDelete = path.match(/^\/api\/coordinator\/memory\/([^/]+)\/delete$/);
  if (memoryDelete) return { forgotten: memory.forget(memoryDelete[1], "user") };
  if (path === "/api/settings/permissions") { autoApproveSafe = body.autoApproveSafe; return { autoApproveSafe }; }
  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/api\/coordinator\/proposals\/(\d+)\/(approve|reject)$/))) {
    const p = (coordinator.proposals as any[]).find((x) => x.id === Number(m![1]));
    if (p) p.state = m[2] === "approve" ? "approved" : "rejected";
    push({ type: "coordinator", ...coordinator });
  } else if ((m = path.match(/^\/api\/coordinator\/plans\/(\d+)\/tasks\/([^/]+)\/retry$/))) {
    const plan = (coordinator.plans as any[]).find((x) => x.proposalId === Number(m![1]));
    const t = plan?.tasks.find((x: any) => x.key === m![2]);
    if (t) t.state = "waiting";
    push({ type: "coordinator", ...coordinator });
  } else if ((m = path.match(/^\/api\/tasks\/([^/]+)\/evidence$/))) {
    const t = tasks.find((x) => x.id === decodeURIComponent(m![1]));
    if (t) t.status = "verified";
    push({ type: "coordination", ...coordination });
  } else if ((m = path.match(/^\/api\/attention\/(\d+)\/(answer|ack)$/))) {
    resolve(Number(m[1]), m[2] === "ack" ? "acknowledged" : "answered_ui");
  } else if ((m = path.match(/^\/api\/sessions\/([^/]+)\/end$/))) {
    if (refuseEnd) return { ok: false, how: "signal", error: endRefusal };
    const s = sessions.find((x) => x.id === decodeURIComponent(m![1]));
    if (s) { Object.assign(s, { execution: "ended", endedAt: Date.now(), sendMethods: [] }); push({ type: "session", session: s }); }
    return { ok: true, how: "typed the exit command" };
  } else if ((m = path.match(/^\/api\/sessions\/([^/]+)\/resume$/))) {
    const s = sessions.find((x) => x.id === decodeURIComponent(m![1]));
    if (s) { Object.assign(s, { execution: "idle", endedAt: null, sendMethods: ["terminal"] }); push({ type: "session", session: s }); }
    return { ok: true };
  } else if ((m = path.match(/^\/api\/sessions\/([^/]+)\/messages$/))) {
    // Your reply reaches the session: its open question is answered.
    for (const i of attention) if (i.sessionId === decodeURIComponent(m[1]) && i.kind === "question" && i.status === "open") resolve(i.id, "answered_ui");
    return { id: 1, sessionId: decodeURIComponent(m[1]), clientId: body?.clientId ?? "c", author: "human", method: "terminal", mode: "auto", state: "accepted", text: body?.text ?? "", images: [], imageDelivery: null, createdAt: now, updatedAt: now, error: null, receipt: false, detail: null };
  }
  return { ok: true };
}
function resolve(id: number, resolution: string) {
  const i = attention.find((x) => x.id === id);
  if (!i) return;
  Object.assign(i, { status: "resolved", resolution, resolvedAt: Date.now() });
  push({ type: "attention", item: i });
}
async function open(page: Page) {
  coordinator.proposals = proposals();
  for (const t of tasks) t.status = "finished_unverified";
  await page.route(`${BASE}/**`, async (r) => {
    const url = new URL(r.request().url());
    const p = url.pathname;
    if (p.startsWith("/api/")) {
      if (p === "/api/coordinator/memory" && r.request().method() === "GET") return r.fulfill({ json: memory.snapshot() });
      if (r.request().method() === "POST") {
        calls.push(p);
        return r.fulfill({ json: settle(p, r.request().postDataJSON?.() ?? null) });
      }
      const json =
        p === "/api/coordinator/usage-recommendations" ? usageSettings : p === "/api/settings/permissions" ? { autoApproveSafe } : p === "/api/ws-ticket" ? { ticket: "t" } : p === "/api/coordination" ? coordination : p === "/api/coordinator" ? coordinator : p === "/api/governor" ? { gameMode: false, gameManual: null, sessions: [], log: [] } : p === "/api/usage" ? usage : p === "/api/system" ? null : p === "/api/attention" ? attention : p.endsWith("/events") ? sessionEvents.get(decodeURIComponent(p.split("/")[3])) ?? [] : p.endsWith("/outbox") ? [] : { ok: true };
      return r.fulfill({ json });
    }
    const file = join(dist, p === "/" ? "index.html" : p);
    if (!existsSync(file)) return r.fulfill({ status: 404, body: "" });
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[extname(file)] ?? "application/octet-stream";
    return r.fulfill({ body: readFileSync(file), contentType: type });
  });
  await page.routeWebSocket(/\/api\/ws/, (socket) => {
    ws = socket;
    socket.send(JSON.stringify({ ...hello, attention }));
  });
  await page.goto(BASE);
}

const results: [string, boolean, string][] = [];
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push([name, true, ""]);
    console.log(`PASS  ${name}`);
  } catch (e) {
    const msg = String((e as Error).message).split("\n")[0];
    results.push([name, false, msg]);
    console.log(`FAIL  ${name}  (${msg})`);
    console.error((e as Error).stack ?? e);
  }
}
const shot = async (page: Page, name: string) => shots && (await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false, scale: "css" }));

/** On screen (scrolling it into view if needed), not covered, and accepts a tap. */
async function tappable(page: Page, loc: ReturnType<Page["locator"]>, what: string) {
  await loc.scrollIntoViewIfNeeded({ timeout: 5_000 });
  const box = await loc.boundingBox();
  if (!box) throw new Error(`${what}: not rendered`);
  const vp = page.viewportSize()!;
  if (box.y < 0 || box.y + box.height > vp.height || box.x < 0 || box.x + box.width > vp.width) throw new Error(`${what}: off screen at ${JSON.stringify(box)}`);
  await loc.click({ trial: true, timeout: 5_000 }); // visible, stable, enabled, and not covered by anything
}

// SB_PHONE_BROWSER=webkit: Safari's engine (every iPhone browser), via Playwright's WebKit build.
// Chromium's headless default hides scrollbars; show them so the screenshots exercise the real UI.
const browser = process.env.SB_PHONE_BROWSER === "webkit" ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: "chrome", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  const T = { timeout: 10_000 };
  await step("phone: Settings memory adds, edits and deletes lessons across reloads with reachable touch controls", () => memoryUI(page));
  await step("Usage recommendation Settings save and survive reload at this viewport", () => usageSettingsUI(page));

  await step("phone: Settings safe-permission switch is visible, tappable and persists", async () => {
    const button = page.getByRole("button", { name: "Settings", exact: true });
    await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/settings/permissions")), button.tap()]);
    const toggle = page.getByRole("checkbox", { name: /Auto-approve safe permissions/ });
    await tappable(page, toggle, "safe permission switch");
    if (!await toggle.isChecked()) throw new Error("default is not on");
    await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/settings/permissions") && r.request().method() === "POST"), toggle.uncheck()]);
    await button.tap();
    await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/settings/permissions") && r.request().method() === "GET"), button.tap()]);
    if (await toggle.isChecked()) throw new Error("off was not saved");
    await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/settings/permissions") && r.request().method() === "POST"), toggle.check()]);
    await button.tap();
  });
  await step("phone: the top bar shows Claude and Codex usage, and a tap opens every window", async () => {
    const chip = page.getByRole("button", { name: "Claude and Codex usage limits" });
    await chip.waitFor(T);
    const text = (await chip.innerText()).replace(/\s+/g, " ");
    if (!/17%.*99%/.test(text) || (await chip.getByRole("img").count()) !== 6) throw new Error(`chip text: ${text}`);
    await tappable(page, chip, "usage chip");
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("the top bar overflows sideways");
    await shot(page, "usage-0-bar");
    await chip.tap();
    const dlg = page.getByRole("dialog", { name: "Usage limits" });
    await dlg.waitFor(T);
    const box = (await dlg.boundingBox())!;
    if (box.x < 0 || box.x + box.width > page.viewportSize()!.width) throw new Error(`detail off screen: ${JSON.stringify(box)}`);
    for (const t of ["55% left", "17% left", "99% left"]) if (!(await dlg.innerText()).includes(t)) throw new Error(`detail lacks ${t}`);
    await shot(page, "usage-1-detail");
    await chip.tap();
  });
  await step("phone: session rows never grow a line (chips sit on the second line), and the group's folder isn't repeated", async () => {
    const rows = page.locator('[data-session-id^="claude:"], [data-session-id^="codex:"]');
    await rows.first().waitFor(T);
    const mine = page.locator('[data-session-id="claude:mine"]');
    await mine.getByText("Command running").waitFor(T);
    const heights = await rows.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    if (new Set(heights).size !== 1) throw new Error(`row heights differ: ${heights.join(", ")}`);
    if (await page.locator('[data-session-id^="claude:"] >> text="app"').count()) throw new Error('rows repeat the folder "app" under its own heading');
  });
  await step("phone: a folder collapses to a summary of its sessions' states, and opens again", async () => {
    const heading = page.getByRole("button", { name: /^app/ });
    await heading.waitFor(T);
    const summary = heading.locator("[aria-label]");
    if ((await summary.getAttribute("aria-label")) !== "1 working, 3 idle") throw new Error(`summary: ${await summary.getAttribute("aria-label")}`);
    await heading.tap();
    if ((await heading.getAttribute("aria-expanded")) !== "false") throw new Error("didn't collapse");
    if (await page.locator('[data-session-id="claude:mine"]').count()) throw new Error("its sessions still show when collapsed");
    await shot(page, "0-collapsed");
    await heading.tap();
    await page.locator('[data-session-id="claude:mine"]').waitFor(T);
  });
  await step("phone: a worker in a coordinator worktree is under Background agents, named by its task", async () => {
    const cleared = page.locator('[data-session-id="claude:cleared"]');
    const section = page.getByRole("button", { name: /^Background agents/ });
    await section.waitFor(T);
    if (await cleared.count()) throw new Error("the worker shows outside the collapsed Background section");
    const summary = await section.locator("[aria-label]").getAttribute("aria-label");
    if (summary !== "1 idle") throw new Error(`Background agents summary: ${summary}`);
    await section.tap();
    await cleared.waitFor(T);
    const text = await cleared.innerText();
    if (!text.includes("Chat instructions count as approval")) throw new Error(`not named by its task: ${JSON.stringify(text)}`);
    if (text.includes("sb-") || text.includes("a89c9ab8")) throw new Error(`still shows the task id: ${JSON.stringify(text)}`);
    if (!/\bapp\b/.test(text)) throw new Error(`line 2 doesn't say which project: ${JSON.stringify(text)}`);
    const [h, mine] = await Promise.all([cleared, page.locator('[data-session-id="claude:mine"]')].map((l) => l.evaluate((e) => Math.round(e.getBoundingClientRect().height))));
    if (h !== mine) throw new Error(`worker row is ${h}px, others ${mine}px`);
    await shot(page, "0-background");
    await section.tap();
  });
  await step("phone: row menu and session view pin a background agent to main and send it back; placement survives reload", async () => {
    await checkSessionPlacement(page, "claude:cleared", sessions.find((s) => s.id === "claude:cleared")!.cwd!, true);
    await page.getByRole("button", { name: /^Background agents/ }).tap();
  });
  await step("phone: nothing spins: working is a still blue icon (only the amber needs-you light pulses)", async () => {
    await page.locator('[data-session-id="claude:mine"]').getByText("Working").waitFor(T);
    const moving = await page.evaluate(() => document.getAnimations().map((a) => (a as CSSAnimation).animationName ?? "?").filter((n) => n !== "lamp"));
    if (moving.length) throw new Error(`still animating: ${moving.join(", ")}`);
    const tone = await page.locator('[data-session-id="claude:mine"] .pill').first().evaluate((e) => getComputedStyle(e).color);
    if (!/rgb\(\s*\d+,\s*\d+,\s*(\d+)\)/.test(tone) || Number(tone.match(/(\d+)\)$/)![1]) < 150) throw new Error(`the Working pill isn't blue: ${tone}`);
  });
  const show = page.getByRole("group", { name: "Show", exact: true });
  const active = (count: number) => show.getByRole("button", { name: `Active ${count}`, exact: true });
  const rows = () => page.getByRole("navigation", { name: "Sessions", exact: true }).locator('[data-session-id^="claude:"], [data-session-id^="codex:"]');
  await step("phone: Active fits next to Working at 390px and shows only unread output, including background agents", async () => {
    await active(0).waitFor(T);
    await tappable(page, active(0), "Active chip");
    const [workingBox, activeBox] = await Promise.all([show.getByRole("button", { name: "Working", exact: true }), active(0)].map((l) => l.boundingBox()));
    if (!workingBox || !activeBox || activeBox.x < workingBox.x + workingBox.width || activeBox.y !== workingBox.y || activeBox.x + activeBox.width > 390) throw new Error("Active isn't next to Working on screen");
    activity(sessions[0], 100, "user_msg", "Input alone should stay read");
    await page.locator('[data-session-id="claude:w1"]').getByText("just now", { exact: true }).waitFor(T);
    if (await active(0).count() !== 1) throw new Error("input counted as unread output");
    activity(sessions[0], 101, "assistant_msg", "Unread reply");
    activity(sessions[4], 102, "turn_ended");
    activity(sessions[1], 103, "tool_result", "Tool output alone should stay read");
    await active(2).waitFor(T);
    await page.locator('[data-session-id="codex:01a11391"]').getByText("just now", { exact: true }).waitFor(T);
    if (await active(2).count() !== 1) throw new Error("tool output counted as unread");
    await active(2).tap();
    const ids = await rows().evaluateAll((els) => els.map((e) => e.getAttribute("data-session-id")).sort());
    if (JSON.stringify(ids) !== JSON.stringify(["claude:cleared", "claude:w1"])) throw new Error(`Active rows: ${ids}`);
    for (const id of ids) await page.locator(`[data-session-id="${id}"]`).getByRole("img", { name: "Unread activity" }).waitFor(T);
    await shot(page, "0-active-unread");
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Active overflows at 390px");
  });
  await step("phone: opening clears the dot and count; returning to the list leaves later output unread", async () => {
    await page.locator('[data-session-id="claude:w1"]').tap();
    await page.getByRole("heading", { name: "sb-2ab448aa-standard", exact: true }).waitFor(T);
    await page.getByRole("button", { name: "Back to session list" }).tap();
    await active(1).waitFor(T);
    if (await page.locator('[data-session-id="claude:w1"]').count()) throw new Error("read row still shows in Active");
    activity(sessions[0], 104, "assistant_msg", "New output while the session pane is closed");
    await active(2).waitFor(T);
    await show.getByRole("button", { name: "All", exact: true }).tap();
    await page.locator('[data-session-id="claude:w1"]').tap();
    await page.getByRole("button", { name: "Back to session list" }).tap();
    await active(1).waitFor(T);
    if (await page.locator('[data-session-id="claude:w1"]').getByRole("img", { name: "Unread activity" }).count()) throw new Error("opened row retains its dot");
    await page.reload();
    await page.getByRole("button", { name: "Back to session list" }).tap();
    await active(1).waitFor(T);
    await active(1).tap();
    if (await rows().count() !== 1) throw new Error("read state didn't survive reload");
    await page.locator('[data-session-id="claude:cleared"]').tap();
    await page.getByRole("button", { name: "Back to session list" }).tap();
    await active(0).waitFor(T);
    await page.getByText("No sessions match these filters.", { exact: true }).waitFor(T);
    await show.getByRole("button", { name: "All", exact: true }).tap();
  });
  await step("phone: a session's subagents: a chip on its row, and what each is doing in the session", async () => {
    const mine = page.locator('[data-session-id="claude:mine"]');
    await mine.getByText("2 agents").waitFor({ state: "attached", ...T });
    await mine.tap();
    // The header keeps the title and End on screen, even while a command runs.
    const endBtn = page.getByRole("button", { name: "End", exact: true });
    for (const [what, loc] of [["title", page.getByRole("heading", { name: "my-session" })], ["End", endBtn]] as const) {
      await loc.waitFor(T);
      const b = await loc.boundingBox();
      if (!b || b.width < 20 || b.x < 0 || b.x + b.width > 390) throw new Error(`${what} isn't on screen: ${JSON.stringify(b)}`);
    }
    // One tap ends; a refusal shows its whole reason (a phone cannot hover).
    await endBtn.tap();
    const endLine = page.getByRole("group", { name: "Session action" }).filter({ visible: true });
    const why = endLine.getByRole("alert");
    await why.waitFor(T);
    if ((await why.innerText()) !== END_REFUSAL) throw new Error(`reason: ${await why.innerText()}`);
    const wb = await why.boundingBox();
    if (!wb || wb.x + wb.width > 390 || (await why.evaluate((e) => e.scrollWidth > e.clientWidth))) throw new Error("the reason is cut off");
    await shot(page, "0-end-refused");
    await endLine.getByRole("button", { name: "OK" }).tap();
    await endLine.waitFor({ state: "detached", ...T });
    const panel = page.getByRole("region", { name: "Subagents" });
    const bar = panel.getByRole("button", { name: /2 agents working/ });
    await bar.waitFor(T);
    if (!(await panel.getByText("1 finished recently").count())) throw new Error("doesn't say one finished");
    if ((await bar.getAttribute("aria-expanded")) !== "true") await bar.tap();
    await panel.getByText("Rerunning FlipHundredsInvariant tests").waitFor(T);
    await panel.getByText("Editing Game.t.sol · sonnet").waitFor(T);
    const indent = async (t: string) => panel.locator("li", { hasText: t }).evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft));
    if (!((await indent("Migrate core game tests")) > (await indent("Phase F integration")))) throw new Error("the nested agent isn't under its parent");
    if (await panel.getByText("Inventory the interfaces").count()) throw new Error("finished agents should start folded");
    await panel.getByRole("button", { name: /Finished \(1\)/ }).tap();
    await panel.getByText("Inventory the interfaces").waitFor(T);
    await shot(page, "0-subagents");
    const box = await panel.boundingBox();
    if (!box || box.width > 391) throw new Error(`panel wider than the phone: ${box?.width}`);
    await panel.getByRole("button", { name: /2 agents working/ }).tap(); // fold it again (remembered per browser)
    await page.getByRole("button", { name: "Back to session list" }).tap();
    await page.locator('[data-session-id="coordinator"]').waitFor(T);
  });
  await step("phone: the first screen says the coordinator has things for you", async () => {
    const row = page.locator('[data-session-id="coordinator"]');
    await row.waitFor(T);
    await shot(page, "1-list");
    await tappable(page, row, "coordinator row");
    const text = await row.innerText();
    if (!/5/.test(text)) throw new Error(`the coordinator row doesn't show 5 waiting: ${JSON.stringify(text)}`);
  });
  await step("phone: coordinator chat still opens from its session row", async () => {
    await page.locator('[data-session-id="coordinator"]').tap();
    await page.getByRole("region", { name: "Coordinator chat" }).waitFor(T);
  });
  await step("phone: the coordinator's replies keep their paragraphs, lists and bold", async () => {
    const item = page.locator(".md li", { hasText: "Cap: 10 at once" });
    await item.waitFor({ state: "attached", ...T });
    if ((await page.locator(".md li").count()) < 2) throw new Error("the list didn't render as list items");
    if (!(await page.locator(".md strong", { hasText: "Workers" }).count())) throw new Error("bold didn't render");
    if (await page.getByText("**Workers**").count()) throw new Error("raw markdown shows");
  });
  await step("phone: the message box shows one focus ring, not a box inside a box", async () => {
    const box = page.getByPlaceholder(/Tell the coordinator/);
    await box.focus();
    const inner = await box.evaluate((e) => getComputedStyle(e).outlineStyle);
    if (inner !== "none") throw new Error(`the text field draws its own ring too: outline ${inner}`);
    const outer = await box.evaluate((e) => getComputedStyle(e.closest(".rounded-xl")!).borderTopColor);
    const idle = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-line-strong"));
    if (!outer || outer === idle) throw new Error("the box doesn't light up when focused");
    await box.blur();
  });
  const row = (p: Page, id: string) => p.locator(`[data-needs-you-id="${id}"]`);
  await step("phone: plan card shows the usage choice, stale source and evaluation time", async () => {
    await page.getByRole("button", { name: /^Inbox,/ }).tap();
    const planRow = row(page, "proposal:20");
    await planRow.locator("button[aria-expanded]").tap();
    const reason = planRow.getByLabel("Worker choice reason").first();
    await reason.getByText(recommendation.reason, { exact: true }).waitFor();
    if (!(await reason.innerText()).includes("usage may have changed")) throw Error("Card presented an old decision as fresh");
    if (await reason.evaluate((e) => e.scrollWidth > e.clientWidth)) throw Error("Choice reason overflows the card");
    await planRow.locator("button[aria-expanded]").tap();
  });
  await step("phone: the complete long result scrolls with code, line breaks and fixed actions", async () => {
    const review = row(page, `review:${tasks[0].id}`);
    await review.locator("button[aria-expanded]").tap();
    const card = review.locator(".needs-you-card");
    await checkFullCard(page, card, "Task result", ["Looks good", "Not yet…", "See the session"]);
    await shot(page, "8-long-result-phone-end");
    await card.getByRole("region", { name: "Task result" }).evaluate((e) => e.scrollTop = 0);
    await shot(page, "8-long-result-phone");
    await review.locator("button[aria-expanded]").tap();
  });
  await step("phone: one actionable inbox list, inline actions and a single notification enable button", async () => {
    const needs = page.getByRole("region", { name: "Needs you", exact: true });
    if (await needs.count() !== 1) throw new Error("more than one Needs you list");
    await needs.getByLabel("5 items need you").waitFor(T);
    if (await page.getByRole("button", { name: "Enable notifications", exact: true }).count() !== 1) throw new Error("expected one enable button");
    for (const id of ["proposal:19", "proposal:20"]) for (const name of ["Go ahead", "No thanks"]) await tappable(page, row(page, id).getByRole("button", { name, exact: true }), `${id} ${name}`);
    for (const t of tasks) await tappable(page, row(page, `review:${t.id}`).getByRole("button", { name: "Looks good" }), t.title);
    await shot(page, "3-looks-good");
  });
  await step("phone: proposal details preserve the full plan and exact approval digest", async () => {
    const planRow = row(page, "proposal:19");
    await planRow.getByRole("button", { name: "Decide: Phone layout fixes", exact: true }).tap();
    await planRow.getByText("Plan: Phone layout fixes", { exact: true }).waitFor(T);
    await planRow.getByText("Do api", { exact: false }).first().waitFor({ state: "attached", ...T });
    await planRow.getByRole("button", { name: "Decide: Phone layout fixes", exact: true }).tap();
    await planRow.getByRole("button", { name: "Go ahead", exact: true }).tap();
    await planRow.waitFor({ state: "detached", ...T });
    await row(page, `review:${tasks[1].id}`).getByRole("button", { name: "Looks good" }).tap();
    await row(page, `review:${tasks[1].id}`).waitFor({ state: "detached", ...T });
    for (const path of ["/api/coordinator/proposals/19/approve", `/api/tasks/${tasks[1].id}/evidence`]) if (!calls.includes(path)) throw new Error(`missing ${path}`);
  });

  planSize = PLAN_TASKS.length;
  const small = await browser.newContext({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const p2 = await small.newPage();
  await open(p2);
  await step("small phone: opening the inbox shows a long plan's actions before opening any session", async () => {
    await p2.getByRole("button", { name: /^Inbox,/ }).tap();
    await row(p2, "proposal:19").waitFor(T);
    await shot(p2, "4-small-phone");
    const first = p2.locator("[data-needs-you-id]").first();
    for (const name of ["Go ahead", "No thanks"]) {
      const box = await first.getByRole("button", { name }).boundingBox();
      if (!box || box.y + box.height > 664 || box.height < 44) throw new Error(`${name}: off screen or too small`);
    }
    for (const t of tasks) await tappable(p2, row(p2, `review:${t.id}`).getByRole("button", { name: "Looks good" }), t.title);
  });

  planSize = 3;
  const item = (id: number, kind: string, sessionId: string, text: string, meta: any = {}) => ({ id, sessionId, sessionName: null, kind, createdAt: now, title: text, text, outcome: null, status: "open", resolvedAt: null, resolution: null, resolutionNote: null, sourceKey: `k${id}`, historical: false, meta });
  attention = [
    item(901, "approval", "claude:mine", "Allow git push origin main", { answerKey: "claude-hook:a", tool: "Bash" }),
    item(902, "approval", "claude:w1", "Which cache?", { answerKey: "claude-hook:b", tool: "AskUserQuestion", questions: [{ question: "Which cache?", options: [{ label: "Redis" }, { label: "SQLite" }], multiSelect: false }] }),
    item(903, "question", "claude:mine", "The auto-mode classifier denied the call. Can you allow it so I can continue?"),
    item(904, "escalation", "coordinator", "Coordinator budget reached"),
    item(905, "finished", "claude:w3", "Coordinator-only completion"),
    item(906, "question", "claude:w3", "Shall I continue?", { autoPending: true }),
  ];
  coordinator.plans = [{ proposalId: 18, title: "Launch plan", tasks: [{ key: "worker", taskId: "launch-task", title: "Build the worker", state: "failed", error: "Terminal unavailable" }] }];
  const all = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const p3 = await all.newPage();
  p3.on("pageerror", (e) => errors.push(e.message));
  await open(p3);
  await p3.getByRole("button", { name: /^Inbox,/ }).tap();
  const needs = p3.getByRole("region", { name: "Needs you", exact: true });
  await step("phone: proposal, permission, question and failure cards keep their complete text and actions", async () => {
    const proposal = (coordinator.proposals as any[]).find((p) => p.id === 19);
    const permission = attention.find((i) => i.id === 901);
    const question = attention.find((i) => i.id === 903);
    const failed = coordinator.plans[0].tasks[0];
    const previousProposal = { ...proposal };
    const previousText = permission.text;
    const previousQuestion = question.text;
    const previousError = failed.error;
    try {
      Object.assign(proposal, { payload: { action: "route" }, text: longCardText });
      permission.text = longCardText;
      question.text = longCardText;
      failed.error = longCardText;
      push({ type: "coordinator", ...coordinator });
      push({ type: "attention", item: permission });
      push({ type: "attention", item: question });
      for (const [id, label, buttons] of [
        ["proposal:19", "Proposal details", ["Send", "No thanks"]],
        ["attention:901", "Permission details", ["Allow", "Deny", "See the session"]],
        ["attention:903", "Attention details", ["Reply", "See the session"]],
        ["launch:18:worker", "Task error", ["Retry"]],
      ] as const) {
        const detail = row(p3, id);
        await detail.locator("button[aria-expanded]").tap();
        await checkFullCard(p3, detail.locator(".needs-you-card"), label, [...buttons]);
        await detail.locator("button[aria-expanded]").tap();
      }
    } finally {
      Object.assign(proposal, previousProposal);
      permission.text = previousText;
      question.text = previousQuestion;
      failed.error = previousError;
      push({ type: "coordinator", ...coordinator });
      push({ type: "attention", item: permission });
      push({ type: "attention", item: question });
    }
  });
  await step("phone: all five item types appear in the inbox; coordinator-only work is excluded", async () => {
    await needs.getByLabel("10 items need you").waitFor(T);
    if (await p3.locator('[data-needs-you-id="attention:905"], [data-needs-you-id="attention:906"]').count()) throw new Error("coordinator-only work shown");
    for (const [id, name] of [["proposal:19", "Go ahead"], ["attention:901", "Allow"], ["attention:901", "Deny"], ["launch:18:worker", "Retry"], ["attention:903", "Reply"], [`review:${tasks[0].id}`, "Looks good"]]) await tappable(p3, row(p3, id).getByRole("button", { name, exact: true }), `${id} ${name}`);
    await p3.locator("#attention-inbox > .overflow-y-auto").evaluate((e) => e.scrollTop = 0);
    await shot(p3, "5-all-types");
  });
  await step("phone: Reply closes the inbox and focuses the session message box", async () => {
    await row(p3, "attention:903").getByRole("button", { name: "Reply", exact: true }).tap();
    await p3.getByRole("heading", { name: "my-session" }).waitFor(T);
    const box = p3.locator("textarea");
    if (!await box.evaluate((e) => e === document.activeElement)) throw new Error("Reply did not focus the session message box");
    if (await p3.getByRole("region", { name: "Needs you", exact: true }).count() !== 0) throw new Error("inbox list still shown in session");
    await shot(p3, "6-reply-focus");
    await box.fill("I approve the call. Please continue.");
    await p3.getByRole("button", { name: "Send", exact: true }).tap();
    await row(p3, "attention:903").waitFor({ state: "detached", ...T });
  });
  await step("phone: every action clears its item and updates the badge", async () => {
    await p3.getByRole("button", { name: /^Inbox,/ }).tap();
    await row(p3, "attention:903").waitFor({ state: "detached", ...T });
    for (const [id, name] of [["proposal:19", "Go ahead"], ["proposal:20", "No thanks"], ["launch:18:worker", "Retry"], ["attention:901", "Deny"], ["attention:904", "Got it"], ...tasks.map((t) => [`review:${t.id}`, "Looks good"])]) {
      const r = row(p3, id);
      await r.getByRole("button", { name, exact: true }).tap();
      await r.waitFor({ state: "detached", ...T });
    }
    await row(p3, "attention:902").getByRole("button", { name: "Answer", exact: true }).tap();
    await row(p3, "attention:902").getByRole("button", { name: "Redis", exact: true }).tap();
    await row(p3, "attention:902").waitFor({ state: "detached", ...T });
    await needs.getByLabel("0 items need you").waitFor(T);
    await needs.getByText("Nothing needs you right now.").waitFor(T);
    await shot(p3, "7-resolved");
  });
  await step("phone: reconnect removes items resolved while the page was disconnected", async () => {
    const i = item(910, "question", "claude:mine", "Please confirm the target.");
    attention.push(i);
    push({ type: "attention", item: i });
    await row(p3, "attention:910").waitFor(T);
    i.status = "resolved";
    push({ ...hello, attention: attention.filter((a) => a.status === "open") });
    await row(p3, "attention:910").waitFor({ state: "detached", ...T });
  });
  await step("phone: compact and expanded denial actions guard pending or uncertain replies; failed replies can retry", async () => {
    for (const [offset, replyState] of ["sending", "queued", "uncertain"].entries()) {
      const id = 920 + offset;
      const i = item(id, "approval", "claude:mine", "Bash: git status", {
        answerKey: `tool-denial:${id}`, deniedToolCall: { tool: "Bash", input: { command: "git status" } },
        denialReason: "Explicit approval required", replyState,
      });
      attention.push(i);
      push({ type: "attention", item: i });
      const card = row(p3, `attention:${id}`);
      await card.waitFor(T);
      await card.locator("button[aria-expanded]").tap();
      await card.getByText("Denied by the session: Explicit approval required", { exact: true }).waitFor(T);
      for (const name of ["Allow", "Deny"]) {
        const buttons = card.getByRole("button", { name, exact: true });
        if (await buttons.count() !== 2) throw new Error("expected compact and expanded actions");
        for (const button of await buttons.all()) if (!await button.isDisabled()) throw new Error(`${replyState}: ${name} allows a duplicate reply`);
      }
      i.meta.replyState = "failed";
      push({ type: "attention", item: i });
      await card.getByText("The reply was not delivered. You can try again.", { exact: true }).waitFor(T);
      await card.getByRole("button", { name: "Deny", exact: true }).first().tap();
      await card.waitFor({ state: "detached", ...T });
    }
    await needs.getByLabel("0 items need you").waitFor(T);
  });
  await step("phone: permission failure explains how to enable without hiding the list", async () => {
    await p3.getByRole("button", { name: "Enable notifications", exact: true }).tap();
    await needs.getByRole("alert").waitFor(T);
    await needs.getByLabel("0 items need you").waitFor(T);
  });
  await step("phone: no horizontal overflow at 390px or 320px; no page errors", async () => {
    for (const width of [390, 320]) {
      await p3.setViewportSize({ width, height: 664 });
      if (await p3.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`horizontal overflow at ${width}px`);
    }
    await shot(p3, "8-narrow-phone");
    if (errors.length) throw new Error(errors.join(" | "));
  });
  // Dedicated lifecycle checks run on phone and desktop with both providers, after the existing cards checks.
  refuseEnd = false;
  for (const width of [390, 1400]) {
    const life = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    const p = await life.newPage();
    await p.clock.install();
    await open(p);
    for (const provider of ["claude", "codex"] as const) {
      await step(`${width}px ${provider}: inferred End with visible refusal reasons, Undo, pane Resume and list Resume`, async () => {
        const id = `lifecycle-${provider}-${width}`;
        const s = session(id, id, { provider, pid: 123, pidConfidence: "inferred", sendMethods: ["terminal"], meta: { terminal: { name: "test-terminal" } } });
        sessions.push(s);
        push({ type: "session", session: s });
        const row = () => p.locator(`[data-session-id="${id}"]`);
        await row().click();
        const jump = p.getByRole("button", { name: "Jump to terminal", exact: true });
        if (width === 390) {
          if (await jump.count()) throw new Error("Jump to terminal is shown on a phone");
        } else await jump.waitFor(T);
        const headerEnd = p.getByRole("button", { name: "End", exact: true });
        await tappable(p, headerEnd, "header End");
        for (const reason of [
          `No ${provider} process in this folder has this session's transcript open; nothing was ended.`,
          `More than one ${provider} process has this session's transcript open; nothing was ended.`,
        ]) {
          refuseEnd = true;
          endRefusal = reason;
          await headerEnd.click();
          const action = p.getByRole("group", { name: "Session action", exact: true }).last();
          const alert = action.getByRole("alert");
          await alert.waitFor(T);
          if (await alert.innerText() !== reason) throw new Error("missing process lookup refusal");
          if (await p.getByRole("button", { name: "Undo", exact: true }).count()) throw new Error("refused close was shown as ended");
          await action.getByRole("button", { name: "OK", exact: true }).click();
        }
        refuseEnd = false;
        const ending = `/api/sessions/${id}/end`, resuming = `/api/sessions/${id}/resume`;
        const before = calls.filter((x) => x === ending).length;
        await p.getByRole("button", { name: "End", exact: true }).click();
        await p.getByRole("button", { name: "Undo", exact: true }).waitFor(T);
        if (calls.filter((x) => x === ending).length !== before + 1) throw new Error("End needed more than one tap");
        if (await p.getByText("End this session? Its history stays.").count()) throw new Error("confirmation remains");
        await p.getByRole("button", { name: "Undo", exact: true }).click();
        await p.getByRole("button", { name: "End", exact: true }).waitFor(T);
        if (!calls.includes(resuming)) throw new Error("Undo did not resume");
        await p.getByRole("button", { name: "End", exact: true }).click();
        await p.getByRole("button", { name: "Undo", exact: true }).waitFor(T);
        await p.clock.fastForward(30_100);
        if (await p.getByRole("button", { name: "Undo", exact: true }).count()) throw new Error("Undo outlived 30 seconds");
        // The pane's Resume stays after Undo expires and fits next to the header status.
        await tappable(p, p.getByRole("button", { name: "Resume", exact: true }).filter({ visible: true }).last(), "header Resume");
        await p.getByRole("button", { name: "Resume", exact: true }).filter({ visible: true }).last().click();
        await p.getByRole("button", { name: "End", exact: true }).waitFor(T);
        await p.getByRole("button", { name: "End", exact: true }).click();
        await p.getByRole("button", { name: "Undo", exact: true }).waitFor(T);
        if (width === 390) await p.getByRole("button", { name: "Back to session list" }).click();
        const ended = p.getByRole("button", { name: /^Ended/ });
        if (await ended.getAttribute("aria-expanded") !== "true") await ended.click();
        const resume = row().locator("..").getByRole("button", { name: "Resume", exact: true });
        await tappable(p, resume, "list Resume");
        await resume.click();
        await p.getByRole("button", { name: "End", exact: true }).waitFor(T);
        if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("lifecycle controls overflow");
        if (width === 390) await p.getByRole("button", { name: "Back to session list" }).click();
      });
    }
    await life.close();
  }
  await step("Jump to terminal also stays hidden on a wide touch screen and a narrow mouse screen", async () => {
    for (const [width, hasTouch] of [[1400, true], [390, false]] as const) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch });
      try {
        const p = await ctx.newPage();
        await open(p);
        await p.locator('[data-session-id="lifecycle-codex-1400"]').click();
        await p.getByRole("button", { name: "End", exact: true }).waitFor(T);
        if (await p.getByRole("button", { name: "Jump to terminal", exact: true }).count()) throw new Error(`Jump to terminal shown at ${width}px, touch=${hasTouch}`);
      } finally { await ctx.close(); }
    }
  });
  await step("no page errors on any page", async () => {
    if (errors.length) throw new Error(errors.join(" | "));
  });

  await step("phone: What's happening groups, icon statuses, 44px taps and one-tap stop", () => happeningChecks(browser, 390));
} finally {
  await browser.close();
}
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
