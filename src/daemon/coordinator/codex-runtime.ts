// A private stdio app-server, never the user's shared Codex daemon or an existing thread.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../config.ts";
import type { RuntimeSelection } from "./config.ts";
import { CODEX_RESTRICTIONS, CODEX_VERSION, codexCost, restrictedCodexCatalog, toml, type CodexTokens } from "./codex-config.ts";
import { COORDINATOR_DIR, MCP_SERVER, PROMPT_FILE, type RuntimeLike, type RuntimeUsage } from "./runtime.ts";

export function codexArgs(catalogFile: string, toolNames: string[], port: number, configDir = paths.configDir): string[] {
  const config = { ...CODEX_RESTRICTIONS, model_catalog_json: catalogFile,
    mcp_servers: { [MCP_SERVER]: { command: process.execPath, args: [join(import.meta.dir, "mcp-server.ts")],
      env: { SB_PORT: String(port), SB_CONFIG_DIR: configDir }, enabled_tools: toolNames, required: true,
      // Only our explicit tool allowlist is pre-authorized. The daemon still enforces
      // userChat provenance, grants, exclusions, destructive screening and budgets.
      default_tools_approval_mode: "approve" } } };
  return ["codex", "app-server", "--listen", "stdio://", ...Object.entries(config).flatMap(([k, v]) => ["-c", `${k}=${toml(v)}`])];
}

export type CodexProcess = ReturnType<typeof Bun.spawn>;
export interface CodexLaunch { proc: CodexProcess; cwd: string; cleanup?: () => void; syncAuth?: () => void }

/**
 * The private CODEX_HOME shares the user's login through a symlink to ~/.codex/auth.json. When
 * Codex refreshes its token it atomically replaces that symlink with a real file holding the new
 * (rotated) refresh token, and the user's own file is left with a dead one. Copy a replaced
 * credential back, atomically and owner-only, unless the user's file is newer (another Codex
 * refreshed it meanwhile). Best effort: a failure here must never stop the coordinator.
 */
export function syncCodexAuth(privateHome: string, codexHome = paths.codexHome): boolean {
  const temp = join(privateHome, "auth.json");
  try {
    const st = lstatSync(temp);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    const real = join(codexHome, "auth.json");
    let target = real;
    try { target = realpathSync(real); } catch {}
    const fresh = readFileSync(temp);
    try {
      const current = statSync(target);
      if (current.mtimeMs > st.mtimeMs || readFileSync(target).equals(fresh)) return false;
    } catch {}
    const tmp = join(dirname(target), `.auth.json.switchboard-${process.pid}-${Date.now()}`);
    try {
      writeFileSync(tmp, fresh, { mode: 0o600, flag: "wx" });
      chmodSync(tmp, 0o600);
      renameSync(tmp, target);
    } finally {
      rmSync(tmp, { force: true });
    }
    return true;
  } catch (e) {
    console.error("[coordinator] could not copy the refreshed Codex login back:", (e as Error).message);
    return false;
  }
}

/** Removes the private CODEX_HOME, after saving a refreshed login back to the user's. */
export function codexHomeCleanup(privateHome: string, codexHome = paths.codexHome): () => void {
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    process.off("exit", cleanup);
    syncCodexAuth(privateHome, codexHome);
    rmSync(privateHome, { recursive: true, force: true });
  };
  // A daemon that exits before the process's exit handler runs still saves the login.
  process.on("exit", cleanup);
  return cleanup;
}

function launchCodex(selection: RuntimeSelection, tools: string[], port: number): CodexLaunch {
  mkdirSync(COORDINATOR_DIR, { recursive: true, mode: 0o700 });
  const cwd = mkdtempSync(join(COORDINATOR_DIR, "codex-"));
  try {
    // Only the login is shared. No user/project MCP servers, hooks, plugins, skills or settings.
    const env: Record<string, string> = { CODEX_HOME: cwd };
    for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR"])
      if (process.env[key]) env[key] = process.env[key]!;
    const run = (args: string[], what: string) => {
      let p: ReturnType<typeof Bun.spawnSync>;
      try { p = Bun.spawnSync(["codex", ...args], { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 10_000 }); }
      catch { throw new Error(`The Codex coordinator needs the Codex CLI (${CODEX_VERSION}), and \`codex\` was not found on PATH. Install it, or switch the coordinator to Claude in Settings → Coordinator.`); }
      if (p.exitCode !== 0) throw new Error(`Codex coordinator setup failed: \`codex ${args.join(" ")}\` (${what}) exited with ${p.exitCode}. Check the installed Codex CLI (${CODEX_VERSION} is required).`);
      return p.stdout!.toString();
    };
    const version = run(["--version"], "version check").trim();
    if (version !== CODEX_VERSION)
      throw new Error(`The Codex coordinator runs only on ${CODEX_VERSION} (installed: ${version || "unknown"}). Its tool isolation was verified on that version alone. Install ${CODEX_VERSION}, or switch the coordinator to Claude in Settings → Coordinator.`);
    const catalog = restrictedCodexCatalog(JSON.parse(run(["debug", "models", "--bundled"], "model catalog")), selection.model);
    const catalogFile = join(cwd, "models.json");
    writeFileSync(catalogFile, JSON.stringify(catalog), { mode: 0o600 });
    // Shares the user's login. A token refresh replaces this link; syncCodexAuth copies it back.
    symlinkSync(join(paths.codexHome, "auth.json"), join(cwd, "auth.json"));
    const proc = Bun.spawn(codexArgs(catalogFile, tools, port), { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    return { proc, cwd, cleanup: codexHomeCleanup(cwd), syncAuth: () => void syncCodexAuth(cwd) };
  } catch (e) {
    rmSync(cwd, { recursive: true, force: true });
    throw e;
  }
}

/** How often a running Codex coordinator's refreshed login is saved back. */
export const AUTH_SYNC_MS = 60_000;

export class CodexRuntime implements RuntimeLike {
  running = false;
  busy = false;
  onText: RuntimeLike["onText"] = () => {};
  onResult: RuntimeLike["onResult"] = () => {};
  onUsage: (r: RuntimeUsage) => void = () => {};
  onExit: RuntimeLike["onExit"] = () => {};
  private proc: CodexProcess | null = null;
  private ready: Promise<string> | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private threadId: string | null = null;
  private turnId: string | null = null;
  private total: CodexTokens = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cacheWriteInputTokens: 0 };
  private cost = 0;
  private syncAuth: (() => void) | null = null;

  constructor(readonly selection: RuntimeSelection, private toolNames: string[], private port: number,
    private launch: () => CodexLaunch = () => launchCodex(selection, toolNames, port)) {}

  start() {
    if (this.running) return;
    const { proc, cwd, cleanup, syncAuth } = this.launch();
    this.proc = proc;
    this.running = true;
    this.busy = false;
    this.cost = 0;
    this.total = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cacheWriteInputTokens: 0 };
    this.syncAuth = syncAuth ?? null;
    // A refreshed login is saved back while the process runs, not only when it ends.
    const authTimer = syncAuth ? setInterval(syncAuth, AUTH_SYNC_MS) : null;
    const read = this.read(proc);
    // Drain stderr without exposing credentials or provider responses in the activity log.
    void new Response(proc.stderr as ReadableStream).text().catch(() => "");
    void proc.exited.then(async (code) => {
      await read;
      if (authTimer) clearInterval(authTimer);
      cleanup?.();
      if (this.proc !== proc) return;
      this.clear();
      this.onExit(code);
    });
    this.ready = (async () => {
      await this.call("initialize", { clientInfo: { name: "switchboard-coordinator", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      this.write({ jsonrpc: "2.0", method: "initialized" });
      const r = await this.call("thread/start", { model: this.selection.model, cwd, ephemeral: true,
        approvalPolicy: "never", sandbox: "read-only", serviceTier: "default", environments: [],
        baseInstructions: readFileSync(PROMPT_FILE, "utf8"), developerInstructions: "", config: CODEX_RESTRICTIONS });
      if (this.proc !== proc) throw new Error("coordinator stopped during startup");
      if (!r.thread?.id || r.model !== this.selection.model) throw new Error("Codex did not start the requested coordinator model");
      return this.threadId = r.thread.id;
    })();
    void this.ready.catch((e) => { if (this.proc === proc) this.fail(e); });
  }

  private clear() {
    this.proc = null;
    this.ready = null;
    this.threadId = this.turnId = null;
    this.running = this.busy = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Codex coordinator stopped")); }
    this.pending.clear();
  }

  stop() {
    const p = this.proc;
    // The daemon may exit right after this: save a refreshed login now.
    if (p) this.syncAuth?.();
    this.clear();
    try { p?.kill(); } catch {}
  }

  private fail(error: unknown) {
    this.stop();
    this.onResult({ is_error: true, result: `Codex coordinator stopped: ${(error as Error).message}` });
    this.onExit(1);
  }

  send(text: string, images: string[] = []): boolean {
    const proc = this.proc;
    if (!proc || !this.ready || this.busy) return false;
    this.busy = true;
    const input: unknown[] = [{ type: "text", text, text_elements: [] }];
    // Embed bounded image bytes just as Claude does; no model file-reading tool is needed.
    for (const path of images.slice(0, 8)) {
      try {
        const data = readFileSync(path);
        if (data.length <= 5 * 1024 * 1024) {
          const mime = data[0] === 0xff ? "image/jpeg" : data.subarray(0, 3).toString() === "GIF" ? "image/gif" : data.subarray(8, 12).toString() === "WEBP" ? "image/webp" : "image/png";
          input.push({ type: "image", url: `data:${mime};base64,${data.toString("base64")}` });
        }
      } catch {}
    }
    void this.ready.then(async (threadId) => {
      if (this.proc !== proc) return;
      await this.call("turn/start", { threadId, input, effort: this.selection.effort });
    }).catch((e) => { if (this.proc === proc) this.fail(e); });
    return true;
  }

  private write(m: unknown) {
    if (!this.proc) throw new Error("Codex coordinator not running");
    const sink = this.proc.stdin as import("bun").FileSink;
    sink.write(JSON.stringify(m) + "\n");
    sink.flush();
  }

  private call(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex timeout: ${method}`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  private async read(proc: CodexProcess) {
    try {
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        if (this.proc !== proc) break;
        buffer += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buffer.indexOf("\n")) >= 0 && this.proc === proc) {
          const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
          if (line) this.message(JSON.parse(line));
        }
      }
    } catch (e) { if (this.proc === proc) this.fail(e); }
  }

  private message(m: any) {
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message ?? "Codex RPC failed")); else p.resolve(m.result);
      return;
    }
    if (m.id !== undefined) {
      // Built-in approval, permissions and user-input requests are never granted by the adapter.
      this.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Coordinator supports only Switchboard MCP tools" } });
      return;
    }
    const p = m.params;
    if (!p || !this.threadId || p.threadId !== this.threadId) return;
    if (m.method === "turn/started") this.turnId = p.turn.id;
    else if (m.method === "item/completed" && p.turnId === this.turnId && p.item?.type === "agentMessage") {
      if (p.item.text?.trim()) this.onText(p.item.text);
    } else if (m.method === "thread/tokenUsage/updated") {
      // Account cumulative deltas, not `last` (which is one inference, not an entire turn).
      const total = p.tokenUsage?.total as CodexTokens;
      const delta: CodexTokens = { inputTokens: total?.inputTokens - this.total.inputTokens,
        cachedInputTokens: total?.cachedInputTokens - this.total.cachedInputTokens,
        cacheWriteInputTokens: (total?.cacheWriteInputTokens ?? 0) - (this.total.cacheWriteInputTokens ?? 0),
        outputTokens: total?.outputTokens - this.total.outputTokens };
      // If several inference updates were coalesced, long-context rates are the conservative bound.
      const base = codexCost(this.selection.model, delta);
      const last = p.tokenUsage?.last;
      const long = last?.inputTokens > 272_000 && delta.inputTokens <= 272_000;
      this.cost += long ? base * 2 : base;
      this.total = { ...total };
      this.onUsage({ total_cost_usd: this.cost, usage: { input_tokens: delta.inputTokens, output_tokens: delta.outputTokens } });
    } else if (m.method === "turn/completed" && p.turn?.id === this.turnId && this.busy) {
      this.turnId = null;
      this.busy = false;
      this.onResult({ is_error: p.turn.status !== "completed", result: p.turn.error?.message });
    } else if (m.method === "model/rerouted" && p.toModel !== this.selection.model) {
      this.fail(new Error("Codex changed models; stopping because budget rates would no longer match"));
    }
  }
}
