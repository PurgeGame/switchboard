// JSON-RPC client for the shared Codex app-server daemon (approved for use 2026-10-06).
// Phase 1 uses only read-only methods: thread/loaded/list, thread/read.
import { existsSync } from "node:fs";
import { UnixWebSocket } from "../wsunix.ts";

type Handler = (method: string, params: any, id?: number | string) => void;

export class CodexDaemonClient {
  private ws: UnixWebSocket | null = null;
  private nextId = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; timer: any }>();
  private handlers: Handler[] = [];
  private connectHooks: (() => void)[] = [];
  private connecting: Promise<void> | null = null;
  connected = false;
  lastError: string | null = null;

  constructor(private sockPath: string) {}

  onNotification(h: Handler) {
    this.handlers.push(h);
  }

  /** Runs after every (re)connect + initialize, e.g. to re-subscribe threads. */
  onConnect(fn: () => void) {
    this.connectHooks.push(fn);
  }

  /** Answer a server -> client request (e.g. an approval) on the current connection. */
  respond(id: number | string, result: unknown) {
    if (!this.ws) throw new Error("not connected");
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  async ensure(): Promise<boolean> {
    if (this.connected) return true;
    if (!existsSync(this.sockPath)) {
      this.lastError = "daemon socket not found";
      return false;
    }
    this.connecting ??= this.connect().finally(() => (this.connecting = null));
    try {
      await this.connecting;
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  private async connect() {
    const ws = new UnixWebSocket(this.sockPath);
    ws.onmessage = (text) => this.onMessage(text);
    ws.onclose = (reason) => {
      this.connected = false;
      this.ws = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.rej(new Error(`connection closed: ${reason}`));
      }
      this.pending.clear();
    };
    await ws.connect();
    this.ws = ws;
    this.connected = true;
    await this.call("initialize", {
      clientInfo: { name: "switchboard", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    for (const fn of this.connectHooks) {
      try {
        fn();
      } catch (e) {
        console.error("[codex-daemon] connect hook failed", e);
      }
    }
  }

  private onMessage(text: string) {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.rej(Object.assign(new Error(m.error.message ?? "rpc error"), { rpc: m.error }));
      else p.res(m.result);
      return;
    }
    if (m.method) for (const h of this.handlers) h(m.method, m.params, m.id);
  }

  call<T = any>(method: string, params: any = {}, timeoutMs = 10_000): Promise<T> {
    if (!this.ws) return Promise.reject(new Error("not connected"));
    const id = ++this.nextId;
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { res, rej, timer });
      this.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close() {
    this.ws?.close();
  }
}
