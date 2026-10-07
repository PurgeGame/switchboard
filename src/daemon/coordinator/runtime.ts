// The coordinator process: a disposable Claude or Codex brain, owned by the daemon.
// - runs on the user's provider login, with only our MCP server for actions
// - state lives in SQLite; a crashed or restarted process gets a fresh state digest
import { readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.ts";
import { runtimeSelection, type CoordinatorConfig, type RuntimeSelection } from "./config.ts";
import { CodexRuntime } from "./codex-runtime.ts";

export const MCP_SERVER = "switchboard";
export const TOOL_PREFIX = `mcp__${MCP_SERVER}__`;
export const COORDINATOR_DIR = join(paths.dataDir, "coordinator");
const REPO = join(import.meta.dir, "../../..");
export const PROMPT_FILE = join(REPO, "coordinator/COORDINATOR.md");
const MCP_SCRIPT = join(import.meta.dir, "mcp-server.ts");

/** Built-ins we deny explicitly, on top of --tools "" (belt and braces). */
export const DENIED_BUILTINS = ["Bash", "BashOutput", "KillShell", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "SlashCommand", "Skill"];

export interface RuntimeLike {
  running: boolean;
  busy: boolean;
  start(): void;
  stop(): void;
  /** Deliver one user turn. Returns false if the process isn't running. */
  send(text: string, images?: string[]): boolean;
  onText: (text: string) => void;
  onResult: (r: RuntimeUsage & { is_error?: boolean; result?: string }) => void;
  /** Incremental provider usage can stop a busy process at the same daemon budget cap. */
  onUsage?: (r: RuntimeUsage) => void;
  onExit: (code: number | null) => void;
  /** Selection captured at process start; saving settings never mutates a running process. */
  readonly selection?: RuntimeSelection;
}

export interface RuntimeUsage {
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

/** The daemon keeps one engine. Only this disposable child changes on the next start. */
export class CoordinatorRuntime implements RuntimeLike {
  private child: RuntimeLike | null = null;
  selection?: RuntimeSelection;
  onText: RuntimeLike["onText"] = () => {};
  onResult: RuntimeLike["onResult"] = () => {};
  onUsage: (r: RuntimeUsage) => void = () => {};
  onExit: RuntimeLike["onExit"] = () => {};
  get running() { return !!this.child?.running; }
  get busy() { return !!this.child?.busy; }

  constructor(private config: () => CoordinatorConfig, toolNames: string[], port: number,
    private create: (s: RuntimeSelection) => RuntimeLike = (s) => s.provider === "codex"
      ? new CodexRuntime(s, toolNames, port)
      : new ClaudeRuntime(() => s.model, toolNames, port, () => s.effort)) {}

  start() {
    if (this.running) return;
    this.stop();
    const selection = runtimeSelection(this.config());
    const child = this.create(selection);
    this.child = child;
    this.selection = selection;
    child.onText = (s) => { if (this.child === child) this.onText(s); };
    child.onResult = (r) => { if (this.child === child) this.onResult(r); };
    child.onUsage = (r) => { if (this.child === child) this.onUsage(r); };
    child.onExit = (c) => { if (this.child === child) { this.child = null; this.onExit(c); } };
    try { child.start(); }
    catch (e) { this.stop(); throw e; }
  }

  stop() { const old = this.child; this.child = null; old?.stop(); }
  send(text: string, images?: string[]) { return this.child?.send(text, images) ?? false; }
}

/** argv for the coordinator process (exported for tests: tool restrictions are asserted there). */
export function coordinatorArgs(model: string, toolNames: string[], mcpConfig: string, promptFile = PROMPT_FILE, effort: string | null = null): string[] {
  return [
    "claude",
    "-p",
    ...(effort ? ["--effort", effort] : []),
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--system-prompt-file", promptFile,
    "--mcp-config", mcpConfig,
    "--strict-mcp-config",
    "--setting-sources", "",
    "--tools", "",
    "--allowedTools", toolNames.map((t) => TOOL_PREFIX + t).join(","),
    "--disallowedTools", DENIED_BUILTINS.join(","),
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
    "-n", "switchboard-coordinator",
  ];
}

export function writeMcpConfig(port: number): string {
  mkdirSync(COORDINATOR_DIR, { recursive: true, mode: 0o700 });
  const f = join(COORDINATOR_DIR, "mcp.json");
  const cfg = { mcpServers: { [MCP_SERVER]: { type: "stdio", command: process.execPath, args: [MCP_SCRIPT], env: { SB_PORT: String(port), SB_CONFIG_DIR: paths.configDir } } } };
  writeFileSync(f, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return f;
}

export class ClaudeRuntime implements RuntimeLike {
  running = false;
  busy = false;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  onText: RuntimeLike["onText"] = () => {};
  onResult: RuntimeLike["onResult"] = () => {};
  onExit: RuntimeLike["onExit"] = () => {};

  constructor(
    private model: () => string,
    private toolNames: string[],
    private port: number,
    private effort: () => string | null = () => null,
    private launch?: () => ReturnType<typeof Bun.spawn>,
  ) {}

  start() {
    if (this.proc) return;
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // subscription login only, never an API key
    delete env.CLAUDECODE;
    const proc = this.launch?.() ?? Bun.spawn(coordinatorArgs(this.model(), this.toolNames, writeMcpConfig(this.port), undefined, this.effort()), { cwd: COORDINATOR_DIR, stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    this.proc = proc;
    this.running = true;
    this.busy = false;
    const read = this.read(proc);
    void (async () => {
      const err = await new Response(proc.stderr as ReadableStream).text().catch(() => "");
      if (err.trim()) console.error("[coordinator stderr]", err.trim().slice(0, 2000));
    })();
    void proc.exited.then(async (code) => {
      await read;
      if (this.proc !== proc) return;
      this.proc = null;
      this.running = this.busy = false;
      this.onExit(code);
    });
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.running = this.busy = false;
    try {
      p?.kill();
    } catch {}
  }

  send(text: string, images: string[] = []): boolean {
    if (!this.proc) return false;
    // Pasted images reach the model as real image blocks, not as a note that something was attached.
    const blocks: unknown[] = [{ type: "text", text }];
    for (const path of images.slice(0, 8))
      try {
        const data = readFileSync(path);
        if (data.length > 5 * 1024 * 1024) continue;
        blocks.push({ type: "image", source: { type: "base64", media_type: mediaType(path, data), data: data.toString("base64") } });
      } catch {}
    const line = JSON.stringify({ type: "user", message: { role: "user", content: blocks } }) + "\n";
    try {
      (this.proc.stdin as import("bun").FileSink).write(line);
      (this.proc.stdin as import("bun").FileSink).flush();
      this.busy = true;
      return true;
    } catch {
      return false;
    }
  }

  private async read(proc: ReturnType<typeof Bun.spawn>) {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      if (this.proc !== proc) return;
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0 && this.proc === proc) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.type === "assistant") {
          const text = (m.message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
          if (text) this.onText(text);
        } else if (m.type === "result") {
          this.busy = false;
          this.onResult(m);
        }
      }
    }
  }
}

function mediaType(path: string, data: Buffer): string {
  if (data[0] === 0x89 && data[1] === 0x50) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data.subarray(0, 3).toString() === "GIF") return "image/gif";
  if (data.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png";
}
