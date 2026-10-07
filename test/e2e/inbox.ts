#!/usr/bin/env bun
// Compact entry point at desktop and phone widths, with mocked HTTP/WS and the compiled UI.
// No daemon or providers. Run after bun run build: bun test/e2e/inbox.ts
import { chromium, type Locator, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { blankSession } from "../../src/daemon/state.ts";
import { longCardText, checkFullCard } from "./card-content.ts";

const root = join(import.meta.dir, "../..");
const shots = join(root, ".sandbox/inbox");
mkdirSync(shots, { recursive: true });
const BASE = "https://inbox.test";
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };

async function fixture(page: Page) {
  const now = Date.now();
  const session = { ...blankSession("claude:worker", "claude", "tui", "worker"), name: "Inbox worker", cwd: "/sim/inbox", execution: "idle", firstPrompt: "Check inbox actions", startedAt: now, lastActivityAt: now };
  const coordinator = {
    agent: "external", mode: "active", lastToolCallAt: now, model: "opus", running: true, busy: false,
    budget: { day: "2026-10-07", spentUsd: 0, limitUsd: 10, inputTokens: 0, outputTokens: 0, exhausted: false },
    limits: { perSessionCooldownMs: 600_000, perSessionPerHour: 6, maxLaunched: 3, maxRelayHops: 4 },
    excluded: [], autopilot: [], launched: [], nextWakeAt: null, pendingEvents: 0, activity: [], proposals: [] as any[], plans: [], chat: [], needsVerification: [], screenLabel: "",
  };
  const coordination = { objectives: [], tasks: [] as any[], claims: [], conflicts: [] };
  const attention: any[] = [];
  let socket: { send: (s: string) => void } | undefined;
  const push = (value: unknown) => socket?.send(JSON.stringify(value));
  const calls: { path: string; body: any }[] = [];
  let refuseApproval = true;
  await page.route(`${BASE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/")) {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        calls.push({ path, body });
        if (path === "/api/coordinator/proposals/1/approve") {
          if (refuseApproval) { refuseApproval = false; return route.fulfill({ status: 409, json: { error: "Approval refused. Try again." } }); }
          coordinator.proposals[0].state = "approved";
          push({ type: "coordinator", ...coordinator });
        } else if (path === "/api/tasks/review/evidence") {
          coordination.tasks[0].status = "verified";
          push({ type: "coordination", ...coordination });
        } else if (path === "/api/attention/2/answer") {
          Object.assign(attention[0], { status: "resolved", resolution: "answered_ui", resolvedAt: now });
          push({ type: "attention", item: attention[0] });
        }
        return route.fulfill({ json: { ok: true } });
      }
      const json = path === "/api/ws-ticket" ? { ticket: "test" } : path === "/api/coordination" ? coordination : path === "/api/coordinator" ? coordinator : path === "/api/attention" ? attention : path === "/api/governor" ? { sessions: [], log: [] } : path === "/api/usage" ? { ts: now, claude: { available: false, windows: [] }, codex: { available: false, windows: [] } } : [];
      return route.fulfill({ json });
    }
    const file = Bun.file(join(root, "dist/web", path === "/" ? "index.html" : path));
    return route.fulfill({ body: Buffer.from(await file.arrayBuffer()), contentType: file.type });
  });
  await page.routeWebSocket(/\/api\/ws/, (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ type: "hello", sessions: [session], system: null, attention, groups: [], coordinatorAgent: "external" }));
  });
  await page.goto(BASE);
  return {
    calls,
    pending() {
      coordinator.proposals.push({ id: 1, createdAt: now, kind: "action", sessionId: null, taskId: null, title: "Approve the inbox plan", text: "", reason: "Requested in chat", heldBecause: "outside_authority", state: "pending", resolvedAt: null, detail: null, digest: "inbox-plan-digest", payload: { action: "plan", title: "Approve the inbox plan", root: "/sim/inbox", resources: [], tasks: [] } });
      coordination.tasks.push({ id: "review", objectiveId: "objective", title: "Review the inbox result", description: "", owner: session.id, scope: { paths: [], resources: [] }, priority: "normal", tier: "standard", tierReason: null, prerequisites: [], acceptance: ["Layout works"], status: "finished_unverified", result: longCardText, evidence: [], verifiedEvidence: [], worktree: null, createdAt: now, updatedAt: now });
      attention.push({ id: 2, sessionId: session.id, kind: "approval", status: "open", title: "Allow the command", text: "Run the requested command", meta: { answerKey: "hook:inbox", tool: "Bash" }, createdAt: now });
      push({ type: "coordinator", ...coordinator });
      push({ type: "coordination", ...coordination });
      push({ type: "attention", item: attention[0] });
    },
  };
}

const browser = await chromium.launch({ channel: "chrome", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const tap = (target: Locator) => width === 390 ? target.tap() : target.click();
    const f = await fixture(page);
    const icon = page.getByRole("button", { name: /^Inbox,/ });
    const inbox = page.getByRole("complementary", { name: "Attention inbox" });
    const closed = async (count: number) => {
      await page.getByRole("button", { name: `Inbox, ${count} ${count === 1 ? "item needs" : "items need"} you`, exact: true }).waitFor();
      check(await icon.getAttribute("aria-expanded") === "false", "inbox unexpectedly expanded");
      check(await inbox.count() === 0 && await page.locator("#needs-you, [data-needs-you-id]").count() === 0, "persistent inbox/bar with inbox closed");
      check(await page.getByText("Nothing needs you right now.").count() === 0 && await page.getByRole("button", { name: "Enable notifications", exact: true }).count() === 0, "persistent empty or notification bar");
      const iconBox = (await icon.boundingBox())!;
      check(iconBox.width >= 44 && iconBox.width <= 72 && iconBox.height === 44, `icon is not a compact touch target: ${JSON.stringify(iconBox)}`);
      const headerBox = (await page.getByRole("banner").boundingBox())!;
      const workspace = (await page.getByRole("main").boundingBox())!;
      check(Math.abs(workspace.y - headerBox.y - headerBox.height) <= 1, "a bar occupies space between header and workspace");
      check(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), "page overflows horizontally");
      await page.screenshot({ path: join(shots, `${width}-closed-${count}.png`) });
    };
    await closed(0);
    await tap(icon);
    await inbox.getByText("Nothing needs you right now.").waitFor();
    await inbox.getByRole("button", { name: "Enable notifications", exact: true }).waitFor();
    await tap(page.getByRole("button", { name: "Close inbox" }));
    f.pending();
    await closed(3); // WS updates the badge without opening a persistent bar.
    check((await icon.innerText()).includes("3"), "pending count is not visible on the icon");
    await tap(icon);
    check(await icon.getAttribute("aria-expanded") === "true", "expanded state missing");
    check(await icon.getAttribute("aria-controls") === await inbox.getAttribute("id"), "icon does not identify the inbox");
    const pending = inbox.locator("[data-needs-you-id]");
    await pending.nth(2).waitFor();
    check(await pending.count() === 3, "full actionable list missing");
    const row = (id: string) => inbox.locator(`[data-needs-you-id="${id}"]`);
    for (const [id, names] of [["proposal:1", ["Go ahead", "No thanks"]], ["review:review", ["Looks good"]], ["attention:2", ["Allow", "Deny"]]] as const) {
      for (const name of names) await row(id).getByRole("button", { name, exact: true }).click({ trial: true });
    }
    await tap(row("review:review").locator("button[aria-expanded]"));
    await checkFullCard(page, row("review:review").locator(".needs-you-card"), "Task result", ["Looks good", "Not yet…", "See the session"]);
    await page.screenshot({ path: join(shots, `${width}-review.png`) });
    await tap(row("review:review").locator("button[aria-expanded]"));
    await tap(page.getByRole("button", { name: "Close inbox" }));
    await closed(3);
    await page.reload();
    await closed(3); // Pending items do not reopen the inbox after refresh.
    await tap(icon);
    await tap(row("proposal:1").getByRole("button", { name: "Go ahead", exact: true }));
    await row("proposal:1").getByRole("alert").getByText("Approval refused. Try again.").waitFor();
    await tap(row("proposal:1").getByRole("button", { name: "Go ahead", exact: true }));
    await row("proposal:1").waitFor({ state: "detached" });
    check(f.calls.filter((c) => c.path.endsWith("/approve")).every((c) => c.body.digest === "inbox-plan-digest"), "approval digest changed");
    await tap(row("review:review").getByRole("button", { name: "Looks good", exact: true }));
    await row("review:review").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Inbox, 1 item needs you", exact: true }).waitFor();
    await tap(row("attention:2").getByRole("button", { name: "Allow", exact: true }));
    await row("attention:2").waitFor({ state: "detached" });
    check(f.calls.some((c) => c.path.endsWith("/answer") && c.body.decision === "accept"), "permission decision not sent");
    check(f.calls.some((c) => c.path.endsWith("/evidence")), "review not submitted");
    await inbox.getByText("Nothing needs you right now.").waitFor();
    await tap(inbox.getByRole("button", { name: /Recently resolved/ }));
    await inbox.getByText("Allow the command", { exact: true }).waitFor();
    await tap(page.getByRole("button", { name: "Close inbox" }));
    await closed(0);
    // The same entry point is available in a worker session, without a pinned empty state.
    await tap(page.locator('[data-session-id="claude:worker"]'));
    await page.getByRole("heading", { name: "Inbox worker", exact: true }).waitFor();
    await closed(0);
    await icon.focus();
    await page.keyboard.press("i");
    await inbox.waitFor();
    await page.keyboard.press("Escape");
    await closed(0);
    check(errors.length === 0, errors.join(" | "));
    await context.close();
    console.log(`PASS compact inbox at ${width}px: empty/pending layout, accessible touch target, live counts, refresh, full actions, error/retry, history, session and keyboard navigation`);
  }
} finally { await browser.close(); }
