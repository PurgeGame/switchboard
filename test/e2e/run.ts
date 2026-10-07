#!/usr/bin/env bun
// End-to-end test of the real web UI, served by an ISOLATED daemon (unused local port) that discovers
// only SIMULATED sessions (test/sim/claude-sim.ts). Uses the installed Google Chrome through
// playwright-core (no browser download). Never touches the live daemon on 7777 or any real session.
//   bun run e2e
import { chromium, type ConsoleMessage, type Page } from "playwright-core";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";
import { ClaudeSim } from "../sim/claude-sim.ts";
import { happeningChecks } from "./happening.ts";
import { usageSettingsUI } from "./usage-ui.ts";
import { memoryUI } from "./memory-ui.ts";
import { checkFullCard, longCardText } from "./card-content.ts";
import { checkSessionPlacement } from "./session-placement.ts";

const root = join(import.meta.dir, "../..");
const sandbox = join(root, ".sandbox");
// Other task worktrees can run their own e2e concurrently. Reserve an unused local port.
const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const PORT = portProbe.port!;
portProbe.stop(true);
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
// coordinator.agent (D34): the run starts with the built-in coordinator (local protocol stand-ins),
// then restarts the isolated daemon with "none" and "external".
const writeConfig = (agent: "builtin" | "external" | "none") =>
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ modelClassifier: false, autoContinue: { enabled: false }, notifyDesktop: false, autoApproveSafePermissions: "all", coordinator: { agent } }), { mode: 0o600 });
writeConfig("builtin");

const sim = new ClaudeSim(simHome);
const alpha = sim.start("e2e-alpha", { cwd: "/sim/e2e-alpha" });
sim.turn(alpha, "Refactor the parser", "Parser refactored.");
sim.user(alpha, "Now add the cache layer");
sim.assistant(alpha, "Cache layer drafted.\n\nWhich eviction policy do you want, LRU or LFU?");
sim.turnEnd(alpha);
const betaRoot = join(sandbox, "p7-worker");
mkdirSync(betaRoot, { recursive: true });
writeFileSync(join(betaRoot, "safe.txt"), "safe fixture");
const policyWorker = sim.start("e2e-policy", { cwd: betaRoot });
sim.turn(policyWorker, "Read a safe fixture", "Ready.");
const beta = sim.start("e2e-beta", { cwd: "/sim/e2e-beta" });
sim.turn(beta, "Say hello", "Hello from the simulator.");
const alphaId = `claude:${alpha.sessionId}`;
const betaId = `claude:${beta.sessionId}`;
const unread = sim.start("e2e-unread", { cwd: "/sim/e2e-unread" });
sim.turn(unread, "Prepare the output", "Initial output.");
const completed = sim.start("e2e-completed", { cwd: "/sim/e2e-completed" });
sim.turn(completed, "Prepare the completion", "Initial completion.");
const unreadId = `claude:${unread.sessionId}`;
const completedId = `claude:${completed.sessionId}`;
// Open but never used: hidden from the list.
const empty = sim.start("e2e-empty", { cwd: "/sim/e2e-empty" });
const emptyId = `claude:${empty.sessionId}`;

let logName = "p7-daemon.log";
// Coordinator lifecycle is exercised with local protocol stand-ins, never paid/live models.
const brainBin = join(sandbox, "p7-brains");
mkdirSync(brainBin, { recursive: true });
for (const provider of ["claude", "codex"] as const)
  writeFileSync(join(brainBin, provider), `#!/usr/bin/env bun\nimport { coordinatorBrain } from ${JSON.stringify(join(root, "test/sim/coordinator-brain.ts"))};\nawait coordinatorBrain(${JSON.stringify(provider)});\n`, { mode: 0o700 });
const spawnDaemon = () =>
  Bun.spawn(["bun", "src/daemon/main.ts"], {
    cwd: root,
    env: { ...process.env, PATH: `${brainBin}:${process.env.PATH}`, SB_PORT: String(PORT), SB_DATA_DIR: dataDir, SB_CONFIG_DIR: configDir, SB_CLAUDE_HOME: simHome, SB_CODEX_HOME: join(simHome, "codex-none") },
    stdout: Bun.file(join(sandbox, logName)),
    stderr: Bun.file(join(sandbox, logName)),
  });
let daemon = spawnDaemon();
async function waitUp() {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    if (daemon.exitCode !== null) throw new Error(`isolated daemon exited; see ${join(sandbox, logName)}`);
    // Do not mistake a concurrent worktree's daemon for our own during startup.
    up = existsSync(join(configDir, "token")) && await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
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
    console.error((e as Error).stack ?? e);
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

  const browser = await chromium.launch({ channel: "chrome", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
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
  await step("Settings memory CRUD persists across reloads while the coordinator is off", () => memoryUI(page));
  await step("Usage recommendation Settings save and survive reload at this viewport", () => usageSettingsUI(page));
  await step("the inbox icon opens the session question and a reply action", async () => {
    await page.getByRole("button", { name: /^Inbox,/ }).click();
    const needs = page.getByRole("region", { name: "Needs you" });
    await needs.waitFor(T);
    await needs.getByRole("button", { name: /e2e-alpha: Which eviction policy/ }).waitFor(T);
    await needs.getByRole("button", { name: "Reply", exact: true }).waitFor(T);
  });
  await step("Settings saves the worker idle grace and off switch without a restart", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const toggle = page.getByRole("checkbox", { name: "End finished background workers" });
    await toggle.waitFor(T);
    if (!(await toggle.isChecked())) throw new Error("auto-end should default on");
    await page.getByRole("spinbutton", { name: "Idle grace (minutes)" }).fill("25");
    await page.getByRole("button", { name: "Save grace period" }).click();
    await page.waitForFunction(async () => (await (await fetch("/api/coordinator")).json()).autoEnd.idleMinutes === 25);
    await toggle.uncheck();
    await page.waitForFunction(async () => !(await (await fetch("/api/coordinator")).json()).autoEnd.enabled);
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Idle grace (minutes)" }).waitFor(T);
    if (await toggle.isChecked()) throw new Error("off switch didn't persist");
    if (await page.getByRole("spinbutton", { name: "Idle grace (minutes)" }).inputValue() !== "25") throw new Error("grace didn't persist");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  });
  await step("Settings switches runtime and model on the next brain start; Use Codex now leaves the daemon running", async () => {
    const daemonPid = daemon.pid;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const provider = page.getByRole("combobox", { name: "Coordinator runtime", exact: true });
    const model = page.getByRole("combobox", { name: "Coordinator model", exact: true });
    await provider.waitFor(T);
    if (await provider.inputValue() !== "claude") throw new Error("Claude must be the default");
    await provider.selectOption("claude");
    await page.waitForFunction(async () => (await (await fetch("/api/coordinator/runtime")).json()).selected.provider === "claude");
    await model.selectOption("sonnet");
    await page.waitForFunction(async () => (await (await fetch("/api/coordinator/runtime")).json()).selected.model === "sonnet");
    await page.evaluate(async () => {
      await fetch("/api/coordinator/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "active" }) });
      await fetch("/api/coordinator/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Keep this across the runtime switch" }) });
    });
    await page.waitForFunction(async () => (await (await fetch("/api/coordinator/runtime")).json()).current?.model === "sonnet");
    await page.getByRole("button", { name: "Use Codex now", exact: true }).click();
    await page.waitForFunction(async () => (await (await fetch("/api/coordinator/runtime")).json()).current?.provider === "codex");
    await model.selectOption("gpt-6-astra");
    await page.waitForFunction(async () => (await (await fetch("/api/coordinator/runtime")).json()).selected.model === "gpt-6-astra");
    const pending = await page.evaluate(async () => (await fetch("/api/coordinator/runtime")).json());
    if (pending.current.model !== "gpt-6.1-sol") throw new Error("save changed the running model");
    await page.getByRole("button", { name: "Restart coordinator", exact: true }).click();
    await page.waitForFunction(async () => (await (await fetch("/api/coordinator/runtime")).json()).current?.model === "gpt-6-astra");
    const state = await page.evaluate(async () => (await fetch("/api/coordinator")).json());
    if (state.mode !== "active" || !state.chat.some((c: any) => c.text === "Keep this across the runtime switch")) throw new Error("restart lost mode or chat");
    if (daemon.pid !== daemonPid || daemon.exitCode !== null) throw new Error("switch restarted the daemon");
    await page.evaluate(async () => fetch("/api/coordinator/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "manual" }) }));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  });
  await step("the list shows the coordinator first, then sessions with work; empty ones are hidden", async () => {
    await page.locator('[data-session-id="coordinator"]').waitFor(T);
    await page.locator(`[data-session-id="${alphaId}"]`).waitFor(T);
    await page.locator(`[data-session-id="${betaId}"]`).waitFor(T);
    const txt = await page.locator(`[data-session-id="${alphaId}"]`).innerText();
    if (!txt.includes("e2e-alpha")) throw new Error(`row text: ${txt}`);
    if (await page.locator(`[data-session-id="${emptyId}"]`).count()) throw new Error("an empty session is listed");
  });
  await step("Settings safe-permission switch starts from config (\"all\" here, shown in its hint), saves off across reload, and can be enabled again", async () => {
    const settings = () => page.getByRole("button", { name: "Settings", exact: true });
    const toggle = () => page.getByRole("checkbox", { name: /Auto-approve safe permissions/ });
    await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/settings/permissions") && r.request().method() === "GET"), settings().click()]);
    if (!await toggle().isChecked()) throw new Error("autoApproveSafePermissions \"all\" should start the switch on");
    await page.getByText(/in every session not excluded from coordination/).waitFor(T);
    await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/settings/permissions") && r.request().method() === "POST"), toggle().uncheck()]);
    await page.reload();
    await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/settings/permissions") && r.request().method() === "GET"), settings().click()]);
    if (await toggle().isChecked()) throw new Error("off setting did not persist");
    await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/settings/permissions") && r.request().method() === "POST"), toggle().check()]);
    await settings().click();
  });
  await step("safe hook is auto-approved with no card; inbox activity shows the full command and rule", async () => {
    const response = await fetch(`${base}/api/hook/claude/PermissionRequest?wait=1`, { method: "POST", headers: { authorization: `Bearer ${rootToken()}`, "content-type": "application/json" }, signal: AbortSignal.timeout(5000), body: JSON.stringify({ session_id: policyWorker.sessionId, tool_name: "Bash", tool_input: { command: "cat safe.txt" }, cwd: betaRoot }) });
    const reply: any = await response.json();
    if (reply?.hookSpecificOutput?.decision?.behavior !== "allow") throw new Error("safe hook was not allowed");
    await page.getByRole("button", { name: /^Inbox,/ }).click();
    await page.getByRole("button", { name: /Auto-handled/ }).click();
    await page.getByText("Rule: read-only-cat", { exact: true }).waitFor(T);
    await page.getByText("Auto-approved: Bash", { exact: true }).click();
    await page.locator("pre", { hasText: "cat safe.txt" }).waitFor(T);
    await page.getByRole("button", { name: "Close inbox" }).click();
  });
  await step("repeated test/typecheck hooks stay autonomous and show their verification rules in activity", async () => {
    const command = "bun test && bun run typecheck";
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/api/hook/claude/PermissionRequest?wait=1`, { method: "POST", headers: { authorization: `Bearer ${rootToken()}`, "content-type": "application/json" }, signal: AbortSignal.timeout(5000), body: JSON.stringify({ session_id: policyWorker.sessionId, tool_name: "Bash", tool_input: { command }, cwd: betaRoot }) });
      const reply: any = await response.json();
      if (reply?.hookSpecificOutput?.decision?.behavior !== "allow") throw new Error("verification required permission");
    }
    const open: any[] = await fetch(`${base}/api/attention`, { headers: { authorization: `Bearer ${rootToken()}` } }).then((r) => r.json()) as any[];
    if (open.some((item) => item.sessionId === `claude:${policyWorker.sessionId}`)) throw new Error("verification raised a card");
    await page.getByRole("button", { name: /^Inbox,/ }).click();
    await page.getByRole("button", { name: /Auto-handled/ }).click();
    const rule = "Rule: verification-bun:test + verification-package-script:bun:typecheck";
    await page.getByText(rule, { exact: true }).first().waitFor(T);
    if (await page.getByText(rule, { exact: true }).count() !== 2) throw new Error("each approval needs its own rule log");
    await page.getByRole("button", { name: "Close inbox" }).click();
  });
  const show = page.getByRole("group", { name: "Show", exact: true });
  const active = (count: number) => show.getByRole("button", { name: `Active ${count}`, exact: true });
  const listedSessions = () => page.getByRole("navigation", { name: "Sessions", exact: true }).locator('[data-session-id^="claude:"]');
  await step("Active sits next to Working, counts assistant output and turn ends, and filters out read sessions", async () => {
    await active(0).waitFor(T);
    const [workingBox, activeBox] = await Promise.all([show.getByRole("button", { name: "Working", exact: true }), active(0)].map((l) => l.boundingBox()));
    if (!workingBox || !activeBox || activeBox.x < workingBox.x + workingBox.width || activeBox.y !== workingBox.y) throw new Error("Active isn't next to Working");
    sim.user(unread, "A new input alone is not unread output");
    await page.waitForFunction(async (id) => (await (await fetch(`/api/sessions/${encodeURIComponent(id)}/events`)).json()).some((e: any) => e.data.text === "A new input alone is not unread output"), unreadId, T);
    if (await show.getByRole("button", { name: "Active 0", exact: true }).count() !== 1) throw new Error("user input marked the session unread");
    sim.assistant(unread, "New unread output.");
    sim.turnEnd(completed);
    await active(2).waitFor(T);
    for (const id of [unreadId, completedId]) await page.locator(`[data-session-id="${id}"]`).getByRole("img", { name: "Unread activity" }).waitFor(T);
    await active(2).click();
    if (await active(2).getAttribute("aria-pressed") !== "true") throw new Error("Active isn't selected");
    const ids = await listedSessions().evaluateAll((els) => els.map((e) => e.getAttribute("data-session-id")).sort());
    if (JSON.stringify(ids) !== JSON.stringify([unreadId, completedId].sort())) throw new Error(`unexpected unread rows: ${ids}`);
    await page.getByRole("textbox", { name: "Search sessions" }).fill("e2e-unread");
    await active(1).waitFor(T);
    if (await listedSessions().count() !== 1) throw new Error("Active doesn't combine with search");
    await page.getByRole("textbox", { name: "Search sessions" }).fill("");
    await active(2).waitFor(T);
  });
  await step("opening an unread session clears its dot, removes its filtered row and updates Active's count", async () => {
    await page.locator(`[data-session-id="${unreadId}"]`).click();
    await page.getByRole("heading", { name: "e2e-unread", exact: true }).waitFor(T);
    await active(1).waitFor(T);
    if (await page.locator(`[data-session-id="${unreadId}"]`).count()) throw new Error("opened session stays in Active");
    await show.getByRole("button", { name: "All", exact: true }).click();
    if (await page.locator(`[data-session-id="${unreadId}"]`).getByRole("img", { name: "Unread activity" }).count()) throw new Error("opened session's dot remains");
    sim.assistant(unread, "Output while viewing is already read.");
    await page.locator(".md").getByText("Output while viewing is already read.", { exact: true }).waitFor(T);
    await active(1).waitFor(T);
    await active(1).click();
    await page.locator(`[data-session-id="${completedId}"]`).click();
    await active(0).waitFor(T);
    await page.getByText("No sessions match these filters.", { exact: true }).waitFor(T);
  });
  await step("seen markers survive reload and Active discovers assistant output received while away", async () => {
    await page.goto("about:blank");
    sim.assistant(unread, "Output received while the page was closed.");
    sim.turnEnd(unread);
    await page.goto(base);
    await active(1).waitFor(T);
    await active(1).click();
    if (await listedSessions().count() !== 1) throw new Error("read completion reappeared after reload");
    await page.locator(`[data-session-id="${unreadId}"]`).getByRole("img", { name: "Unread activity" }).waitFor(T);
    await page.locator(`[data-session-id="${unreadId}"]`).click();
    await active(0).waitFor(T);
    await show.getByRole("button", { name: "All", exact: true }).click();
    await page.locator('[data-session-id="coordinator"]').click();
  });
  await step("a transcript denial keeps its command, reason and Allow/Deny actions in the inbox across views", async () => {
    const records = readFileSync(join(root, "test/fixtures/claude/transcripts/permission-denial.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    appendFileSync(beta.transcript, records.map((r, i) => JSON.stringify({ ...r, uuid: `denial-e2e-${i}`, timestamp: new Date(Date.now() + i).toISOString() })).join("\n") + "\n");
    await page.getByRole("button", { name: /^Inbox,/ }).click();
    const home = page.getByRole("region", { name: "Needs you", exact: true });
    const denial = home.locator("[data-needs-you-id]", { hasText: "rg -n 'permission|approval' src" });
    await denial.waitFor(T);
    await denial.locator("button[aria-expanded]").click();
    await denial.getByText(/Sensitive-Source Provenance/).waitFor(T);
    if (!(await denial.innerText()).includes("rg -n 'permission|approval' src")) throw new Error("original command missing");
    await denial.getByRole("button", { name: "Allow", exact: true }).first().click({ trial: true });
    await denial.getByRole("button", { name: "Deny", exact: true }).first().click({ trial: true });
    await page.getByRole("button", { name: "Close inbox" }).click();
    await page.locator(`[data-session-id="${betaId}"]`).click();
    await page.getByRole("button", { name: /^Inbox,/ }).click();
    const here = denial;
    await here.waitFor(T);
    if (await home.count() !== 1) throw new Error("denial is duplicated in the session");
    await here.getByRole("button", { name: "Allow", exact: true }).first().click({ trial: true });
    // This simulator is observe-only: a failed send must keep the decision actionable.
    const before = consoleErrors.length;
    await here.getByRole("button", { name: "Deny", exact: true }).first().click();
    await here.getByText("this session is observe-only", { exact: true }).waitFor(T);
    consoleErrors.splice(before, consoleErrors.length, ...consoleErrors.slice(before).filter((m) => !m.includes("409"))); // the refused delivery under test
    sim.turn(beta, "Move on without the denied search.", "Continuing without the search.");
    await here.waitFor({ state: "detached", ...T });
  });
  await step("opening a session shows its transcript and a plain composer", async () => {
    await page.locator(`[data-session-id="${alphaId}"]`).click();
    await page.getByText("Which eviction policy do you want, LRU or LFU?").first().waitFor(T);
    await page.getByText("Refactor the parser").first().waitFor(T);
    if (await page.getByRole("combobox").count()) throw new Error("composer still has a method/mode picker");
  });
  await step("selecting transcript text copies it to the clipboard", async () => {
    await page.locator(".md").getByText("Which eviction policy do you want, LRU or LFU?", { exact: true }).click({ clickCount: 3 });
    await page.getByText("Copied", { exact: true }).waitFor(T);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    if (!clip.includes("Which eviction policy")) throw new Error(`clipboard: ${clip.slice(0, 80)}`);
  });
  await step("right-click in the message box pastes the clipboard", async () => {
    // Use this isolated daemon's protocol stand-in. An HTTP-only status mock races the
    // real WebSocket hello and can hide the composer again during reload.
    const real = await (await page.request.get(`${base}/api/coordinator`)).json();
    const mode = (value: string) => page.request.post(`${base}/api/coordinator/mode`, { data: { mode: value } });
    try {
      if (!(await mode("active")).ok()) throw Error("could not enable the isolated coordinator stand-in");
      await page.reload();
      await page.locator('[data-session-id="coordinator"]').click();
      await page.evaluate(() => navigator.clipboard.writeText("pasted by right-click"));
      const box = page.getByRole("textbox", { name: "Message the coordinator" });
      await box.click({ button: "right" });
      await page.waitForFunction(() => [...document.querySelectorAll("textarea")].some((t) => t.value.includes("pasted by right-click")));
      await box.fill("");
    } finally {
      if (!(await mode(real.mode)).ok()) throw Error("could not restore isolated coordinator mode");
    }
    await page.reload();
    await page.locator(`[data-session-id="${alphaId}"]`).click();
  });
  await step("the inbox opens with i and contains the single Needs you list", async () => {
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("i");
    await page.getByRole("complementary", { name: "Attention inbox" }).waitFor(T);
    await page.getByRole("complementary", { name: "Attention inbox" }).getByRole("region", { name: "Needs you", exact: true }).waitFor(T);
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
        if (msg?.type === "session" && msg.session.id === betaId) msg.session.meta = { ...msg.session.meta, background: "worker" };
        ws.send(msg ? JSON.stringify(msg) : m);
      });
      ws.onMessage((m) => server.send(m));
    });
    await page.goto(base);
    await page.reload();
    const row = page.locator(`[data-session-id="${betaId}"]`);
    const toggle = page.getByRole("button", { name: /^Background agents/ });
    await toggle.waitFor(T);
    await page.locator(`[data-session-id="${alphaId}"]`).waitFor(T);
    if (await row.count()) throw new Error("a background agent is in the main list while collapsed");
    await toggle.click();
    await row.waitFor(T);
    await page.reload();
    await row.waitFor(T); // expanded state survives a reload
    await page.getByRole("button", { name: /^Background agents/ }).click();
    await row.waitFor({ state: "detached", ...T });
  });
  await step("background sessions pin to main and move back from the row menu and session view; placement survives reload", async () => {
    await checkSessionPlacement(page, betaId, "/sim/e2e-beta");
    await page.getByRole("button", { name: /^Background agents/ }).click();
  });
  await page.unrouteAll({ behavior: "ignoreErrors" });
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
    await page.getByRole("button", { name: /^Inbox,/ }).click();
    const summary = page.getByRole("button", { name: "Couldn't start: Write hello", exact: true });
    await summary.click();
    await page.getByText("worktree could not be created").waitFor(T);
    await summary.click();
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
  await step("desktop: a complete long result scrolls inside its card while review actions stay visible", async () => {
    const real = await (await page.request.get(`${base}/api/coordination`)).json();
    const task = {
      id: "e2e-long-result", objectiveId: "e2e", title: "Read the entire result", description: "", owner: betaId,
      scope: { paths: [], resources: [] }, priority: "normal", tier: "standard", tierReason: null, prerequisites: [],
      acceptance: ["Read the entire result"], status: "finished_unverified", result: longCardText, evidence: [], verifiedEvidence: [],
      worktree: null, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await page.route("**/api/coordination", (r) => r.fulfill({ json: { ...real, tasks: [...real.tasks, task] } }));
    try {
      await page.reload();
      await page.getByRole("button", { name: /^Inbox,/ }).click();
      const row = page.locator('[data-needs-you-id="review:e2e-long-result"]');
      await row.locator("button[aria-expanded]").click();
      await checkFullCard(page, row.locator(".needs-you-card"), "Task result", ["Looks good", "Not yet…", "See the session"]);
      await page.screenshot({ path: join(sandbox, "needs-you-long-result-desktop.png") });
    } finally {
      await page.unroute("**/api/coordination");
      await page.reload();
    }
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
    await page.getByRole("button", { name: /^Inbox,/ }).click();
    await page.getByRole("region", { name: "Needs you", exact: true }).getByRole("heading", { name: "Needs you", exact: true }).waitFor(T);
    await page.getByRole("button", { name: /e2e-alpha: Which eviction policy/ }).waitFor(T);
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
    const prompt = page.getByRole("region", { name: "Needs you", exact: true }).locator("[data-needs-you-id]", { hasText: "/sim/e2e-alpha/notes.txt" });
    await prompt.getByRole("button", { name: "Allow", exact: true }).waitFor(T);
    if (await page.getByText(/^Coordinator:/).count()) throw new Error("a prompt is labelled as the coordinator's view");
    await prompt.getByRole("button", { name: "Allow", exact: true }).click();
    const out = (await hook) as any;
    if (out?.hookSpecificOutput?.decision?.behavior !== "allow") throw new Error(`hook answer: ${JSON.stringify(out)}`);
    await prompt.waitFor({ state: "detached", ...T });
  });
  await step("no coordinator: g h goes home", async () => {
    await page.locator(`[data-session-id="${alphaId}"]`).click();
    await page.getByText("Which eviction policy do you want, LRU or LFU?").first().waitFor(T);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await page.getByRole("region", { name: "Sessions summary", exact: true }).waitFor(T);
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
    await page.getByRole("button", { name: /^Inbox,/ }).click();
    await page.getByRole("button", { name: "Decide: Rename the e2e repo", exact: true }).waitFor(T);
    await page.getByRole("button", { name: "Go ahead" }).waitFor(T);
    await page.getByRole("button", { name: "No thanks" }).click();
    await page.getByRole("button", { name: "Decide: Rename the e2e repo", exact: true }).waitFor({ state: "detached", ...T });
  });

  await step("suspected stall is invisible; coordinator confirmation creates a Needs you card, working clears it", async () => {
    const quiet = sim.start("e2e-quiet", { cwd: "/sim/e2e-quiet", status: "busy" });
    const sid = `claude:${quiet.sessionId}`;
    const timestamp = new Date(Date.now() - 11 * 60_000).toISOString();
    writeFileSync(quiet.transcript, [
      { uuid: "quiet-user", timestamp, type: "user", message: { role: "user", content: "Fetch the API job" }, origin: { kind: "human" } },
      { uuid: "quiet-tool", timestamp, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", id: "quiet-call", input: { command: "curl https://example.test/job" } }] } },
    ].map(r => JSON.stringify(r)).join("\n") + "\n");
    const coordTok = readFileSync(join(configDir, "coordinator-token"), "utf8").trim();
    const tool = async (name: string, args = {}) => {
      const r: any = await (await api(`/api/coordinator/tool/${name}`, args, coordTok)).json();
      if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r)}`);
      return r.result;
    };
    let event: any;
    for (let i = 0; i < 8 && !event; i++) {
      const u = await tool("get_updates", { waitSeconds: 2 });
      event = u.events.find((e: any) => e.kind === "stall_suspected" && e.sessionId === sid);
    }
    if (!event || event.data.silentForMs < 10 * 60_000 || !event.data.lastStep.includes("curl")) throw new Error(`missing stall payload: ${JSON.stringify(event)}`);
    const row = page.locator(`[data-session-id="${sid}"]`);
    await row.waitFor(T);
    if ((await row.innerText()).includes("Stalled")) throw new Error("suspected stall shows a status warning");
    const before: any[] = await (await page.request.get(`${base}/api/attention`)).json();
    if (before.some(i => i.sessionId === sid && i.status === "open")) throw new Error("suspicion raised attention");
    const detail = await tool("get_session", { sessionId: sid });
    if (detail.canRequestCheckpoint) throw new Error("simulated session is observe-only");
    const reason = "The API credential expired and the worker cannot proceed.";
    const suggestedAction = "Reply to the worker with the renewed credential.";
    await tool("report_stall", { sessionId: sid, checkId: detail.stallCheck.id, status: "stuck", reason, suggestedAction });
    const needs = page.getByRole("region", { name: "Needs you", exact: true });
    const card = needs.locator("[data-needs-you-id]", { hasText: suggestedAction });
    await card.locator("button[aria-expanded]").click();
    await needs.getByText(reason, { exact: true }).waitFor(T);
    await needs.getByText(`Suggested action: ${suggestedAction}`, { exact: true }).waitFor(T);
    if ((await row.innerText()).includes("Stalled")) throw new Error("confirmed stall became a status icon");
    await tool("report_stall", { sessionId: sid, checkId: detail.stallCheck.id, status: "working", reason: "The API recovered; work can continue." });
    await page.getByText(reason, { exact: true }).waitFor({ state: "detached", ...T });
  });

  await step("no console errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.join(" | "));
  });
  await step("What's happening: desktop groups, status icons, session links and one-tap stop", () => happeningChecks(browser, 1440));
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
