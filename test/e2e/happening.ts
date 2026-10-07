// Deterministic panel checks and screenshots. Serves the compiled UI through browser routes;
// no daemon, providers, or live data. Also called by e2e and e2e:phone.
import { chromium, type Browser, type Page } from "playwright-core";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { blankSession } from "../../src/daemon/state.ts";
import type { Objective, Task } from "../../src/shared/types.ts";

const root = join(import.meta.dir, "../..");
const dist = join(root, "dist/web");
const shots = join(root, ".sandbox/happening");
const BASE = "https://happening.test";
const now = Date.now();
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };

async function fixture(page: Page) {
  const session = (id: string, provider: "claude" | "codex", execution: "working" | "waiting_answer" | "idle") => ({
    ...blankSession(id, provider, "tui", id), name: id, cwd: "/home/u/Dev/switchboard", execution,
    firstPrompt: "Implement the coordinator improvements", startedAt: now - 3600_000,
    turnStartedAt: now - 12 * 60_000, lastActivityAt: now, meta: { background: "worker" },
  });
  const sessions = [session("claude:review", "claude", "waiting_answer"), session("codex:panel", "codex", "working"), session("claude:memory", "claude", "working"), session("codex:stale", "codex", "idle")];
  const objective = (id: string, title: string): Objective => ({
    id, title, description: "", status: "active", priority: "normal", createdAt: now - 6 * 3600_000, updatedAt: now,
    grant: { id: `g-${id}`, root: "/home/u/Dev/switchboard", rootId: "1:2", resources: [], verification: [], issuedBy: "human", issuedAt: now, revokedAt: null, provenance: "Approved in chat" },
  });
  const objectives = [
    objective("wallet", "Wallet identity and session ownership"),
    objective("panel", "Redesign What's happening for phone"),
    objective("round2", "Round 2: Claude review of coordinator changes"),
    objective("review", "Review the coordinator permission policy"),
    objective("taps", "Implement the fewer-taps approval flow"),
    objective("memory", "Add Coordinator memory to Settings"),
    objective("coordinator", "Codex coordinator follow-up"),
    objective("done", "Improve usage chip readability"),
  ];
  const task = (id: string, objectiveId: string, title: string, status: Task["status"], owner: string | null = null): Task => ({
    id, objectiveId, title, status, owner, description: "", scope: { paths: [], resources: [] }, priority: "normal", tier: "standard", tierReason: null, prerequisites: [], acceptance: [], result: null, evidence: [], worktree: null, createdAt: now - 3600_000, updatedAt: now,
  });
  const tasks = [
    task("wallet-task", "wallet", "Connect wallet identity to the correct worker session", "unassigned"),
    task("panel-task", "panel", "Build compact objective cards with clear worker status", "in_progress", "codex:panel"),
    task("panel-tests", "panel", "Check the phone layout after the new cards are ready", "blocked"),
    task("round-task", "round2", "Round 2: Claude review of the coordinator and task routing", "unassigned"),
    task("review-task", "review", "Confirm when a worker should ask before continuing", "in_progress", "claude:review"),
    task("taps-task", "taps", "Implement the fewer-taps approval flow on phones", "unassigned"),
    task("memory-task", "memory", "Add a readable memory section in coordinator settings", "in_progress", "claude:memory"),
    task("coordinator-task", "coordinator", "Resume the Codex coordinator follow-up", "in_progress", "codex:stale"),
    task("done-task", "done", "Keep both provider limits readable on a phone", "verified"),
  ];
  tasks[2].description = "Check every expanded task description, including long unbroken identifiers: " + "task_identifier_".repeat(12);
  tasks[2].prerequisites = ["panel-task", "missing-task"];
  tasks[2].acceptance = ["No horizontal overflow at 390px", "All task actions remain reachable"];
  tasks[2].recommendation = { provider: "codex", tier: "standard", model: "gpt-6.1-sol", effort: "high", queued: false,
    reason: "Claude: usage stale after HTTP 429; Codex: fresh comparable usage", at: now - 120_000,
    baseTier: "standard", baseReason: "Standard work", tierSelected: false, providerSelected: false };
  tasks[2].feedback = [{ at: now, by: "human", note: "Keep the complete task text readable." }];
  const coordination = { objectives, tasks, claims: [], conflicts: [] };
  const coordinator = {
    agent: "external", mode: "active", lastToolCallAt: now, model: "opus", running: true, busy: false,
    budget: { day: "2026-10-07", spentUsd: 0, limitUsd: 10, inputTokens: 0, outputTokens: 0, exhausted: false },
    limits: { perSessionCooldownMs: 600_000, perSessionPerHour: 6, maxLaunched: 3, maxRelayHops: 4 },
    excluded: [], autopilot: [], launched: [], nextWakeAt: null, pendingEvents: 0, activity: [], proposals: [], plans: [] as unknown[], chat: [], needsVerification: [], screenLabel: "",
  };
  const usage = { ts: now, ...Object.fromEntries(["claude", "codex"].map((p) => [p, { available: true, source: "test", asOf: now, windows: [{ label: "7d", remainingPct: p === "claude" ? 67 : 82, usedPct: p === "claude" ? 33 : 18, resetsAt: now + 86400_000 }, { label: "5h", remainingPct: 90, usedPct: 10, resetsAt: now + 3600_000 }] }])) };
  let socket: { send: (s: string) => void } | undefined;
  const push = (value: unknown) => socket?.send(JSON.stringify(value));
  const calls: string[] = [];
  let refuseStop = false;
  await page.route(`${BASE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/")) {
      if (path === "/api/ws-ticket") return route.fulfill({ json: { ticket: "test" } });
      if (route.request().method() === "POST") {
        calls.push(path);
        const revoke = path.match(/^\/api\/objectives\/([^/]+)\/revoke$/);
        if (revoke) {
          if (refuseStop) return route.fulfill({ status: 409, json: { error: "Could not stop this objective. Try again." } });
          objectives.find((o) => o.id === revoke[1])!.grant!.revokedAt = now;
          push({ type: "coordination", ...coordination });
        }
        return route.fulfill({ json: { ok: true } });
      }
      const json = path === "/api/ws-ticket" ? { ticket: "test" } : path === "/api/coordination" ? coordination : path === "/api/coordinator" ? coordinator : path === "/api/usage" ? usage : path === "/api/governor" ? { gameMode: false, gameManual: null, sessions: [], log: [] } : path === "/api/system" ? null : [];
      return route.fulfill({ json });
    }
    const file = join(dist, path === "/" ? "index.html" : path);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ body: readFileSync(file), contentType: ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
  });
  await page.routeWebSocket(/\/api\/ws/, (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ type: "hello", sessions, system: null, attention: [], groups: [], coordinatorAgent: "external" }));
  });
  await page.goto(BASE);
  await page.locator('[data-session-id="coordinator"]').click();
  return { sessions, tasks, objectives, coordination, coordinator, push, calls, refuseStop: (value: boolean) => { refuseStop = value; } };
}

export async function happeningChecks(browser: Browser, width: number, before = false) {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1000 }, isMobile: width < 600, hasTouch: width < 600, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  mkdirSync(shots, { recursive: true });
  try {
    const f = await fixture(page);
    const panel = page.getByRole("region", { name: "What's happening", exact: true });
    if (!before) {
      if (width < 1024) await page.getByRole("button", { name: "Back to session list" }).click();
      await page.getByRole("button", { name: /^Background agents/ }).click();
      await page.locator('[data-session-id="codex:panel"]').getByRole("img", { name: "Codex", exact: true }).waitFor();
      await page.locator('[data-session-id="claude:memory"]').getByRole("img", { name: "Claude", exact: true }).waitFor();
      await page.screenshot({ path: join(shots, `after-${width}-sessions.png`) });
      await page.locator('[data-session-id="coordinator"]').click();
    }
    if (!before && width < 1280) await page.getByRole("button", { name: "What's happening", exact: true }).click();
    if (width >= 1280 || !before) await panel.waitFor();
    if (!before) await panel.getByRole("button", { name: "2 running", exact: true }).waitFor();
    await page.screenshot({ path: join(shots, `${before ? "before" : "after"}-${width}.png`) });
    if (before) return;
    const card = (id: string) => panel.locator(`[data-objective-id="${id}"]`);
    const row = (id: string) => panel.locator(`[data-task-id="${id}"]`);
    const toggle = (id: string) => card(id).locator(".happening-objective-toggle");
    const counts = panel.getByRole("navigation", { name: "Objective counts" });
    const needs = panel.getByRole("region", { name: "Objectives needing you" });
    const running = panel.getByRole("region", { name: "Running objectives" });
    const queued = panel.getByRole("region", { name: "Queued objectives" });
    await counts.getByRole("button", { name: "2 running", exact: true }).waitFor();
    await counts.getByRole("button", { name: "1 needs you", exact: true }).waitFor();
    await counts.getByRole("button", { name: "4 queued", exact: true }).waitFor();
    check(await needs.locator('[data-objective-id="review"]').count() === 1, "decision objective is not in Needs you");
    await panel.getByRole("button", { name: "Review decisions", exact: true }).click();
    check(await page.getByRole("region", { name: "Needs you", exact: true }).evaluate((el) => el === document.activeElement), "Review decisions must focus the inbox decision list");
    check(await page.getByRole("complementary", { name: "Attention inbox" }).count() === 1, "Review decisions did not open the inbox");
    await page.getByRole("button", { name: "Close inbox" }).click();
    check(await running.locator("[data-objective-id]").count() === 2, "running group should only contain active workers");
    check(await queued.locator('[data-objective-id="coordinator"]').count() === 1, "stale in_progress task is not queued");
    check(await toggle("wallet").getAttribute("aria-expanded") === "false", "queued objective must start collapsed");
    check(await card("wallet").isVisible() && !await row("wallet-task").count(), "queued objective should be one visible header");
    check(await row("panel-task").isVisible() && !await row("panel-tests").count(), "only running rows should be visible by default");
    check(!await row("review-task").count(), "non-executing review task should start collapsed");
    await card("review").getByText("1 needs you", { exact: true }).waitFor();
    await card("panel").getByText("1 running · 1 blocked", { exact: true }).waitFor();
    check(await card("review").evaluate((el) => el.getBoundingClientRect().height) < 110, "non-running objective is too tall");
    const detailsId = await toggle("panel").getAttribute("aria-controls");
    check(!!detailsId && await panel.locator(`[id="${detailsId}"]`).count() === 1, "disclosure must control its task list");
    await panel.getByRole("button", { name: "Show finished (1)", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, `after-${width}-collapsed.png`) });
    const order = await panel.locator(".happening-group").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    check(order.join("|") === "Objectives needing you|Running objectives|Queued objectives", "section order is wrong");
    check(!await panel.getByText(/\d+\/\d+ done/).count(), "old progress text is still shown");
    check(!await panel.getByRole("button", { name: "Stop", exact: true }).count(), "Stop should be inside overflow");

    // Native button keyboard semantics, explicit aria-expanded and complete task details.
    await toggle("panel").focus();
    await page.keyboard.press("Enter");
    check(await toggle("panel").getAttribute("aria-expanded") === "true", "Enter did not expand tasks");
    await row("panel-tests").getByText(f.tasks[2].description, { exact: true }).waitFor();
    await row("panel-tests").getByText("No horizontal overflow at 390px", { exact: true }).waitFor();
    const recommendation = row("panel-tests").getByLabel("Worker choice reason");
    await recommendation.getByText(f.tasks[2].recommendation!.reason, { exact: true }).waitFor();
    check((await recommendation.innerText()).includes("usage may have changed"), "expanded compact task lost recommendation freshness");
    await row("panel-tests").getByText("missing-task (Unavailable)", { exact: true }).waitFor();
    await row("panel-tests").getByText(`${f.tasks[1].title} (Running)`, { exact: true }).waitFor();
    await row("panel-task").getByRole("button", { name: "Worker: codex:panel", exact: true }).waitFor();
    await row("panel-tests").locator("summary").click();
    await row("panel-tests").getByText("Keep the complete task text readable.", { exact: true }).waitFor();
    await row("panel-tests").locator("summary").click();
    await toggle("panel").focus();
    await page.keyboard.press("Space");
    check(await toggle("panel").getAttribute("aria-expanded") === "false" && !await row("panel-tests").count(), "Space did not collapse tasks");
    await toggle("panel").click();
    await toggle("review").click();
    await row("review-task").getByRole("button", { name: "Review decisions", exact: true }).click();
    check(await page.getByRole("region", { name: "Needs you", exact: true }).evaluate((el) => el === document.activeElement), "expanded task must retain its decision route");
    await page.getByRole("button", { name: "Close inbox", exact: true }).click();

    // Status shapes and colours, full accessible labels, and shared provider logos.
    await row("panel-task").getByRole("img", { name: "Codex" }).waitFor();
    await row("memory-task").getByRole("img", { name: "Claude" }).waitFor();
    const chip = page.getByRole("button", { name: "Claude and Codex usage limits" });
    for (const [name, sessionId, taskId] of [["Claude", "claude:memory", "memory-task"], ["Codex", "codex:panel", "panel-task"]]) {
      const icons = [chip.getByRole("img", { name, exact: true }), row(taskId).getByRole("img", { name, exact: true }), page.locator(`[data-session-id="${sessionId}"] svg[aria-label="${name}"]`)];
      const paths = await Promise.all(icons.map((icon) => icon.locator("path").getAttribute("d")));
      check(paths[0] && paths.every((p) => p === paths[0]), `${name} doesn't share the same brand artwork everywhere`);
      for (const icon of icons) {
        check(await icon.getAttribute("fill") === (name === "Claude" ? "#D97757" : "currentColor"), `${name} brand colour is wrong`);
        check(!await icon.locator("image, use").count(), `${name} should be inline with no external asset dependency`);
      }
    }
    check(/\d+m \d+s/.test(await row("panel-task").innerText()), "running row lacks elapsed time");
    for (const id of ["panel-task", "memory-task", "panel-tests", "review-task"]) {
      const text = await row(id).locator(".happening-task-content").innerText();
      check(!/Running|In progress|Waiting on other work|Not started|Needs you/.test(text), `status words take up row width: ${text}`);
    }
    const colours = await Promise.all(["panel-task", "review-task", "panel-tests"].map((id) => row(id).locator(".happening-status").evaluate((el) => getComputedStyle(el).color)));
    check(new Set(colours).size === 3, "running, needs and waiting icons must have distinct colours");
    const progressColours = await card("panel").locator(".happening-segment").evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
    check(progressColours[0] === colours[0] && progressColours[1] === colours[2], "progress segments don't use task colours");
    check(await row("panel-tests").locator(".happening-status svg path").count() === 1, "waiting lacks its chain glyph");
    check(await row("review-task").locator(".happening-status svg").count() === 1, "needs-you lacks its question icon");
    const status = row("panel-tests").getByRole("button", { name: "Status: Waiting on other work", exact: true });
    await status.click();
    await row("panel-tests").getByRole("tooltip").getByText("Waiting on other work").waitFor();
    await page.screenshot({ path: join(shots, `after-${width}-status.png`) });
    await page.keyboard.press("Escape");
    check(!await panel.getByRole("tooltip").count(), "Escape didn't dismiss the status popover");
    await panel.locator(".happening-legend summary").click();
    for (const label of ["Running", "Needs you", "Waiting on other work", "Worker idle", "Not started", "Failed", "Done"]) await panel.locator(".happening-legend").getByText(label, { exact: true }).waitFor();
    await page.screenshot({ path: join(shots, `after-${width}-legend.png`) });
    await panel.locator(".happening-legend summary").click();

    // Live timing, reduced motion, and two-line titles rather than a shrinking single line.
    const time = row("panel-task").getByLabel("Elapsed time", { exact: true });
    const timeBefore = await time.innerText();
    await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent !== text, { selector: '[data-task-id="panel-task"] [aria-label="Elapsed time"]', text: timeBefore });
    check(await row("panel-task").locator(".happening-pulse").evaluate((el) => getComputedStyle(el).animationName) === "happening-pulse", "running dot should pulse");
    await page.emulateMedia({ reducedMotion: "reduce" });
    check(await row("panel-task").locator(".happening-pulse").evaluate((el) => getComputedStyle(el).animationName) === "none", "reduced motion should disable the pulse");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const titles = await panel.locator(".happening-title").evaluateAll((els) => els.map((el) => {
      const style = getComputedStyle(el);
      return { expanded: !!el.closest(".happening-details-open"), clamp: style.webkitLineClamp, height: el.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight) };
    }));
    check(titles.every((t) => t.expanded ? t.clamp === "none" : t.clamp === "2" && t.height <= 2 * t.lineHeight + 1), "expanded titles must be complete; summaries may wrap to two lines");
    check(titles.some((t) => t.height > t.lineHeight + 1), "fixture should exercise actual title wrapping");
    const controls = await panel.locator("button:visible, summary:visible").evaluateAll((els) => els.map((el) => ({ label: el.getAttribute("aria-label") ?? el.textContent, height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width })));
    check(controls.every((r) => r.height >= 44 && r.width >= 44), `small tap targets: ${JSON.stringify(controls.filter((r) => r.height < 44 || r.width < 44))}`);
    check(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), "page overflows sideways");
    const overflow = await panel.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, outside: [...el.querySelectorAll("*")].filter((child) => child.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).map((child) => `${child.tagName}.${child.className}`) }));
    check(overflow.scroll <= overflow.client, `panel overflows sideways: ${JSON.stringify(overflow)}`);

    // Count links focus their section; queued cards each expose their own details.
    await counts.getByRole("button", { name: "4 queued", exact: true }).click();
    await card("wallet").waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Queued objectives");
    await toggle("wallet").click();
    await toggle("coordinator").click();
    await row("wallet-task").getByRole("button", { name: "Status: Not started", exact: true }).waitFor();
    await row("coordinator-task").getByRole("button", { name: "Status: Worker idle", exact: true }).waitFor();
    await page.screenshot({ path: join(shots, `after-${width}-queued.png`) });
    await toggle("wallet").click();
    await toggle("coordinator").click();
    for (const [name, group] of [["2 running", running], ["1 needs you", needs]] as const) {
      await counts.getByRole("button", { name, exact: true }).click();
      await page.waitForFunction((label) => document.activeElement?.getAttribute("aria-label") === label, await group.getAttribute("aria-label"));
    }
    await panel.getByRole("button", { name: "Show finished (1)", exact: true }).click();
    await row("done-task").getByRole("button", { name: "Status: Done", exact: true }).waitFor();
    check(await row("done-task").locator(".happening-done svg").count() === 1, "done should have a green check");
    await panel.getByRole("button", { name: "Hide finished", exact: true }).click();

    // Mixed work shares a single disclosure, including finished rows only when requested.
    const originalLength = f.tasks.length;
    const extra = (id: string, status: Task["status"], owner: string | null = null): Task => ({ ...f.tasks[0], id, title: `Panel ${id}`, objectiveId: "panel", status, owner });
    f.tasks.push(extra("panel-idle", "in_progress", "codex:stale"), extra("panel-queued", "unassigned"), extra("panel-review", "finished_unverified"), extra("panel-done", "verified"));
    await toggle("panel").click();
    f.push({ type: "coordination", ...f.coordination });
    await needs.locator('[data-objective-id="panel"]').waitFor();
    await card("panel").getByText("1 running · 1 needs you · 1 blocked · 1 idle · 1 queued", { exact: true }).waitFor();
    check(await toggle("panel").getAttribute("aria-expanded") === "false", "regrouping reset the collapsed choice");
    check(await card("panel").locator("[data-task-id]").count() === 1, "mixed card should show only its running task");
    check((await toggle("panel").getAttribute("aria-label"))?.includes("4 other tasks"), "non-running count is wrong");
    await page.screenshot({ path: join(shots, `after-${width}-mixed-collapsed.png`) });
    await toggle("panel").click();
    check(await card("panel").locator("[data-task-id]").count() === 5, "expansion lost or duplicated mixed tasks");
    await row("panel-review").getByRole("button", { name: "Review decisions", exact: true }).click();
    check(await page.getByRole("region", { name: "Needs you", exact: true }).evaluate((el) => el === document.activeElement), "unowned review lost its action route");
    await page.getByRole("button", { name: "Close inbox", exact: true }).click();
    await panel.getByRole("button", { name: "Show finished (2)", exact: true }).click();
    await row("panel-done").getByRole("button", { name: "Status: Done", exact: true }).waitFor();
    check(await card("panel").locator("[data-task-id]").count() === 6, "shown completed subtask is missing or duplicated");
    await toggle("panel").click();
    check(!await row("panel-done").count(), "completed subtask escaped the disclosure");
    await panel.getByRole("button", { name: "Hide finished", exact: true }).click();
    check(await toggle("panel").getAttribute("aria-expanded") === "false", "finished toggle reset expansion");
    await toggle("panel").click();
    f.sessions[1].execution = "idle";
    f.push({ type: "session", session: f.sessions[1] });
    await row("panel-task").getByRole("button", { name: "Status: Worker idle", exact: true }).waitFor();
    check(await toggle("panel").getAttribute("aria-expanded") === "true" && await card("panel").locator("[data-task-id]").count() === 5, "idle transition reset expansion or duplicated rows");
    await toggle("panel").click();
    check(await card("panel").locator("[data-task-id]").count() === 0, "all non-running objective should be header only");
    await card("panel").getByText("1 needs you · 1 blocked · 2 idle · 1 queued", { exact: true }).waitFor();
    await page.screenshot({ path: join(shots, `after-${width}-all-non-running.png`) });
    f.sessions[1].execution = "working";
    f.push({ type: "session", session: f.sessions[1] });
    await row("panel-task").waitFor();
    check(await toggle("panel").getAttribute("aria-expanded") === "false" && await card("panel").locator("[data-task-id]").count() === 1, "working transition lost its row or collapsed choice");
    f.tasks.splice(originalLength);
    f.push({ type: "coordination", ...f.coordination });
    await running.locator('[data-objective-id="panel"]').waitFor();
    check(await toggle("panel").getAttribute("aria-expanded") === "false", "moving out of Needs you reset expansion");
    await toggle("panel").click();
    f.sessions[1].execution = "idle";
    f.push({ type: "session", session: f.sessions[1] });
    await queued.locator('[data-objective-id="panel"]').waitFor();
    check(await toggle("panel").getAttribute("aria-expanded") === "true" && await row("panel-tests").isVisible(), "moving to queued reset the expanded choice");
    f.sessions[1].execution = "working";
    f.push({ type: "session", session: f.sessions[1] });
    await running.locator('[data-objective-id="panel"]').waitFor();
    check(await toggle("panel").getAttribute("aria-expanded") === "true" && await card("panel").locator("[data-task-id]").count() === 2, "moving back to running lost or duplicated tasks");

    // Opening task content (not just a small status link) navigates to the exact worker.
    await row("panel-task").getByRole("button", { name: /Open worker session/ }).click();
    await page.waitForURL(/#\/s\/codex%3Apanel$/);
    if (width < 1024) await page.getByRole("button", { name: "Back to session list" }).click();
    await page.locator('[data-session-id="coordinator"]').click();
    if (width < 1280) await page.getByRole("button", { name: "What's happening", exact: true }).click();

    // Session and coordination pushes regroup work, including failures without a launched worker.
    f.sessions[1].execution = "idle";
    f.push({ type: "session", session: f.sessions[1] });
    await counts.getByRole("button", { name: "1 running", exact: true }).waitFor();
    await counts.getByRole("button", { name: "5 queued", exact: true }).waitFor();
    f.sessions[1].execution = "working";
    f.push({ type: "session", session: f.sessions[1] });
    await counts.getByRole("button", { name: "2 running", exact: true }).waitFor();
    f.coordinator.plans = [{ proposalId: 1, title: "Wallet identity", tasks: [{ key: "wallet", taskId: "wallet-task", title: f.tasks[0].title, state: "failed", error: "Worker could not start" }] }];
    f.push({ type: "coordinator", ...f.coordinator });
    await needs.locator('[data-objective-id="wallet"]').waitFor();
    await card("wallet").getByText("1 failed", { exact: true }).waitFor();
    await toggle("wallet").click();
    await row("wallet-task").getByRole("button", { name: "Status: Failed", exact: true }).waitFor();
    const failColour = await row("wallet-task").locator(".happening-status.happening-failed").evaluate((el) => getComputedStyle(el).color);
    check(!colours.includes(failColour), "failed should be a distinct red");
    f.coordinator.plans = [];
    f.push({ type: "coordinator", ...f.coordinator });
    const question = { id: 901, sessionId: "codex:panel", kind: "question", status: "open", title: "Choose a layout", text: "Use compact cards?", meta: {}, createdAt: now };
    f.push({ type: "attention", item: question });
    await needs.locator('[data-objective-id="panel"]').waitFor();
    check(await row("panel-task").isVisible(), "an open notice must not hide an actually executing task");
    f.push({ type: "attention", item: { ...question, status: "resolved" } });
    await running.locator('[data-objective-id="panel"]').waitFor();
    if (await toggle("panel").getAttribute("aria-expanded") !== "true") await toggle("panel").click();
    f.tasks[1].status = "finished_unverified";
    f.push({ type: "coordination", ...f.coordination });
    await needs.locator('[data-objective-id="panel"]').waitFor();
    await row("panel-task").getByRole("button", { name: "Status: Needs you: review completed work", exact: true }).waitFor();
    f.tasks[1].status = "in_progress";
    f.push({ type: "coordination", ...f.coordination });
    await running.locator('[data-objective-id="panel"]').waitFor();

    // Empty decision chrome disappears; the guide shares the heading's line.
    f.tasks[4].owner = null;
    f.tasks[4].status = "unassigned";
    f.push({ type: "coordination", ...f.coordination });
    await needs.waitFor({ state: "hidden" });
    check(!await counts.getByRole("button", { name: "0 needs you", exact: true }).count(), "empty needs counter wastes space");
    check(!await panel.getByText("Nothing waiting on you.").isVisible(), "empty needs section wastes space");
    const heading = await panel.locator(".happening-header").boundingBox();
    const guide = await panel.getByLabel("Status guide", { exact: true }).boundingBox();
    check(heading && guide && heading.height === 44 && guide.width === 44, "status guide should share the compact heading row");
    await panel.getByRole("heading", { name: "What's happening", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, `after-${width}-compact-header.png`) });

    // Stop is one tap inside overflow, with no confirmation and a visible error if refused.
    const actions = card("panel").getByLabel("Actions for Redesign What's happening for phone", { exact: true });
    const stop = card("panel").getByRole("button", { name: "Stop objective", exact: true });
    check(!await stop.isVisible(), "Stop should stay tucked inside the overflow menu");
    await actions.click();
    check(f.calls.length === 0, "opening overflow sent a stop request");
    await page.keyboard.press("Escape");
    check(!await stop.isVisible(), "Escape should close the menu without stopping");
    check(f.calls.length === 0, "dismissing overflow sent a stop request");
    await actions.click();
    await page.screenshot({ path: join(shots, `after-${width}-stop-menu.png`) });
    f.refuseStop(true);
    if (width < 600) await stop.tap(); else await stop.click();
    await card("panel").getByRole("alert").waitFor();
    check(f.calls.length === 1, "one tap should send exactly one stop request");
    check(!await page.getByRole("dialog").count(), "Stop must not open a confirmation");
    f.refuseStop(false);
    if (width < 600) await stop.tap(); else await stop.click();
    await card("panel").waitFor({ state: "detached" });
    check(!await page.getByRole("dialog").count(), "Stop must not ask for confirmation");
    await panel.getByRole("button", { name: "Show finished (2)", exact: true }).click();
    await card("panel").getByText("Stopped", { exact: true }).waitFor();
    await page.screenshot({ path: join(shots, `after-${width}-stopped.png`) });
    check(f.calls.length === 2 && f.calls.every((p) => p === "/api/objectives/panel/revoke"), "Stop revoked the wrong objective");
    check(errors.length === 0, errors.join(" | "));
  } finally {
    await context.close();
  }
}

if (import.meta.main) {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [390, 1440]) {
      await happeningChecks(browser, width, process.env.SB_HAPPENING_BEFORE === "1");
      console.log(`PASS What's happening at ${width}px`);
    }
  } finally { await browser.close(); }
}
