import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BridgeHub, shq } from "../src/daemon/bridge.ts";
import { readStat } from "../src/daemon/proc.ts";
import { blankSession } from "../src/daemon/state.ts";
import { Store } from "../src/daemon/db.ts";
import { Messenger } from "../src/daemon/messaging.ts";
import { Registry } from "../src/daemon/registry.ts";
import type { Adapter } from "../src/daemon/adapters/types.ts";
import type { Session } from "../src/shared/types.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function dir() {
  const base = join(import.meta.dir, "../.sandbox");
  mkdirSync(base, { recursive: true });
  const d = mkdtempSync(join(base, "terminal-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const runner = join(import.meta.dir, "../src/daemon/managed-terminal.py");
function guardCall(fn: string, args: unknown[]) {
  const r = spawnSync("python3", ["-c", "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('runner',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(getattr(m,sys.argv[2])(*json.loads(sys.argv[3]))))", runner, fn, JSON.stringify(args)], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}
const terminalIdentity = (pid: number, root: string) => guardCall("terminal_identity", [pid, root]);
const terminalExitBlocker = (identity: unknown, root: string) => guardCall("terminal_exit_blocker", [identity, root]);
async function until(fn: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!fn() && Date.now() < deadline) await Bun.sleep(20);
  expect(fn()).toBe(true);
}

function procFixture() {
  const root = dir();
  function add(pid: number, tty = 99, startTime = pid, ppid = 1, state = "S") {
    const base = join(root, String(pid));
    mkdirSync(join(base, "fd"), { recursive: true });
    const f = Array(22).fill("0");
    Object.assign(f, { 0: state, 1: String(ppid), 4: String(tty), 19: String(startTime) });
    writeFileSync(join(base, "stat"), `${pid} (fixture) ${f.join(" ")}`);
  }
  add(100);
  symlinkSync("/dev/pts/999", join(root, "100/fd/0"));
  const id = terminalIdentity(100, root)!;
  return { root, add, id, check: () => terminalExitBlocker(id, root) };
}

test("fresh liveness: idle agent, reparented command and direct child all retain the tab", () => {
  for (const kind of ["agent", "reparented", "child"]) {
    const x = procFixture();
    expect(x.check()).toBeNull();
    x.add(200, kind === "child" ? 0 : 99, 200, kind === "child" ? 100 : 1);
    expect(x.check()).toMatch(/another process/);
    rmSync(join(x.root, "200"), { recursive: true });
    expect(x.check()).toBeNull();
    expect(x.check()).toBeNull();
  }
});

test("stale root identity, missing PTY, malformed and unreadable proc evidence fail closed", () => {
  const x = procFixture();
  x.add(100, 99, 999);
  expect(x.check()).toBe("terminal identity changed");
  x.add(100);
  x.add(200, 0);
  writeFileSync(join(x.root, "200/stat"), "unparseable");
  expect(x.check()).toBe("could not verify terminal liveness");
  x.add(200, 0);
  rmSync(join(x.root, "200/stat"));
  mkdirSync(join(x.root, "200/stat"));
  expect(x.check()).toBe("could not verify terminal liveness");
  rmSync(join(x.root, "100/fd/0"));
  expect(x.check()).toBe("terminal identity changed");
  expect(terminalIdentity(100, x.root)).toBeNull();
});

test("zombies and unrelated processes do not hold the terminal; a recycled peer PID is freshly inspected", () => {
  const x = procFixture();
  x.add(200, 99, 200, 1, "Z");
  x.add(300, 55);
  expect(x.check()).toBeNull();
  x.add(200, 99, 201);
  expect(x.check()).toMatch(/another process/);
});

async function pty(command: string, launchId = crypto.randomUUID(), cwd = process.cwd()) {
  const p = Bun.spawn(["python3", join(import.meta.dir, "fixtures/managed-pty.py"), Bun.which("python3")!, runner, launchId, command], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const events: any[] = [];
  let buffered = "";
  const reading = (async () => {
    for await (const data of p.stdout) {
      buffered += Buffer.from(data).toString();
      let i;
      while ((i = buffered.indexOf("\n")) >= 0) {
        events.push(JSON.parse(buffered.slice(0, i)));
        buffered = buffered.slice(i + 1);
      }
    }
  })();
  cleanup.push(async () => { p.stdin.end(); await p.exited; await reading; });
  await until(() => !!events[0]?.pid);
  return { pid: events[0].pid as number, launchId, p, events, input: (input: string) => p.stdin.write(JSON.stringify({ input }) + "\n") };
}

for (const provider of ["claude", "codex"] as const) {
  for (const automatic of [false, true]) test(`${provider}: ${automatic ? "auto-end" : "manual End"} and repeated launches exit their own PTY; idle is retained`, async () => {
    const d = dir();
    symlinkSync(process.execPath, join(d, provider));
    const transcript = join(d, "conversation.jsonl");
    const ready = join(d, "ready");
    writeFileSync(join(d, "agent.js"), `
      const fs = require('node:fs');
      fs.openSync(${JSON.stringify(transcript)}, 'a');
      process.stdin.on('data', (data) => { if (data.toString().includes(${JSON.stringify(provider === "codex" ? "/quit" : "/exit")})) process.exit(0); });
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      setInterval(() => {}, 1000);
    `);
    writeFileSync(transcript, "preserved transcript\n");
    writeFileSync(join(d, "uncommitted"), "work in progress");
    for (let cycle = 0; cycle < 3; cycle++) {
      rmSync(ready, { force: true });
      const t = await pty(`${shq(join(d, provider))} ${shq(join(d, "agent.js"))}`, crypto.randomUUID(), d);
      await until(() => Bun.file(ready).size > 0);
      const agent = Number(readFileSync(ready, "utf8"));
      const s = { ...blankSession(`${provider}:conversation`, provider, "tui", "conversation"), execution: "idle" as const, cwd: d, transcriptPath: transcript, pid: agent, pidConfidence: "confirmed" as const, meta: { processStartTime: readStat(agent)!.startTime } };
      const store = new Store("", ":memory:");
      cleanup.push(() => store.db.close());
      const registry = { sessions: new Map([[s.id, s]]), confirmEnded: () => { s.execution = "ended" as any; } };
      const m = new Messenger(store, registry as any, { onReceipt: null } as any, { owns: () => false } as any, () => {});
      m.endWaitMs = 1000;
      m.terminal = { canSend: () => true, send: async (_s, text) => (t.input(text + "\n"), { ok: true }), interrupt: async () => ({ ok: true }) };
      await Bun.sleep(100);
      expect(t.events.some((e) => "exit" in e)).toBe(false);
      expect(readStat(agent)).not.toBeNull();
      // Reflect keeps this fixture compatible with fd31e472's older one-argument signature.
      expect((await Reflect.apply(m.end, m, [s.id, automatic ? async () => null : undefined])).ok).toBe(true);
      await until(() => t.events.some((e) => e.exit === 0));
      expect(await t.p.exited).toBe(0);
      expect(readStat(t.pid)).toBeNull();
      expect(readFileSync(transcript, "utf8")).toBe("preserved transcript\n");
      expect(readFileSync(join(d, "uncommitted"), "utf8")).toBe("work in progress");
    }
  });
}

for (const detached of [false, true]) test(`a real ${detached ? "double-forked detached" : "attached"} command keeps the PTY alive after agent exit`, async () => {
  const d = dir();
  const extra = join(d, "extra");
  writeFileSync(join(d, "agent.js"), `
    const child = Bun.spawn(['sleep', '30'], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    require('node:fs').writeFileSync(${JSON.stringify(extra)}, String(child.pid));
    process.exit(0);
  `);
  writeFileSync(join(d, "agent.py"), `
import os, time
if os.fork() == 0:
    os.setsid()
    if os.fork() == 0:
        with open(${JSON.stringify(extra)}, 'w') as f: f.write(str(os.getpid()))
        time.sleep(30)
    os._exit(0)
os._exit(0)
`);
  const command = detached ? `python3 ${shq(join(d, "agent.py"))}` : `${shq(process.execPath)} ${shq(join(d, "agent.js"))}`;
  const t = await pty(command);
  await until(() => Bun.file(extra).size > 0);
  const pid = Number(readFileSync(extra, "utf8"));
  const startTime = readStat(pid)!.startTime;
  cleanup.push(() => { if (readStat(pid)?.startTime === startTime) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  await until(() => t.events.some((e) => e.output?.includes("keeping this terminal")));
  t.input(`touch ${shq(join(d, "must-not-exist"))}\n`);
  await Bun.sleep(100);
  expect(t.events.some((e) => "exit" in e)).toBe(false);
  expect(await Bun.file(join(d, "must-not-exist")).exists()).toBe(false);
  process.kill(pid, "SIGTERM");
  await until(() => t.events.some((e) => e.exit === 0));
});

test("End's Ctrl-C cannot kill the terminal owner while its agent remains live", async () => {
  const d = dir(), ready = join(d, "ready"), caught = join(d, "caught");
  writeFileSync(join(d, "agent.js"), `
    const fs = require('node:fs');
    process.on('SIGINT', () => fs.writeFileSync(${JSON.stringify(caught)}, 'caught'));
    process.stdin.on('data', () => process.exit(0));
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);
  `);
  const t = await pty(`${shq(process.execPath)} ${shq(join(d, "agent.js"))}`);
  await until(() => existsSync(ready));
  t.input("\x03");
  await until(() => existsSync(caught));
  expect(t.events.some((e) => "exit" in e)).toBe(false);
  t.input("quit\n");
  await until(() => t.events.some((e) => e.exit === 0));
});

test("bridge refuses unsupported extensions and never sends generic dispose or shell-exit requests", async () => {
  const hub = new BridgeHub(dir());
  const requests: any[] = [];
  const ws = { send: (raw: string) => {
    const m = JSON.parse(raw); requests.push(m);
    hub.message(ws, JSON.stringify({ type: "result", reqId: m.reqId, ok: true, data: { terminalId: `managed-${m.launchId}` } }));
  } };
  hub.open(ws);
  hub.message(ws, JSON.stringify({ type: "hello", windowId: "test" }));
  expect((await hub.launch("/unused", "a", "claude")).error).toContain("managed-terminal-v1");
  expect(requests).toEqual([]);
  hub.message(ws, JSON.stringify({ type: "hello", windowId: "test", capabilities: ["managed-terminal-v1"] }));
  for (let i = 0; i < 3; i++) expect((await hub.launch("/unused", "same title", "claude --resume 'conversation'")).ok).toBe(true);
  expect(new Set(requests.map((r) => r.launchId)).size).toBe(3);
  expect(requests.every((r) => r.type === "createManaged" && r.runner === runner)).toBe(true);
});

test("session mapping rejects duplicate attachments, stale session identity and forged managed ownership", async () => {
  const d = dir();
  const id = crypto.randomUUID();
  writeFileSync(join(d, "launched-terminals.json"), JSON.stringify([`managed-${id}`]));
  const t = await pty("sleep 30", id);
  const hub = new BridgeHub(d);
  const ws = { send: () => {} };
  hub.open(ws);
  const s = { ...blankSession("x", "claude", "tui", "x"), pid: t.pid, execution: "idle" as const, pidConfidence: "confirmed" as const, meta: { processStartTime: readStat(t.pid)!.startTime } };
  const terminal = { id: `managed-${id}`, name: "user renamed this", processId: t.pid, launchId: id };
  const report = (terminals: any[]) => hub.message(ws, JSON.stringify({ type: "terminals", terminals }));
  report([terminal]);
  expect(hub.terminalFor(s)?.t.id).toBe(terminal.id);
  report([terminal, terminal]);
  expect(hub.terminalFor(s)).toBeNull();
  report([{ ...terminal, launchId: crypto.randomUUID() }]);
  expect(hub.terminalFor(s)).toBeNull();
  report([terminal]);
  s.meta.processStartTime++;
  expect(hub.terminalFor(s)).toBeNull();
});

// The verified End/Resume commit is a separate integration dependency, not copied here.
// This additional real-PTY test runs when that commit is composed with this branch.
const resumePath = join(import.meta.dir, "../src/daemon/resume.ts");
for (const provider of ["claude", "codex"] as const) test.skipIf(!existsSync(resumePath))(`${provider}: fd31e472 one-tap Resume with the real bridge and PTY never accumulates terminals`, async () => {
  const { SessionResumer } = await import(resumePath);
  const d = dir(), ready = join(d, "ready"), transcript = join(d, "conversation.jsonl");
  symlinkSync(process.execPath, join(d, provider));
  writeFileSync(transcript, "transcript stays\n");
  writeFileSync(join(d, "agent.js"), `
    const fs = require('node:fs');
    fs.openSync(${JSON.stringify(transcript)}, 'a');
    process.on('SIGINT', () => {});
    process.stdin.on('data', data => { if (data.toString().includes(${JSON.stringify(provider === "codex" ? "/quit" : "/exit")})) process.exit(0); });
    fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    setInterval(() => {}, 1000);
  `);
  let current: Awaited<ReturnType<typeof pty>>, pid = 0, launches = 0;
  const hub = new BridgeHub(d);
  const commands: string[] = [];
  const ws = { send: (raw: string) => { void (async () => {
    const msg = JSON.parse(raw);
    if (msg.type === "createManaged") {
      commands.push(msg.command);
      if (current) expect(current.events.some((e) => e.exit === 0)).toBe(true);
      rmSync(ready, { force: true });
      current = await pty(`${shq(join(d, provider))} ${shq(join(d, "agent.js"))}`, msg.launchId, msg.cwd);
      launches++;
      await until(() => existsSync(ready));
      pid = Number(readFileSync(ready, "utf8"));
      hub.message(ws, JSON.stringify({ type: "terminals", terminals: [{ id: `managed-${msg.launchId}`, launchId: msg.launchId, processId: current.pid, name: "renamed by user" }] }));
      hub.message(ws, JSON.stringify({ type: "result", reqId: msg.reqId, ok: true, data: { terminalId: `managed-${msg.launchId}`, processId: current.pid } }));
    } else {
      expect(msg.type).toBe("sendText");
      // Normalize bracketed paste just as a TUI does; retain the actual bridge's guarded sends.
      current.input(String(msg.text).replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", ""));
      hub.message(ws, JSON.stringify({ type: "result", reqId: msg.reqId, ok: true }));
    }
  })(); } };
  hub.open(ws);
  hub.message(ws, JSON.stringify({ type: "hello", windowId: "isolated", capabilities: ["managed-terminal-v1"] }));
  const s: Session = { ...blankSession(`${provider}:conversation`, provider, "tui", "conversation"), execution: "ended", cwd: d, transcriptPath: transcript };
  const store = new Store("", ":memory:");
  const adapter: Adapter = { provider, initialTranscriptBytes: 1024, claimedPids: () => new Set(), parse: () => ({ events: [] }), discover: async () => readStat(pid) ? [{ ...s, pid, pidConfidence: "confirmed", liveStatus: { execution: "idle", confidence: "confirmed" }, meta: {} }] : [] };
  const registry = new Registry([adapter], store, { stalledMs: 600000, endedRetentionMs: 3600000 } as any);
  cleanup.push(() => { registry.stop(); store.db.close(); });
  registry.sessions.set(s.id, s);
  const m = new Messenger(store, registry, { onReceipt: null } as any, { owns: () => false } as any, () => {});
  m.terminal = hub;
  m.endWaitMs = 1000;
  const resumer = new SessionResumer(registry, hub);
  resumer.waitMs = 1000;
  for (let cycle = 0; cycle < 3; cycle++) {
    const results = await Promise.all([resumer.resume(s.id), resumer.resume(s.id)]);
    expect(results.every((r: any) => r.ok)).toBe(true);
    expect(launches).toBe(cycle + 1);
    expect(s.nativeId).toBe("conversation");
    expect(s.cwd).toBe(d);
    expect(hub.canSend(s)).toBe(true);
    expect((await Reflect.apply(m.end, m, [s.id, cycle % 2 ? async () => null : undefined])).ok).toBe(true);
    await until(() => current.events.some((e) => e.exit === 0));
    expect(s.execution).toBe("ended");
    expect(readFileSync(transcript, "utf8")).toBe("transcript stays\n");
  }
  expect(commands).toEqual(Array(3).fill(provider === "claude" ? "claude --resume 'conversation'" : "codex resume 'conversation'"));
}, 15000);
