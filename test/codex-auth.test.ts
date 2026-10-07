// The Codex coordinator's private CODEX_HOME and its pinned CLI version, with temp dirs only:
// never the real ~/.codex or the live daemon's data directory.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodexRuntime, codexHomeCleanup, syncCodexAuth } from "../src/daemon/coordinator/codex-runtime.ts";
import { CODEX_VERSION } from "../src/daemon/coordinator/codex-config.ts";
import { CoordinatorAgent, type CoordinatorDeps } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import type { RuntimeLike } from "../src/daemon/coordinator/runtime.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { Store } from "../src/daemon/db.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
function dir() {
  const sandbox = resolve(import.meta.dir, "../.sandbox");
  mkdirSync(sandbox, { recursive: true });
  const d = mkdtempSync(join(sandbox, "codex-auth-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
/** A user CODEX_HOME with a login, and a private coordinator home linked to it, as launchCodex makes them. */
function homes() {
  const base = dir(), user = join(base, "user-codex"), mine = join(base, "coordinator-codex");
  mkdirSync(user); mkdirSync(mine);
  writeFileSync(join(user, "auth.json"), '{"refresh_token":"old"}', { mode: 0o600 });
  const past = Date.now() / 1000 - 3600;
  utimesSync(join(user, "auth.json"), past, past);
  symlinkSync(join(user, "auth.json"), join(mine, "auth.json"));
  return { user, mine, real: join(user, "auth.json"), temp: join(mine, "auth.json") };
}
/** What Codex does on a token refresh: replace the link with a real file holding the rotated token. */
function refresh(temp: string, token = "rotated") {
  rmSync(temp);
  writeFileSync(temp, `{"refresh_token":"${token}"}`, { mode: 0o600 });
}

test("an untouched link changes nothing; a refreshed login is copied back atomically, owner-only", () => {
  const h = homes();
  expect(syncCodexAuth(h.mine, h.user)).toBe(false);
  expect(readFileSync(h.real, "utf8")).toContain("old");
  refresh(h.temp);
  chmodSync(h.real, 0o644); // whatever the user's file had, the copy is 0600
  expect(syncCodexAuth(h.mine, h.user)).toBe(true);
  expect(readFileSync(h.real, "utf8")).toBe('{"refresh_token":"rotated"}');
  expect(lstatSync(h.real).isFile()).toBe(true);
  expect(statSync(h.real).mode & 0o777).toBe(0o600);
  expect(syncCodexAuth(h.mine, h.user)).toBe(false); // already the same
});

test("a login the user refreshed elsewhere afterwards is never overwritten", () => {
  const h = homes();
  refresh(h.temp);
  const past = Date.now() / 1000 - 600;
  utimesSync(h.temp, past, past);
  writeFileSync(h.real, '{"refresh_token":"newer-from-the-users-codex"}', { mode: 0o600 });
  expect(syncCodexAuth(h.mine, h.user)).toBe(false);
  expect(readFileSync(h.real, "utf8")).toContain("newer-from-the-users-codex");
});

test("cleanup saves a refreshed login before deleting the private home, and only once", () => {
  const h = homes();
  const done = codexHomeCleanup(h.mine, h.user);
  refresh(h.temp, "rotated-before-exit");
  done();
  expect(existsSync(h.mine)).toBe(false);
  expect(readFileSync(h.real, "utf8")).toContain("rotated-before-exit");
  done(); // idempotent: the exit handler may call it again
  expect(readFileSync(h.real, "utf8")).toContain("rotated-before-exit");
});

test("stopping the runtime saves the login right away (the daemon may exit next)", async () => {
  const d = dir();
  let synced = 0;
  const proc = Bun.spawn(["sleep", "30"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  cleanup.push(() => proc.kill());
  const rt = new CodexRuntime({ provider: "codex", model: "gpt-6.1-sol", effort: "high" }, [], 0, () => ({ proc, cwd: d, syncAuth: () => { synced++; } }));
  rt.start();
  rt.stop();
  expect(synced).toBe(1);
  await proc.exited;
});

test("an unsupported Codex CLI fails with a message that says what is installed, what is needed and what to do", () => {
  const d = dir(), bin = join(d, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\necho codex-cli 9.9.9\n", { mode: 0o755 });
  const script = `import { CodexRuntime } from ${JSON.stringify(resolve(import.meta.dir, "../src/daemon/coordinator/codex-runtime.ts"))};
try { new CodexRuntime({ provider: "codex", model: "gpt-6.1-sol", effort: "high" }, [], 0).start(); console.log("STARTED"); }
catch (e) { console.log(e.message); }`;
  const p = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: d, SB_DATA_DIR: join(d, "data"), SB_CONFIG_DIR: join(d, "config"), SB_CODEX_HOME: join(d, "codex"), SB_CLAUDE_HOME: join(d, "claude") }, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString();
  expect(out).not.toContain("STARTED");
  expect(out).toContain(`runs only on ${CODEX_VERSION}`);
  expect(out).toContain("installed: codex-cli 9.9.9");
  expect(out).toContain("switch the coordinator to Claude");
});

class FailingRuntime implements RuntimeLike {
  running = false; busy = false; fail = true;
  onText = () => {}; onResult: RuntimeLike["onResult"] = () => {}; onExit = () => {};
  start() { if (this.fail) throw new Error(`The Codex coordinator runs only on ${CODEX_VERSION} (installed: codex-cli 9.9.9).`); this.running = true; }
  stop() { this.running = false; }
  send() { return this.running; }
}

test("a coordinator that can't start says why in its state (the UI shows it) and in the restart error", () => {
  const store = new Store("", ":memory:");
  cleanup.push(() => store.db.close());
  const pushed: any[] = [];
  const deps: CoordinatorDeps = { db: store.db, coordination: new Coordination(store), cfg: mergeCoordinatorConfig({ provider: "codex" }), sessions: () => new Map(), events: () => [],
    send: async () => ({ ok: true }), launch: async () => "x", escalate: () => {}, push: (s) => pushed.push(s), timers: false };
  const agent = new CoordinatorAgent(deps);
  const rt = new FailingRuntime();
  agent.setRuntime(rt);
  agent.setMode("active");
  expect(() => agent.restartRuntime()).toThrow(/could not start: The Codex coordinator runs only on/);
  expect(agent.state().runtimeError).toContain("installed: codex-cli 9.9.9");
  expect(pushed.at(-1)?.runtimeError).toContain("codex-cli 9.9.9");
  rt.fail = false;
  agent.restartRuntime();
  expect(agent.state().runtimeError).toBeNull();
});
