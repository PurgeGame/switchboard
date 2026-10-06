#!/usr/bin/env bun
// Compiled UI + real HTTP/SQLite authority service, with explicitly SIMULATED records.
// No daemon entrypoint, scanner, bridge, provider, model, notification or live data is used.
// Run after `bun run build`: bun test/e2e/authority.ts
import { chromium } from "playwright-core";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../../src/daemon/db.ts";
import { Coordination } from "../../src/daemon/coordination.ts";
import { startHttp } from "../../src/daemon/http.ts";
import { CoordinatorAgent } from "../../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../../src/daemon/coordinator/config.ts";

const root = mkdtempSync(join(tmpdir(), "sb-authority-ui-"));
const project = join(root, "project");
mkdirSync(project);
const store = new Store(root);
const seed = new Coordination(store);
// A pre-upgrade objective/task: ungranted, with a historical (unsupported) verified claim.
const legacyObj = seed.createObjective("[SIMULATED] Legacy objective", "", undefined, "human");
const legacy = seed.createTask({ title: "[SIMULATED] Legacy verified", objectiveId: legacyObj.id, acceptance: ["Reviewed actual diff"] }, "human");
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
  sessions: () => new Map(),
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
  registry: { sessions: new Map(), list: () => [], onPush: () => {} },
  attention: { open: () => [] },
  perspectives: { list: () => [] },
  governor: { snapshot: () => ({ gameMode: false, gameManual: null, sessions: {}, log: [] }) },
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
  const needs = page.getByRole("region", { name: "Needs you" });
  await needs.getByText(project, { exact: true }).waitFor();
  check("the proposal card shows the real folder from the request", true);
  await needs.getByRole("button", { name: "Go ahead", exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Go ahead"));
  const granted = c.snapshot().objectives.find((o) => o.title === "[SIMULATED] Harden auth");
  check("Go ahead creates the project with a human grant on that folder", granted?.grant?.issuedBy === "human" && granted.grant.root === project);
  await page.reload();
  await page.getByRole("region", { name: "What's happening" }).getByText("[SIMULATED] Harden auth").waitFor();
  check("refresh shows the project, with no pending proposal", !(await page.getByRole("button", { name: "Go ahead" }).count()));
  // Finished work (here: the legacy historical claim) needs the user's OK; one click verifies it.
  const card = needs.getByText("[SIMULATED] Legacy verified", { exact: true });
  await card.waitFor();
  await needs.getByRole("button", { name: "Looks good", exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Looks good"));
  check("Looks good records the user's verification", c.isVerified(c.task(legacy.id)!) && !c.task(legacy.id)?.historicalVerified);
  // Stop revokes the grant and survives a refresh.
  await page.getByRole("region", { name: "What's happening" }).getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByText("Stopped", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("Stopped", { exact: true }).waitFor();
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
  await needs.getByRole("button", { name: "No thanks", exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Plan: [SIMULATED]"));
  check("No thanks on a plan creates and launches nothing", c.snapshot().tasks.length === before && agent.proposal(planned.result.proposal.id)?.state === "rejected");
  check("no browser runtime errors", errors.length === 0);
  console.log(`${passed}/${passed} compiled-UI authority checks passed (SIMULATED records; no real providers).`);
} finally {
  await browser?.close();
  server.stop(true);
  store.db.close();
  rmSync(root, { recursive: true, force: true });
}
