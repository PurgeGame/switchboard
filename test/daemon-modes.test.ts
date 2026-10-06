// The real daemon (src/daemon/main.ts) in each coordinator.agent mode, on a temp port with its own
// data and config directories and simulated sessions only. Never the live daemon or its files.
// The built-in mode isn't started here: switching it on would start a real model process.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { ClaudeSim } from "./sim/claude-sim.ts";

const ROOT = join(import.meta.dir, "..");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sb-daemon-modes-")));
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
  rmSync(tmp, { recursive: true, force: true });
});

let portSeq = 20_000 + Math.floor(Math.random() * 20_000);

interface Daemon {
  port: number;
  base: string;
  configDir: string;
  dataDir: string;
  env: Record<string, string>;
  proc: Subprocess;
  token: () => string;
  api: (path: string, init?: RequestInit) => Promise<Response>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
}

async function startDaemon(name: string, agent: "external" | "none", simHome: string): Promise<Daemon> {
  const port = portSeq++;
  const dir = join(tmp, name);
  const configDir = join(dir, "config");
  const dataDir = join(dir, "data");
  for (const d of [configDir, dataDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ modelClassifier: false, autoContinue: { enabled: false }, notifyDesktop: false, remoteHost: null, permissionHoldMinutes: 1, coordinator: { agent } }),
    { mode: 0o600 },
  );
  const env = { ...process.env, SB_PORT: String(port), SB_DATA_DIR: dataDir, SB_CONFIG_DIR: configDir, SB_CLAUDE_HOME: simHome, SB_CODEX_HOME: join(simHome, "codex-none") } as Record<string, string>;
  const base = `http://127.0.0.1:${port}`;
  const d: Daemon = {
    port,
    base,
    configDir,
    dataDir,
    env,
    proc: null as unknown as Subprocess,
    token: () => readFileSync(join(configDir, "token"), "utf8").trim(),
    api: (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${d.token()}`, "content-type": "application/json", ...(init.headers ?? {}) } }),
    stop: async () => {
      d.proc.kill();
      await d.proc.exited;
    },
    restart: async () => {
      await d.stop();
      await launch();
    },
  };
  const launch = async () => {
    d.proc = Bun.spawn(["bun", "src/daemon/main.ts"], { cwd: ROOT, env, stdout: Bun.file(join(dir, "daemon.log")), stderr: Bun.file(join(dir, "daemon.err")) });
    for (let i = 0; i < 150; i++) {
      if (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) return;
      await Bun.sleep(100);
    }
    throw new Error(`daemon ${name} did not start: ${readFileSync(join(dir, "daemon.err"), "utf8").slice(-2000)}`);
  };
  await launch();
  cleanups.push(() => d.stop().catch(() => {}));
  return d;
}

/** `sb mcp` over stdio, as an external agent (Claude Code, Codex) would run it. */
function mcpClient(d: Daemon, argv = ["bun", "src/cli/sb.ts", "mcp"]) {
  const proc = Bun.spawn(argv, { cwd: ROOT, env: d.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => {
    proc.kill();
  });
  const waiting = new Map<number, (m: any) => void>();
  let seq = 0;
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        waiting.get(m.id)?.(m);
      }
    }
  })();
  const call = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++seq;
      const t = setTimeout(() => reject(new Error(`mcp ${method} timed out`)), 15_000);
      waiting.set(id, (m) => (clearTimeout(t), resolve(m)));
      (proc.stdin as import("bun").FileSink).write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      (proc.stdin as import("bun").FileSink).flush();
    });
  const tool = async (name: string, args: unknown = {}) => {
    const m = await call("tools/call", { name, arguments: args });
    return { isError: !!m.result?.isError, body: JSON.parse(m.result.content[0].text), raw: m };
  };
  return { call, tool, proc };
}

const sim = new ClaudeSim(join(tmp, "sim"));
cleanups.push(() => sim.cleanup());
const project = join(tmp, "project");
mkdirSync(project);
const s = sim.start("modes-alpha", { cwd: project });
sim.turn(s, "Refactor the parser", "Parser refactored.");
const sid = `claude:${s.sessionId}`;

describe('coordinator.agent: "none"', () => {
  let d: Daemon;
  test("the daemon runs with no coordinator: every /api/coordinator route is a 404, sessions still listed", async () => {
    d = await startDaemon("none", "none", sim.home);
    for (const [method, path] of [
      ["GET", "/api/coordinator"],
      ["GET", "/api/coordinator/tools"],
      ["POST", "/api/coordinator/mode"],
      ["POST", "/api/coordinator/chat"],
      ["POST", "/api/coordinator/tool/get_state"],
    ] as const) {
      const r = await d.api(path, { method, ...(method === "POST" ? { body: JSON.stringify({ mode: "active", text: "hi" }) } : {}) });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "no coordinator configured" });
    }
    let listed = false;
    for (let i = 0; i < 50 && !listed; i++) {
      listed = ((await (await d.api("/api/sessions")).json()) as any[]).some((x) => x.id === sid);
      if (!listed) await Bun.sleep(100);
    }
    expect(listed).toBe(true);
  }, 30_000);

  test("a permission prompt is never judged: it waits for the user, who can answer it", async () => {
    const hook = d.api("/api/hook/claude/PermissionRequest?wait=1", {
      method: "POST",
      body: JSON.stringify({ session_id: s.sessionId, tool_name: "Read", tool_input: { file_path: join(project, "a.txt") }, cwd: project }),
    });
    let item: any;
    for (let i = 0; i < 50 && !item; i++) {
      item = ((await (await d.api("/api/attention")).json()) as any[]).find((x) => x.kind === "approval" && x.sessionId === sid && typeof x.meta.answerKey === "string");
      if (!item) await Bun.sleep(100);
    }
    expect(item).toBeTruthy();
    expect(item.meta.recommendation).toBeNull(); // no coordinator opinion: nobody judged it
    expect((await d.api(`/api/attention/${item.id}/answer`, { method: "POST", body: JSON.stringify({ decision: "accept" }) })).status).toBe(200);
    const out = (await (await hook).json()) as any;
    expect(out.hookSpecificOutput.decision.behavior).toBe("allow");
  }, 30_000);
});

describe('coordinator.agent: "external"', () => {
  let d: Daemon;
  test("state says external; the user's chat is accepted without any model process", async () => {
    d = await startDaemon("external", "external", sim.home);
    const st = (await (await d.api("/api/coordinator")).json()) as any;
    expect(st.agent).toBe("external");
    expect(st.lastToolCallAt).toBeNull();
    await d.api("/api/coordinator/mode", { method: "POST", body: JSON.stringify({ mode: "active" }) });
    const c = await d.api("/api/coordinator/chat", { method: "POST", body: JSON.stringify({ text: "what's running?" }) });
    expect(c.status).toBe(200);
    const after = (await (await d.api("/api/coordinator")).json()) as any;
    expect(after.running).toBe(false);
    expect(after.activity.some((a: any) => a.action === "runtime")).toBe(false);
  }, 30_000);

  test("`sb mcp` lists the tools and get_updates drains the user's chat and events", async () => {
    const m = mcpClient(d);
    const init = await m.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.result.serverInfo.name).toBe("switchboard");
    expect(init.result.instructions).toMatch(/get_instructions/);
    const names = (await m.call("tools/list")).result.tools.map((t: any) => t.name);
    expect(names).toContain("get_updates");
    expect(names).toContain("get_instructions");
    expect(names).toContain("propose_plan");
    const u = await m.tool("get_updates");
    expect(u.isError).toBe(false);
    expect(u.body.chat.map((x: any) => x.text)).toEqual(["what's running?"]);
    expect(u.body.events.map((e: any) => e.kind)).toContain("mode");
    expect((await m.tool("get_updates")).body.chat).toEqual([]);
    // The root API stays out of reach of the coordinator credential.
    const coordTok = readFileSync(join(d.configDir, "coordinator-token"), "utf8").trim();
    expect((await fetch(`${d.base}/api/sessions`, { headers: { authorization: `Bearer ${coordTok}` } })).status).toBe(403);
    const st = (await (await d.api("/api/coordinator")).json()) as any;
    expect(st.lastToolCallAt).toBeGreaterThan(0);
  }, 30_000);

  test("the built-in brain's proxy is the same code, started directly, without the external instructions", async () => {
    const m = mcpClient(d, ["bun", "src/daemon/coordinator/mcp-server.ts"]);
    const init = await m.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.result.serverInfo.name).toBe("switchboard");
    expect(init.result.instructions).toBeUndefined();
    expect((await m.call("tools/list")).result.tools.length).toBeGreaterThan(10);
  }, 30_000);

  test("the proxy survives a daemon restart: it re-reads the rotated token and retries", async () => {
    const m = mcpClient(d);
    await m.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect((await m.tool("get_state")).isError).toBe(false);
    const before = readFileSync(join(d.configDir, "coordinator-token"), "utf8");
    await d.restart();
    expect(readFileSync(join(d.configDir, "coordinator-token"), "utf8")).not.toBe(before);
    const r = await m.tool("get_state");
    expect(r.isError).toBe(false); // mode is persisted (active), and the new token was picked up
    expect(r.body.budget).toBeTruthy();
  }, 45_000);
});
