#!/usr/bin/env bun
// Compiled UI + real HTTP/SQLite authority service, with explicitly SIMULATED records.
// No daemon entrypoint, scanner, bridge, provider, model, notification or live data is used.
// Run after `bun run build`: bun test/e2e/authority.ts
import { chromium } from "playwright-core";
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../../src/daemon/db.ts";
import { Coordination } from "../../src/daemon/coordination.ts";
import { startHttp } from "../../src/daemon/http.ts";
import { CoordinatorAgent } from "../../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../../src/daemon/coordinator/config.ts";
import { memoryUI } from "./memory-ui.ts";
import { blankSession } from "../../src/daemon/state.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sb-authority-ui-")));
const project = join(root, "project");
mkdirSync(project);
const store = new Store(root);
const seed = new Coordination(store);
const worker = blankSession("codex:review-worker", "codex", "tui", "review-worker");
worker.execution = "idle";
const sessions = new Map([[worker.id, worker]]);
const feedbackSent: string[] = [];
let deliverFeedback = async () => {};
// A pre-upgrade objective/task: ungranted, with a historical (unsupported) verified claim.
const legacyObj = seed.createObjective("[SIMULATED] Legacy objective", "", undefined, "human");
const legacy = seed.createTask({ title: "[SIMULATED] Legacy verified", objectiveId: legacyObj.id, owner: worker.id, acceptance: ["Reviewed actual diff"] }, "human");
store.db
  .query("UPDATE tasks SET data=? WHERE id=?")
  .run(JSON.stringify({ ...legacy, status: "finished_unverified", historicalVerified: { at: 0, reason: "Legacy assertion" } }), legacy.id);
const c = new Coordination(store);
let push: (m: any) => void = () => {};
// A real coordinator agent with no model process: we call its tools directly, as its MCP proxy would.
const agent = new CoordinatorAgent({
  db: store.db,
  coordination: c,
  cfg: mergeCoordinatorConfig({}),
  sessions: () => sessions,
  events: () => [],
  send: async () => ({ ok: false, error: "no transport in this test" }),
  escalate: () => {},
  push: (st) => push({ type: "coordinator", ...st }),
  timers: false,
});
agent.setMode("active");
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port!;
probe.stop(true);
const token = randomBytes(32).toString("hex");
const { server, broadcast } = startHttp({
  port,
  token,
  coordinatorToken: randomBytes(32).toString("hex"),
  store,
  coordination: c,
  coordinator: agent,
  webDist: join(import.meta.dir, "../../dist/web"),
  system: () => null,
  registry: { sessions, list: () => [...sessions.values()], onPush: () => {} },
  messenger: { send: async ({ text }: { text: string }) => { feedbackSent.push(text); await deliverFeedback(); return { id: 1, state: "accepted" }; } },
  attention: { open: () => [] },
  perspectives: { list: () => [] },
  governor: { snapshot: () => ({ gameMode: false, gameManual: null, sessions: {}, log: [] }) },
  usage: { snapshot: () => ({ ts: Date.now(), claude: { available: false, windows: [] }, codex: { available: false, windows: [] } }) },
} as any);
push = broadcast;
c.onChange = () => broadcast({ type: "coordination", ...c.snapshot() });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let passed = 0;
const check = (name: string, ok: boolean) => {
  if (!ok) throw Error(name);
  passed++;
  console.log(`PASS ${name}`);
};
try {
  const base = `http://127.0.0.1:${port}`;
  const { url } = (await (
    await fetch(`${base}/api/login-code`, { method: "POST", headers: { authorization: `Bearer ${token}` } })
  ).json()) as { url: string };
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The coordinator proposes a project; it can't grant itself anything.
  const proposed: any = await agent.callTool("create_objective", { title: "[SIMULATED] Harden auth", root: project, reason: "the user asked for it" });
  check("the coordinator's project is only a proposal: no objective, no grant", proposed.ok && c.snapshot().objectives.length === 1);
  await page.goto(url);
  await page.getByRole("button", { name: /^Inbox,/ }).click();
  const needs = page.getByRole("region", { name: "Needs you" });
  const proposalSummary = needs.getByRole("button", { name: /Decide:/ });
  await proposalSummary.click();
  await needs.getByText(project, { exact: true }).waitFor();
  check("the proposal card shows the real folder from the request", true);
  await proposalSummary.click();
  await needs.getByRole("button", { name: "Go ahead", exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Go ahead"));
  const granted = c.snapshot().objectives.find((o) => o.title === "[SIMULATED] Harden auth");
  check("Go ahead creates the project with a human grant on that folder", granted?.grant?.issuedBy === "human" && granted.grant.root === project);
  await page.reload();
  const happening = page.getByRole("region", { name: "What's happening" });
  await happening.getByRole("heading").filter({ hasText: "[SIMULATED] Harden auth" }).waitFor();
  await page.getByRole("button", { name: /^Inbox,/ }).click();
  check("refresh shows the project, with no pending proposal", !(await needs.getByRole("button", { name: "Go ahead" }).count()));
  // Finished work (here: the legacy historical claim) needs the user's OK; one click verifies it.
  const card = needs.getByRole("button", { name: "Review: [SIMULATED] Legacy verified", exact: true });
  await card.waitFor();
  await card.click();
  await needs.getByRole("button", { name: "Not yet…", exact: true }).click();
  check("Not yet without a note still waits for feedback", await needs.getByRole("button", { name: "Send back", exact: true }).isDisabled() && c.task(legacy.id)?.status === "finished_unverified");
  await needs.getByRole("button", { name: "Cancel", exact: true }).click();
  await needs.getByRole("button", { name: "Not yet…", exact: true }).click();
  const note = "The header still overflows at 390px. Keep the buttons visible.";
  await needs.getByPlaceholder("What's missing?").fill(note);
  let releaseFeedback!: () => void;
  deliverFeedback = () => new Promise<void>(resolve => { releaseFeedback = resolve; });
  const sentBack = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${legacy.id}/feedback`));
  await needs.getByRole("button", { name: "Send back", exact: true }).click();
  // The response cannot finish until delivery does; WS must clear the card already.
  await card.waitFor({ state: "detached", timeout: 5000 });
  check("feedback clears the card before worker delivery finishes", c.task(legacy.id)?.status === "in_progress" && feedbackSent.length === 1 && feedbackSent[0].includes(note));
  releaseFeedback();
  check("feedback request succeeds after worker delivery", (await sentBack).ok());
  await page.reload();
  await page.getByRole("button", { name: /^Inbox,/ }).click();
  check("the review card stays gone across reload", await card.count() === 0);
  await page.getByRole("button", { name: "Close inbox" }).click();
  const history = page.getByRole("region", { name: "What's happening" });
  await history.getByRole("button", { name: /^Expand \[SIMULATED\] Legacy objective/ }).click();
  await history.getByText("Task history", { exact: true }).click();
  await history.getByText(note, { exact: true }).waitFor();
  check("task history shows the saved feedback", c.task(legacy.id)?.feedback?.[0]?.note === note);
  await page.getByRole("button", { name: /^Inbox,/ }).click();
  c.updateTask(legacy.id, { status: "finished_unverified", result: "Fixed the phone layout" }, "human");
  await card.waitFor();
  check("the card returns when the task is finished again", true);
  // Sending it back again after the worker ends still clears the review immediately.
  worker.execution = "ended";
  await card.click();
  await needs.getByRole("button", { name: "Not yet…", exact: true }).click();
  await needs.getByPlaceholder("What's missing?").fill("One button is still clipped.");
  await needs.getByRole("button", { name: "Send back", exact: true }).click();
  await card.waitFor({ state: "detached" });
  check("an ended worker still clears the card and retains both review notes", c.task(legacy.id)?.status === "in_progress" && c.task(legacy.id)?.feedback?.length === 2 && feedbackSent.length === 1);
  c.updateTask(legacy.id, { status: "finished_unverified" }, "human");
  await card.waitFor();
  await needs.getByRole("button", { name: "Looks good", exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Looks good"));
  check("Looks good records the user's verification", c.isVerified(c.task(legacy.id)!) && !c.task(legacy.id)?.historicalVerified);
  await page.getByRole("button", { name: "Close inbox" }).click();
  // Stop revokes the grant and survives a refresh.
  await happening.getByLabel("Actions for [SIMULATED] Harden auth", { exact: true }).click();
  await happening.getByRole("button", { name: "Stop objective", exact: true }).click();
  check("Stop acts directly from the overflow menu without a confirmation", !(await page.getByRole("dialog").count()));
  await happening.getByRole("button", { name: /Show finished/ }).click();
  await happening.getByText("Stopped", { exact: true }).waitFor();
  await page.reload();
  await happening.getByRole("button", { name: /Show finished/ }).click();
  await happening.getByText("Stopped", { exact: true }).waitFor();
  check("Stop revokes the project's grant, across refresh", !!c.objective(granted!.id)?.grant?.revokedAt);
  // A delegation plan (D32): one card with the folder and who does each task; No thanks creates nothing.
  const before = c.snapshot().tasks.length;
  const planned: any = await agent.callTool("propose_plan", {
    title: "[SIMULATED] Add rate limiting",
    root: project,
    reason: "the user asked for it",
    tasks: [
      { key: "design", title: "[SIMULATED] Design the limiter", brief: "Decide the algorithm and limits for login.", acceptance: ["design doc"], provider: "claude", tier: "deep", tierReason: "security-sensitive", paths: ["docs"] },
      { key: "impl", title: "[SIMULATED] Implement the limiter", brief: "Implement the agreed limiter in src/limit.ts.", acceptance: ["tests pass"], provider: "codex", tier: "standard", prerequisites: ["design"], paths: ["src"] },
    ],
  });
  check("propose_plan queues one card and creates nothing", planned.ok && c.snapshot().tasks.length === before);
  await page.getByRole("button", { name: /^Inbox,/ }).click();
  const planSummary = needs.getByRole("button", { name: "Decide: [SIMULATED] Add rate limiting", exact: true });
  await planSummary.click();
  await needs.getByText("Plan: [SIMULATED] Add rate limiting").waitFor();
  const deep = mergeCoordinatorConfig({}).tiers.deep.claude;
  await needs.getByText(`· Claude ${deep.model[0].toUpperCase()}${deep.model.slice(1)} · ${deep.effort}`).waitFor();
  check("the plan card lists each task with its agent, model and effort", (await needs.getByText(project, { exact: true }).count()) === 1);
  await needs.getByText("After: [SIMULATED] Design the limiter").waitFor();
  check("the plan card shows every task's scope paths, prerequisites and the task count", (await needs.getByText("2 tasks.", { exact: false }).count()) === 1 && (await needs.getByText("docs", { exact: true }).count()) === 1 && (await needs.getByText("src", { exact: true }).count()) === 1);
  await needs.getByText("Brief and checks").first().click();
  await needs.getByText("Decide the algorithm and limits for login.").waitFor();
  check("the brief and checks are on expand, unclipped", (await needs.getByText("design doc", { exact: true }).count()) === 1);
  let refused = false;
  await agent.approve(planned.result.proposal.id, { digest: "0".repeat(64) }).catch(() => (refused = true));
  check("approving with a digest other than the shown plan's is refused", refused && agent.proposal(planned.result.proposal.id)?.state === "pending");
  await planSummary.click();
  await needs.getByRole("button", { name: "No thanks", exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Plan: [SIMULATED]"));
  check("No thanks on a plan creates and launches nothing", c.snapshot().tasks.length === before && agent.proposal(planned.result.proposal.id)?.state === "rejected");
  await page.getByRole("button", { name: "Close inbox" }).click();
  for (const viewport of [{ width: 1500, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    const authority = JSON.stringify(c.snapshot());
    await memoryUI(page);
    check(`Settings memory CRUD persists at ${viewport.width}px; grants and tasks unchanged`, JSON.stringify(c.snapshot()) === authority);
  }
  check("no browser runtime errors", errors.length === 0);
  console.log(`${passed}/${passed} compiled-UI authority checks passed (SIMULATED records; no real providers).`);
} finally {
  await browser?.close();
  server.stop(true);
  store.db.close();
  rmSync(root, { recursive: true, force: true });
}
