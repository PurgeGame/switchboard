#!/usr/bin/env bun
// stdio MCP server for the coordinator agent. A thin proxy: tools/list and tools/call go to the
// daemon's /api/coordinator/tools and /api/coordinator/tool/:name, where every rule is enforced.
// It can reach nothing else: it only ever calls those two endpoints.
//
// Two users: the built-in coordinator process (runtime.ts starts this file directly), and your own
// agent through `sb mcp` (coordinator.agent "external", D34). Your agent's MCP server outlives
// daemon restarts, and the coordinator token rotates on every start: so the token is read when
// needed, and re-read once after a 401.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpProxyOptions {
  port?: number;
  configDir?: string;
  /** MCP server instructions shown to the client (only for an external agent; the built-in one has its system prompt). */
  instructions?: string;
}

export const EXTERNAL_INSTRUCTIONS =
  "Switchboard's coordinator tools. Call get_instructions first: it explains your role, what you may do, and how to follow what happens (get_updates). Every rule is enforced by the Switchboard daemon.";

/** Serve MCP over stdin/stdout. Resolves when stdin closes. */
export function runMcpProxy(opts: McpProxyOptions = {}): Promise<void> {
  const port = opts.port ?? Number(process.env.SB_PORT ?? 7777);
  const configDir = opts.configDir ?? process.env.SB_CONFIG_DIR ?? join(homedir(), ".config/switchboard");
  const base = `http://127.0.0.1:${port}/api/coordinator`;
  // The coordinator-only credential: it is refused everywhere except the coordinator tool endpoints.
  const readToken = () => {
    try {
      return readFileSync(join(configDir, "coordinator-token"), "utf8").trim();
    } catch {
      return "";
    }
  };
  let token = readToken();
  /** One request; on a 401 (the daemon restarted with a new token) re-read the token and retry once. */
  const call = async (path: string, init: RequestInit = {}) => {
    const go = () => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    let r = await go().catch((e) => {
      throw new Error(`Switchboard isn't reachable on 127.0.0.1:${port} (${(e as Error).message}). Is the daemon running?`);
    });
    if (r.status === 401) {
      token = readToken();
      r = await go();
    }
    return r;
  };

  const write = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

  async function handle(msg: any) {
    const { id, method, params } = msg;
    if (id === undefined || id === null) return; // notifications
    try {
      if (method === "initialize")
        return write({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "switchboard", version: "1.0.0" },
            ...(opts.instructions ? { instructions: opts.instructions } : {}),
          },
        });
      if (method === "ping") return write({ jsonrpc: "2.0", id, result: {} });
      if (method === "tools/list") {
        const r = await call("/tools");
        const body = (await r.json().catch(() => null)) as any;
        if (!r.ok || !Array.isArray(body)) throw new Error(body?.error ?? `HTTP ${r.status}`);
        return write({ jsonrpc: "2.0", id, result: { tools: body } });
      }
      if (method === "tools/call") {
        const r = await call(`/tool/${encodeURIComponent(params.name)}`, { method: "POST", body: JSON.stringify(params.arguments ?? {}) });
        const body = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as any;
        return write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(body.ok ? body.result : { error: body.error ?? `HTTP ${r.status}` }, null, 1) }], isError: !body.ok } });
      }
      write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
    } catch (e) {
      write({ jsonrpc: "2.0", id, error: { code: -32000, message: (e as Error).message } });
    }
  }

  return new Promise((done) => {
    let buf = "";
    process.stdin.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          void handle(JSON.parse(line));
        } catch {}
      }
    });
    process.stdin.on("end", () => done());
  });
}

if (import.meta.main) void runMcpProxy();
