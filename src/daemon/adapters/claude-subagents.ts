// Subagents a Claude session started (the Agent tool), read from disk: Claude Code keeps each one's
// transcript at <transcript without .jsonl>/subagents/agent-<id>.jsonl, with agent-<id>.meta.json
// (type, description, model, parent agent). How each one ended comes from the <task-notification>
// Claude delivers to whoever started it (the session's transcript, or the parent agent's): most
// agents end with a hand-back tool call, not a final reply, so their own transcript can't say.
// Files are read incrementally: each tick reads only what was appended since the last one.
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Subagent } from "../../shared/types.ts";
import { toolSummary } from "./parse-claude.ts";

/** Agents that finished longer ago than this aren't listed. */
const FINISHED_FOR_MS = 3 * 3600_000;
const MAX_FINISHED = 10;
/** Files untouched this long are never read: anything in them finished (or died) long ago. */
const OLD_MS = 6 * 3600_000;
/** Its transcript moved on after its last notification: it was sent another message and is running again. */
const RESUMED_AFTER_MS = 30_000;
const TERMINAL = new Set(["completed", "failed", "killed", "stopped"]);

interface Note {
  status: string;
  at: number;
}

interface FileState {
  offset: number;
  partial: string;
  /** Notifications found in this file, by the task id (= agent id) they're about. */
  notes: Map<string, Note>;
  startedAt: number | null;
  lastAt: number | null;
  activity: string | null;
  /** Its agent-<id>.meta.json, once read. */
  meta?: any;
}

const ms = (iso: unknown) => (typeof iso === "string" ? Date.parse(iso) || null : null);
const clip = (s: string, n = 90) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

/** What a tool call is doing, in plain words. */
export function activityOf(name: string, input: any): string {
  const file = (k = "file_path") => (typeof input?.[k] === "string" ? basename(input[k]) : "a file");
  switch (name) {
    case "Bash":
      return clip(typeof input?.description === "string" && input.description ? input.description : `Running ${String(input?.command ?? "a command")}`);
    case "Read":
      return `Reading ${file()}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${file()}`;
    case "Write":
      return `Writing ${file()}`;
    case "NotebookEdit":
      return `Editing ${file("notebook_path")}`;
    case "Grep":
      return clip(`Searching for ${String(input?.pattern ?? "")}`);
    case "Glob":
      return clip(`Finding ${String(input?.pattern ?? "files")}`);
    case "Agent":
    case "Task":
      return clip(`Started an agent: ${String(input?.description ?? "")}`);
    case "WebFetch":
      return clip(`Reading ${String(input?.url ?? "a web page")}`);
    case "WebSearch":
      return clip(`Searching the web for ${String(input?.query ?? "")}`);
    case "TodoWrite":
      return "Updating its to-do list";
    default:
      return clip(`${name.replace(/^mcp__[^_]+__/, "")}: ${toolSummary(name, input).summary}`);
  }
}

export class ClaudeSubagents {
  private files = new Map<string, FileState>();

  /** Read what was appended to `path` since last time, and fold it into its state. */
  private advance(path: string, agent: boolean): FileState {
    let st = this.files.get(path);
    if (!st) this.files.set(path, (st = { offset: 0, partial: "", notes: new Map(), startedAt: null, lastAt: null, activity: null }));
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return st;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < st.offset) Object.assign(st, { offset: 0, partial: "", notes: new Map(), startedAt: null, lastAt: null, activity: null }); // rewritten
      if (size === st.offset) return st;
      const buf = Buffer.alloc(size - st.offset);
      readSync(fd, buf, 0, buf.length, st.offset);
      st.offset = size;
      const lines = (st.partial + buf.toString("utf8")).split("\n");
      st.partial = lines.pop() ?? "";
      // Whole files can be megabytes: parse only the lines that matter (notifications, the first
      // line, and the newest records), found by plain substring checks.
      for (const line of lines)
        if (line.includes("<task-notification>")) {
          let at: number | null = null;
          try {
            at = ms(JSON.parse(line).timestamp);
          } catch {}
          for (const m of line.matchAll(/<task-id>(\w+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>/g)) {
            const prev = st.notes.get(m[1]);
            const note = { status: m[2], at: at ?? Date.now() };
            if (!prev || note.at >= prev.at) st.notes.set(m[1], note);
          }
        }
      if (!agent) return st;
      if (st.startedAt === null)
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            st.startedAt = ms(JSON.parse(line).timestamp);
          } catch {}
          break;
        }
      // Newest record with a timestamp, and the newest step it took (a tool call, or thinking).
      let gotLast = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.trim()) continue;
        const step = line.includes('"tool_use"') || line.includes('"thinking"');
        if (gotLast && !step) continue;
        let r: any;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        if (!gotLast) {
          const at = ms(r.timestamp);
          if (at) {
            st.lastAt = at;
            gotLast = true;
          }
        }
        if (step && r.type === "assistant" && Array.isArray(r.message?.content)) {
          const blocks = r.message.content;
          const tool = [...blocks].reverse().find((b: any) => b?.type === "tool_use");
          st.activity = tool ? activityOf(String(tool.name), tool.input) : blocks.some((b: any) => b?.type === "thinking") ? "Thinking" : st.activity;
          if (gotLast) break;
        }
      }
      return st;
    } finally {
      closeSync(fd);
    }
  }

  /**
   * The session's subagents: every running one, then the most recent finished ones. `live` is
   * false once the session has ended; `since` is when its process started (agents silent since
   * before then died with the old process).
   */
  read(transcriptPath: string, live: boolean, since: number | null, now: number): Subagent[] {
    const dir = join(transcriptPath.replace(/\.jsonl$/, ""), "subagents");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const notes = new Map<string, Note>();
    const merge = (from: Map<string, Note>) => {
      for (const [id, n] of from) {
        const prev = notes.get(id);
        if (!prev || n.at >= prev.at) notes.set(id, n);
      }
    };
    merge(this.advance(transcriptPath, false).notes);
    const agents: { id: string; path: string; st: FileState }[] = [];
    for (const f of names) {
      const m = f.match(/^agent-(\w+)\.jsonl$/);
      if (!m) continue;
      const path = join(dir, f);
      // Leave old agents alone without reading them (a busy session has dozens of multi-MB files).
      if (!this.files.has(path))
        try {
          if (now - statSync(path).mtimeMs > OLD_MS) continue;
        } catch {
          continue;
        }
      const st = this.advance(path, true);
      merge(st.notes);
      agents.push({ id: m[1], path, st });
    }
    const out: Subagent[] = [];
    for (const { id, path, st } of agents) {
      if (!st.meta)
        try {
          st.meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
        } catch {}
      const meta = st.meta ?? {};
      const startedAt = st.startedAt ?? st.lastAt ?? now;
      const lastAt = st.lastAt ?? startedAt;
      const note = notes.get(id);
      const ended = note && TERMINAL.has(note.status) && lastAt - note.at < RESUMED_AFTER_MS ? note : null;
      const status: Subagent["status"] = ended ? (ended.status as Subagent["status"]) : !live || (since !== null && lastAt < since) ? "stopped" : "running";
      const endedAt = ended ? ended.at : status === "stopped" ? lastAt : null;
      if (endedAt !== null && now - endedAt > FINISHED_FOR_MS) continue;
      out.push({
        id,
        type: typeof meta.agentType === "string" ? meta.agentType : "agent",
        description: typeof meta.description === "string" ? meta.description : "",
        model: typeof meta.model === "string" ? meta.model : null,
        parentId: typeof meta.parentAgentId === "string" ? meta.parentAgentId : null,
        status,
        activity: status === "running" ? st.activity : null,
        startedAt,
        lastActivityAt: lastAt,
        endedAt,
      });
    }
    const running = out.filter((a) => a.status === "running").sort((a, b) => a.startedAt - b.startedAt);
    const finished = out.filter((a) => a.status !== "running").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, MAX_FINISHED);
    return [...running, ...finished];
  }

  /** Forget files of a session that's gone. */
  forget(transcriptPath: string) {
    const prefix = transcriptPath.replace(/\.jsonl$/, "");
    for (const k of this.files.keys()) if (k === transcriptPath || k.startsWith(prefix + "/")) this.files.delete(k);
  }
}
