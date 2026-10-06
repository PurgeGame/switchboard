#!/usr/bin/env bun
// End-to-end test of the real web UI, served by an ISOLATED daemon (port 7795) that discovers
// only SIMULATED sessions (test/sim/claude-sim.ts). Uses the installed Google Chrome through
// playwright-core (no browser download). Never touches the live daemon on 7777 or any real session.
//   bun run e2e
import { chromium, type ConsoleMessage, type Page } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";
import { ClaudeSim } from "../sim/claude-sim.ts";

const root = join(import.meta.dir, "../..");
const sandbox = join(root, ".sandbox");
const PORT = 7795;
const dataDir = join(sandbox, "p7-data");
const configDir = join(sandbox, "p7-config");
const simHome = join(sandbox, "p7-sim");
const base = `http://127.0.0.1:${PORT}`;

if (!existsSync(join(root, "dist/web/index.html"))) {
  console.log("dist/web missing: building the UI");
  const b = spawnSync(["bun", "run", "build"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (b.exitCode !== 0) process.exit(1);
}

// Fresh isolated state every run (0700 dirs, like the real ones).
for (const d of [dataDir, configDir, simHome]) rmSync(d, { recursive: true, force: true });
for (const d of [dataDir, configDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
// No model classifier calls (no real provider), no auto-continue, and no desktop notifications.
// coordinator.agent (D34): the run starts with the built-in coordinator (left off: no model process),
// then restarts the isolated daemon with "none" and "external".
const writeConfig = (agent: "builtin" | "external" | "none") =>
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ modelClassifier: false, autoContinue: { enabled: false }, notifyDesktop: false, coordinator: { agent } }), { mode: 0o600 });
writeConfig("builtin");

const sim = new ClaudeSim(simHome);
const alpha = sim.start("e2e-alpha", { cwd: "/sim/e2e-alpha" });
sim.turn(alpha, "Refactor the parser", "Parser refactored.");
sim.user(alpha, "Now add the cache layer");
sim.assistant(alpha, "Cache layer drafted.\n\nWhich eviction policy do you want, LRU or LFU?");
sim.turnEnd(alpha);
const beta = sim.start("e2e-beta", { cwd: "/sim/e2e-beta" });
sim.turn(beta, "Say hello", "Hello from the simulator.");
const alphaId = `claude:${alpha.sessionId}`;
const betaId = `claude:${beta.sessionId}`;
// Open but never used: hidden from the list.
const empty = sim.start("e2e-empty", { cwd: "/sim/e2e-empty" });
const emptyId = `claude:${empty.sessionId}`;

let logName = "p7-daemon.log";
const spawnDaemon = () =>
  Bun.spawn(["bun", "src/daemon/main.ts"], {
    cwd: root,
    env: { ...process.env, SB_PORT: String(PORT), SB_DATA_DIR: dataDir, SB_CONFIG_DIR: configDir, SB_CLAUDE_HOME: simHome, SB_CODEX_HOME: join(simHome, "codex-none") },
    stdout: Bun.file(join(sandbox, logName)),
    stderr: Bun.file(join(sandbox, logName)),
  });
let daemon = spawnDaemon();
async function waitUp() {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
    if (!up) await Bun.sleep(100);
  }
  if (!up) throw new Error(`isolated daemon did not start; see ${join(sandbox, logName)}`);
}
/** Restart the isolated daemon (same data, same sessions) with another coordinator.agent. */
async function restartAs(agent: "external" | "none") {
  daemon.kill();
  await daemon.exited;
  writeConfig(agent);
  logName = `p7-daemon-${agent}.log`;
  daemon = spawnDaemon();
  await waitUp();
}
const rootToken = () => readFileSync(join(configDir, "token"), "utf8").trim();
const loginUrl = async () =>
  ((await fetch(`${base}/api/login-code`, { method: "POST", headers: { authorization: `Bearer ${rootToken()}` } }).then((r) => r.json())) as { url: string }).url;

const results: [string, boolean, string][] = [];
const check = (name: string, pass: boolean, detail = "") => {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail && !pass ? `  (${detail})` : ""}`);
};
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    check(name, true);
  } catch (e) {
    check(name, false, String((e as Error).message).split("\n")[0]);
  }
}

async function cleanup() {
  daemon.kill();
  await daemon.exited;
  await sim.cleanup();
}

try {
  await waitUp();
  const url = await loginUrl();

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m: ConsoleMessage) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const T = { timeout: 15_000 };

  await step("login lands on the coordinator chat (first in the list), nothing technical", async () => {
    await page.goto(url);
    await page.getByRole("heading", { name: "Switchboard" }).waitFor(T);
    await page.getByRole("region", { name: "Coordinator chat" }).waitFor(T);
    // The coordinator ships off; Home says so plainly instead of showing a dead box.
    await page.getByText("The coordinator is off.").waitFor(T);
    for (const gone of ["PSI", "Resources", "Wall", "Send method", "Enforcement"])
      if (await page.getByText(gone, { exact: true }).count()) throw new Error(`still showing "${gone}"`);
  });
  await step("the coordinator chat lists what needs you: the session's open question", async () => {
    await page.getByRole("region", { name: "Needs you" }).waitFor(T);
    await page.getByText("A session is waiting for you").waitFor(T);
  });
  await step("the list shows the coordinator first, then sessions with work; empty ones are hidden", async () => {
    await page.locator('[data-session-id="coordinator"]').waitFor(T);
    await page.locator(`[data-session-id="${alphaId}"]`).waitFor(T);
    await page.locator(`[data-session-id="${betaId}"]`).waitFor(T);
    const txt = await page.locator(`[data-session-id="${alphaId}"]`).innerText();
    if (!txt.includes("e2e-alpha")) throw new Error(`row text: ${txt}`);
    if (await page.locator(`[data-session-id="${emptyId}"]`).count()) throw new Error("an empty session is listed");
  });
  await step("opening a session shows its transcript and a plain composer", async () => {
    await page.locator(`[data-session-id="${alphaId}"]`).click();
    await page.getByText("Which eviction policy do you want, LRU or LFU?").first().waitFor(T);
    await page.getByText("Refactor the parser").first().waitFor(T);
    if (await page.getByRole("combobox").count()) throw new Error("composer still has a method/mode picker");
  });
  await step("selecting transcript text copies it to the clipboard", async () => {
    await page.getByText("Which eviction policy do you want, LRU or LFU?").first().click({ clickCount: 3 });
    await page.getByText("Copied", { exact: true }).waitFor(T);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    if (!clip.includes("Which eviction policy")) throw new Error(`clipboard: ${clip.slice(0, 80)}`);
  });
  await step("right-click in the message box pastes the clipboard", async () => {
    // Simulated sessions are view-only, so use the coordinator's box, shown "on" via a browser-side
    // mock of its status (no coordinator process is started).
    const real = await (await page.request.get(`${base}/api/coordinator`)).json();
    await page.route("**/api/coordinator", (r) => r.fulfill({ json: { ...real, mode: "active" } }));
    await page.reload();
    await page.locator('[data-session-id="coordinator"]').click();
    await page.evaluate(() => navigator.clipboard.writeText("pasted by right-click"));
    const box = page.getByRole("textbox", { name: "Message the coordinator" });
    await box.click({ button: "right" });
    await page.waitForFunction(() => [...document.querySelectorAll("textarea")].some((t) => t.value.includes("pasted by right-click")));
    await box.fill("");
    await page.unroute("**/api/coordinator");
    await page.reload();
    await page.locator(`[data-session-id="${alphaId}"]`).click();
  });
  await step("the inbox opens with i and holds the question", async () => {
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("i");
    await page.getByRole("complementary", { name: "Attention inbox" }).waitFor(T);
    await page.locator("[data-inbox-id]").first().waitFor(T);
    await page.keyboard.press("i");
    await page.getByRole("complementary", { name: "Attention inbox" }).waitFor({ state: "detached", ...T });
  });
  await step("no Compare tab: perspectives are the coordinator's job", async () => {
    if (await page.getByRole("tab").count()) throw new Error("view tabs still shown");
  });
  await step("keyboard: g h opens the coordinator", async () => {
    await page.locator(`[data-session-id="${betaId}"]`).click();
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await page.getByRole("region", { name: "Coordinator chat" }).waitFor(T);
  });
  await step("deep link #/s/<id> opens that session", async () => {
    const p2 = await page.context().newPage();
    p2.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    p2.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
    await p2.goto(`${base}/#/s/${encodeURIComponent(betaId)}`);
    await p2.getByText("Hello from the simulator.").first().waitFor(T);
    await p2.close();
  });
  await step("refresh keeps the session open (state restored from the daemon)", async () => {
    await page.goto(`${base}/#/s/${encodeURIComponent(alphaId)}`);
    await page.reload();
    await page.getByText("Which eviction policy do you want, LRU or LFU?").first().waitFor(T);
  });
  await step("background agents sit in a collapsed section at the bottom; its state is remembered", async () => {
    // Mark beta as one the coordinator started (the daemon sets this; no coordinator runs here).
    // Sessions reach the page in the websocket's hello message, so rewrite that.
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((m) => {
        const msg = typeof m === "string" ? JSON.parse(m) : null;
        if (msg?.type === "hello") msg.sessions = msg.sessions.map((s: any) => (s.id === betaId ? { ...s, meta: { ...s.meta, background: "worker" } } : s));
        ws.send(msg ? JSON.stringify(msg) : m);
      });
      ws.onMessage((m) => server.send(m));
    });
    await page.goto(base);
    await page.reload();
    const row = page.locator(`[data-session-id="${betaId}"]`);
    const toggle = page.getByRole("button", { name: /Background agents \(1\)/ });
    await toggle.waitFor(T);
    await page.locator(`[data-session-id="${alphaId}"]`).waitFor(T);
    if (await row.count()) throw new Error("a background agent is in the main list while collapsed");
    await toggle.click();
    await row.waitFor(T);
    await page.reload();
    await row.waitFor(T); // expanded state survives a reload
    await page.getByRole("button", { name: /Background agents \(1\)/ }).click();
    await row.waitFor({ state: "detached", ...T });
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
  await step("a failed plan task shows its error and a Retry button; a refused retry shows why", async () => {
    const real = await (await page.request.get(`${base}/api/coordinator`)).json();
    const plans = [{ proposalId: 7, title: "Ship the thing", tasks: [{ key: "a", taskId: "t1", title: "Write hello", state: "failed", error: "worktree could not be created" }, { key: "b", taskId: "t2", title: "Write world", state: "waiting" }] }];
    await page.route("**/api/coordinator", (r) => r.fulfill({ json: { ...real, plans } }));
    let calls = 0;
    await page.route("**/api/coordinator/plans/7/tasks/a/retry", (r) => {
      calls++;
      return calls === 1 ? r.fulfill({ status: 409, json: { ok: false, error: "it's launched, not failed" } }) : r.fulfill({ json: { ok: true } });
    });
    await page.goto(base);
    await page.reload();
    await page.getByText("Write hello").waitFor(T);
    await page.getByText("worktree could not be created").waitFor(T);
    if ((await page.getByRole("button", { name: "Retry" }).count()) !== 1) throw new Error("expected exactly one Retry button (the waiting task has none)");
    const before = consoleErrors.length;
    await page.getByRole("button", { name: "Retry" }).click();
    await page.getByText("it's launched, not failed").waitFor(T);
    consoleErrors.splice(before, consoleErrors.length, ...consoleErrors.slice(before).filter((m) => !m.includes("409"))); // the refusal under test
    await page.getByRole("button", { name: "Retry" }).click();
    await page.waitForFunction(() => !document.body.innerText.includes("it's launched, not failed"));
    if (calls !== 2) throw new Error(`retry route called ${calls} times`);
    await page.unroute("**/api/coordinator");
    await page.unroute("**/api/coordinator/plans/7/tasks/a/retry");
  });
  // ---- coordinator.agent "none" (D34): no coordinator anywhere; prompts and waiting sessions stay actionable.
  const api = (path: string, body: unknown, bearer = rootToken()) =>
    fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  await step("no coordinator: home is a plain Needs you row and pane; no coordinator row or chat anywhere", async () => {
    await page.goto("about:blank"); // no reconnect noise while the daemon is down
    await restartAs("none");
    await page.goto(await loginUrl());
    const row = page.locator('[data-session-id="coordinator"]');
    await row.getByText("Needs you", { exact: true }).waitFor(T);
    await page.getByRole("heading", { name: "Needs you" }).waitFor(T);
    await page.getByText("A session is waiting for you").waitFor(T);
    await page.locator(`[data-session-id="${alphaId}"]`).waitFor(T);
    if (await page.getByText("Coordinator", { exact: true }).count()) throw new Error("a coordinator row or heading is shown");
    if (await page.getByRole("region", { name: "Coordinator chat" }).count()) throw new Error("coordinator chat shown");
    if (await page.getByRole("textbox", { name: "Message the coordinator" }).count()) throw new Error("coordinator message box shown");
  });
  await step("no coordinator: a permission prompt is answered from home (Allow reaches the session's hook)", async () => {
    const hook = api("/api/hook/claude/PermissionRequest?wait=1", {
      session_id: alpha.sessionId,
      tool_name: "Read",
      tool_input: { file_path: "/sim/e2e-alpha/notes.txt" },
      cwd: "/sim/e2e-alpha",
    }).then((r) => r.json());
    await page.getByText("wants to:").waitFor(T);
    if (await page.getByText(/^Coordinator:/).count()) throw new Error("a prompt is labelled as the coordinator's view");
    await page.getByRole("button", { name: "Allow" }).click();
    const out = (await hook) as any;
    if (out?.hookSpecificOutput?.decision?.behavior !== "allow") throw new Error(`hook answer: ${JSON.stringify(out)}`);
    await page.getByText("wants to:").waitFor({ state: "detached", ...T });
  });
  await step("no coordinator: g h goes home", async () => {
    await page.locator(`[data-session-id="${alphaId}"]`).click();
    await page.getByText("Which eviction policy do you want, LRU or LFU?").first().waitFor(T);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await page.getByRole("heading", { name: "Needs you" }).waitFor(T);
  });

  // ---- coordinator.agent "external" (D34): the engine without a model; your agent connects with `sb mcp`.
  await step("your own agent: the coordinator row and pane stay, with a note instead of a chat box", async () => {
    await page.goto("about:blank");
    await restartAs("external");
    await page.goto(await loginUrl());
    const row = page.locator('[data-session-id="coordinator"]');
    await row.getByText("Coordinator", { exact: true }).waitFor(T);
    await row.getByText(/your agent/).waitFor(T);
    await row.click();
    const note = page.getByRole("region", { name: "External coordinator" });
    await note.getByText("sb mcp").waitFor(T);
    await note.getByText("Not connected since Switchboard started.").waitFor(T);
    if (await page.getByRole("textbox", { name: "Message the coordinator" }).count()) throw new Error("a chat box is shown for an external agent");
  });
  await step("your own agent: Turn on works, a tool call shows it connected, its proposal gets Go ahead / No thanks", async () => {
    await page.getByRole("button", { name: "Turn on" }).click();
    await page.getByRole("button", { name: "Pause" }).waitFor(T);
    const coordTok = readFileSync(join(configDir, "coordinator-token"), "utf8").trim();
    const r = (await (await api("/api/coordinator/tool/propose_action", { title: "Rename the e2e repo", detail: "rename it", reason: "tidy" }, coordTok)).json()) as any;
    if (!r.ok) throw new Error(`propose_action: ${JSON.stringify(r)}`);
    await page.getByText(/Connected: last call/).waitFor(T);
    await page.getByText("Rename the e2e repo?").waitFor(T);
    await page.getByRole("button", { name: "Go ahead" }).waitFor(T);
    await page.getByRole("button", { name: "No thanks" }).click();
    await page.getByText("Rename the e2e repo?").waitFor({ state: "detached", ...T });
  });

  await step("no console errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.join(" | "));
  });
  await browser.close();
} catch (e) {
  check("e2e harness", false, String((e as Error).stack ?? e));
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} e2e checks passed`);
for (const [n, , d] of failed) console.log(`  FAILED: ${n}: ${d}`);
process.exit(failed.length ? 1 : 0);
