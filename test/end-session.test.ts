// Real throwaway processes + adapter fixtures. Never signals a user's session or changes git.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Session } from "../src/shared/types.ts";
import type { Adapter, Discovered } from "../src/daemon/adapters/types.ts";
import { coordinatorAllowed } from "../src/daemon/auth.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { Store } from "../src/daemon/db.ts";
import { Messenger } from "../src/daemon/messaging.ts";
import { startHttp, type HttpDeps } from "../src/daemon/http.ts";
import { readStat } from "../src/daemon/proc.ts";
import { Registry } from "../src/daemon/registry.ts";
import { SessionResumer, resumeCommand } from "../src/daemon/resume.ts";
import { blankSession } from "../src/daemon/state.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });
const cfg = { port: 0, longRunMs: 0, stalledMs: 600_000, endedRetentionMs: 3600_000, notifyDesktop: false, notifyFinished: false, notifyIgnore: [], modelClassifier: false, autoContinue: { enabled: false, graceMs: 0, maxConsecutive: 0, typingHoldMs: 0, offProjects: [] } };

async function rig(provider: "claude" | "codex", mode: "quit" | "term" | "kill" = "quit", execution: Session["execution"] = "idle") {
  const sandbox = join(import.meta.dir, "../.sandbox");
  mkdirSync(sandbox, { recursive: true });
  const dir = mkdtempSync(join(sandbox, "lifecycle-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(process.execPath, join(dir, provider));
  const transcriptPath = join(dir, provider === "codex" ? "rollout-conversation.jsonl" : "conversation.jsonl");
  writeFileSync(join(dir, "agent.js"), `
    const { writeFileSync, appendFileSync, openSync } = require('node:fs');
    openSync(${JSON.stringify(transcriptPath)}, 'a');
    process.on('SIGTERM', () => { appendFileSync('signals', 'TERM\\n'); ${mode === "kill" ? "" : "process.exit(0);"} });
    process.stdin.on('data', () => { ${mode === "quit" ? "process.exit(0);" : ""} });
    writeFileSync('ready', 'yes');
    setInterval(() => {}, 1000);
  `);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const start = async () => {
    rmSync(join(dir, "ready"), { force: true });
    const p = Bun.spawn([join(dir, provider), join(dir, "agent.js")], { cwd: dir, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    children.push(p);
    for (let i = 0; i < 100; i++) {
      if (await Bun.file(join(dir, "ready")).exists()) return p;
      await Bun.sleep(10);
    }
    throw new Error("fixture did not start");
  };
  cleanup.push(async () => { for (const p of children) { p.kill("SIGKILL"); await p.exited; } });
  let proc = await start();
  const s: Session = { ...blankSession(`${provider}:conversation`, provider, "tui", "conversation"), cwd: dir, transcriptPath, execution, pid: proc.pid, pidConfidence: "confirmed", firstPrompt: "Keep my work", meta: { processStartTime: readStat(proc.pid)!.startTime } };
  const store = new Store("", ":memory:");
  const coordination = new Coordination(store);
  const discovered = (): Discovered => ({ ...s, pid: proc.pid, pidConfidence: "confirmed", liveStatus: { execution: "idle", confidence: "confirmed" }, meta: {} });
  const adapter: Adapter = { provider, initialTranscriptBytes: 1024, claimedPids: () => new Set(), parse: () => ({ events: [] }), discover: async () => readStat(proc.pid) && proc.exitCode === null ? [discovered()] : [] };
  const registry = new Registry([adapter], store, cfg);
  registry.sessions.set(s.id, s);
  cleanup.push(() => { registry.stop(); store.db.close(); });
  const typed: string[] = [];
  let interrupts = 0;
  const m = new Messenger(store, registry, { onReceipt: null, interrupt: async () => { interrupts++; return { outcome: "accepted" }; }, unsubscribe: async () => {} } as any, { owns: () => false } as any, () => {});
  m.endWaitMs = 50;
  m.endSignalWaitMs = 100;
  m.terminal = {
    canSend: (s) => s.pidConfidence === "confirmed" && s.pid === proc.pid,
    send: async (_s, text) => { typed.push(text); (proc.stdin as import("bun").FileSink).write("quit\n"); return { ok: true }; },
    interrupt: async () => { interrupts++; return { ok: true }; },
  };
  m.onEnded = (id) => coordination.releaseSessionClaims(id);
  const claim = coordination.claim(s.id, "port:4999");
  const launches: { cwd: string; command: string }[] = [];
  const bridge = { launch: async (cwd: string, _name: string, command: string) => {
    launches.push({ cwd, command });
    proc = await start();
    return { ok: true, data: { terminalId: "fixture" } };
  } };
  const resumer = new SessionResumer(registry, bridge);
  resumer.waitMs = 500;
  return { s, m, registry, adapter, coordination, claim, store, typed, dir, launches, resumer, bridge, proc: () => proc, interrupts: () => interrupts, discovered };
}

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: quit, persist ended, release claims, then resume the same conversation and cwd once`, async () => {
    const x = await rig(provider);
    const oldPid = x.proc().pid;
    expect(await x.m.end(x.s.id)).toMatchObject({ ok: true, how: "typed the exit command" });
    expect(x.typed).toEqual([provider === "codex" ? "/quit" : "/exit"]);
    expect(await x.proc().exited).toBe(0);
    expect(x.s.execution).toBe("ended");
    expect(x.store.loadSessions()[0].execution).toBe("ended");
    expect(x.coordination.claims()).toHaveLength(0);
    expect(x.s.sendMethods).toEqual([]);
    const [a, b] = await Promise.all([x.resumer.resume(x.s.id), x.resumer.resume(x.s.id)]);
    expect(a.ok && b.ok).toBe(true);
    expect(x.launches).toEqual([{ cwd: x.dir, command: provider === "claude" ? "claude --resume 'conversation'" : "codex resume 'conversation'" }]);
    expect(x.s.execution).toBe("idle");
    expect(x.s.pid).not.toBe(oldPid);
    expect(x.s.nativeId).toBe("conversation");
    expect(x.s.cwd).toBe(x.dir);
    expect(x.s.endedAt).toBeNull();
    expect(x.s.meta.closedProcess).toBeUndefined();
    expect((await x.m.end(x.s.id)).ok).toBe(true); // resumed session can be ended again
  });

  test(`${provider}: authenticated HTTP End and Resume use the real registry and release claims`, async () => {
    const x = await rig(provider);
    // Manually started sessions may have an incorrect inferred PID. Only the open file
    // identifies the real target; neither the guess nor its cached start time may be used.
    x.s.pidConfidence = "inferred";
    x.s.pid = process.pid;
    x.s.meta.processStartTime = readStat(process.pid)!.startTime;
    const deps = { port: 0, token: "lifecycle-root", coordinatorToken: "lifecycle-coordinator", registry: x.registry, store: x.store, messenger: x.m, bridge: x.bridge, coordination: x.coordination } as HttpDeps;
    const { server } = startHttp(deps);
    deps.port = server.port!;
    cleanup.push(() => { server.stop(true); });
    const base = `http://127.0.0.1:${server.port}/api`;
    const action = (what: string, token = deps.token) => fetch(`${base}/sessions/${encodeURIComponent(x.s.id)}/${what}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect((await action("end", deps.coordinatorToken)).status).toBe(403);
    expect((await action("end")).status).toBe(200);
    expect(await x.proc().exited).toBe(0);
    expect(x.typed).toEqual([provider === "codex" ? "/quit" : "/exit"]);
    const ended = await fetch(`${base}/sessions`, { headers: { authorization: `Bearer ${deps.token}` } }).then((r) => r.json()) as Session[];
    expect(ended[0].execution).toBe("ended");
    expect(ended[0].pid).toBe(x.proc().pid);
    expect(ended[0].pidConfidence).toBe("confirmed");
    expect(x.coordination.claims()).toHaveLength(0);
    expect((await action("resume", deps.coordinatorToken)).status).toBe(403);
    expect(await (await action("resume")).json()).toMatchObject({ ok: true });
    expect(x.s.execution).toBe("idle");
    expect(x.launches).toHaveLength(1);
  });

  test(`${provider}: unmatched inferred session returns an HTTP reason and preserves the process and claims`, async () => {
    const x = await rig(provider);
    x.s.pidConfidence = "inferred";
    x.s.transcriptPath = join(x.dir, "not-open.jsonl");
    const deps = { port: 0, token: "lifecycle-root", registry: x.registry, store: x.store, messenger: x.m, bridge: x.bridge, coordination: x.coordination } as HttpDeps;
    const { server } = startHttp(deps);
    deps.port = server.port!;
    cleanup.push(() => { server.stop(true); });
    const r = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${encodeURIComponent(x.s.id)}/end`, { method: "POST", headers: { authorization: `Bearer ${deps.token}` } });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: `No ${provider} process in this folder has this session's transcript open; nothing was ended.` });
    expect(x.proc().exitCode).toBeNull();
    expect(x.typed).toEqual([]);
    expect(x.coordination.claims()).toHaveLength(1);
  });

  test(`${provider}: inferred session without a terminal or PID uses its transcript, verifies TERM`, async () => {
    const x = await rig(provider, "term");
    x.s.pidConfidence = "inferred";
    x.s.pid = null;
    x.m.terminal = null;
    expect(await x.m.end(x.s.id)).toMatchObject({ ok: true, how: "ended with SIGTERM" });
    expect(x.typed).toEqual([]);
    expect(await x.proc().exited).toBe(0);
    expect(x.s.execution).toBe("ended");
  });

  test(`${provider}: wait for TERM, then KILL only when TERM is ignored; keep staged and untracked work`, async () => {
    const x = await rig(provider, "kill");
    x.s.pidConfidence = "inferred";
    spawnSync("git", ["init", "-q", x.dir]);
    writeFileSync(join(x.dir, "tracked"), "staged work\n");
    spawnSync("git", ["-C", x.dir, "add", "tracked"]);
    writeFileSync(join(x.dir, "tracked"), "unstaged work\n");
    writeFileSync(join(x.dir, "untracked"), "new work\n");
    const status = () => spawnSync("git", ["-C", x.dir, "status", "--porcelain", "--", "tracked", "untracked"], { encoding: "utf8" }).stdout;
    const before = status();
    const promise = x.m.end(x.s.id);
    expect(x.coordination.claims()).toHaveLength(1); // no early release
    expect((await promise).how).toContain("SIGKILL");
    expect(await x.proc().exited).not.toBe(0);
    expect(readFileSync(join(x.dir, "signals"), "utf8")).toBe("TERM\n");
    expect(status()).toBe(before);
    expect(readFileSync(join(x.dir, "tracked"), "utf8")).toBe("unstaged work\n");
    expect(readFileSync(join(x.dir, "untracked"), "utf8")).toBe("new work\n");
    expect(x.coordination.claims()).toHaveLength(0);
  });

  test(`${provider}: working turn interrupted; uncertain terminal delivery still falls back to TERM`, async () => {
    const x = await rig(provider, "term", "working");
    x.m.terminal!.send = async () => ({ ok: false, error: "bridge timeout" });
    const [a, b] = await Promise.all([x.m.end(x.s.id), x.m.end(x.s.id)]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: true, how: "ended with SIGTERM" });
    expect(x.interrupts()).toBe(1);
    expect(await x.proc().exited).toBe(0);
  });

  test(`${provider}: stale discovery and late hooks do not revive a confirmed close`, async () => {
    const x = await rig(provider);
    const old = x.discovered();
    await x.m.end(x.s.id);
    x.adapter.discover = async () => [old];
    await x.registry.tick();
    x.registry.update(x.s.id, (s) => { s.execution = "idle"; });
    x.registry.ingest(x.s.id, [{ sessionId: x.s.id, type: "turn_started", ts: Date.now(), data: {}, sourceId: "late" }]);
    expect(x.s.execution).toBe("ended");
  });

  test(`${provider}: failed resume can retry, uncertain launch never duplicates, missing cwd refused`, async () => {
    const x = await rig(provider);
    await x.m.end(x.s.id);
    let attempts = 0;
    let outcome = { ok: false, error: "no VS Code window is connected" };
    const r = new SessionResumer(x.registry, { launch: async () => { attempts++; return outcome; } });
    r.waitMs = 1;
    expect((await r.resume(x.s.id)).ok).toBe(false);
    outcome = { ok: false, error: "bridge timeout" };
    await r.resume(x.s.id);
    await r.resume(x.s.id);
    expect(attempts).toBe(2);
    expect(x.s.execution).toBe("ended");
    x.s.cwd = join(x.dir, "missing");
    await expect(r.resume(x.s.id)).rejects.toThrow("no longer exists");
  });
}

test("missing transcript, a reused pid, and unrelated processes are never signalled", async () => {
  const x = await rig("codex");
  x.s.pidConfidence = "inferred";
  x.s.transcriptPath = null;
  await expect(x.m.end(x.s.id)).rejects.toThrow("no transcript path");
  x.s.pidConfidence = "confirmed";
  x.s.meta.processStartTime = -1;
  await expect(x.m.end(x.s.id)).rejects.toThrow("changed");
  x.s.meta.processStartTime = readStat(process.pid)!.startTime;
  x.s.pid = process.pid;
  await expect(x.m.end(x.s.id)).rejects.toThrow("not the session's agent");
  expect(x.typed).toEqual([]);
  expect(x.coordination.claims()).toHaveLength(1);
});

test("resume shell-quotes conversation IDs; coordinator credential cannot end or resume", () => {
  const s = blankSession("x", "codex", "tui", "id'$(touch nope)");
  expect(resumeCommand(s)).toBe("codex resume 'id'\\''$(touch nope)'");
  for (const action of ["end", "resume"]) expect(coordinatorAllowed("POST", ["api", "sessions", "x", action])).toBe(false);
});


test("automatic ending refuses before input when its guard changes", async () => {
  const x = await rig("claude", "term", "working");
  await expect(x.m.end(x.s.id, async () => "a new turn started")).rejects.toThrow(/auto-end cancelled/);
  expect(x.interrupts()).toBe(0);
  expect(x.typed).toEqual([]);
  expect(x.proc().exitCode).toBeNull();
  expect(x.coordination.claims()).toHaveLength(1);
});

test("automatic ending rechecks after terminal wait before TERM", async () => {
  const x = await rig("codex", "term");
  await expect(x.m.end(x.s.id, async () => x.typed.length ? "user is typing" : null)).rejects.toThrow(/user is typing/);
  expect(x.typed).toEqual(["/quit"]);
  expect(x.proc().exitCode).toBeNull();
  expect(x.coordination.claims()).toHaveLength(1);
  expect(await Bun.file(join(x.dir, "signals")).exists()).toBe(false);
});

test("automatic ending rechecks after TERM before KILL", async () => {
  const x = await rig("codex", "kill");
  x.m.terminal = null;
  await expect(x.m.end(x.s.id, async () => await Bun.file(join(x.dir, "signals")).exists() ? "protected now" : null)).rejects.toThrow(/protected now/);
  expect(x.proc().exitCode).toBeNull();
  expect(x.coordination.claims()).toHaveLength(1);
  expect(readFileSync(join(x.dir, "signals"), "utf8")).toBe("TERM\n");
});
