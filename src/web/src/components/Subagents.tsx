// A Claude session's subagents (its Agent tool): a chip on its row, and a panel above its
// transcript listing what each is doing, like the agent list in Claude Code's own footer.
import { useState } from "react";
import type { Subagent } from "../../../shared/types.ts";
import { duration, relative } from "../format.ts";
import type { IconName, Tone } from "../status.ts";
import { useNow } from "../store.ts";
import { Chevron, StatusIcon } from "./Icons.tsx";

const LOOK: Record<Subagent["status"], { icon: IconName; tone: Tone; label: string }> = {
  running: { icon: "active", tone: "blue", label: "Working" },
  completed: { icon: "check", tone: "green", label: "Finished" },
  failed: { icon: "cross", tone: "red", label: "Failed" },
  killed: { icon: "stop", tone: "redmuted", label: "Stopped" },
  stopped: { icon: "stop", tone: "gray", label: "Stopped" },
};

export const runningAgents = (agents: Subagent[] | undefined) => (agents ?? []).filter((a) => a.status === "running").length;

/** On a session row: how many agents it has working. */
export function AgentsChip({ count }: { count: number }) {
  return (
    <span title={`${count} subagent${count === 1 ? "" : "s"} working`} className="pill tone-blue inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium">
      <StatusIcon name="active" width={11} height={11} />
      {count} agent{count === 1 ? "" : "s"}
    </span>
  );
}

/** Parents first, each followed by the agents it started (indented). */
export function agentTree(agents: Subagent[]): { agent: Subagent; depth: number }[] {
  const ids = new Set(agents.map((a) => a.id));
  const out: { agent: Subagent; depth: number }[] = [];
  const walk = (a: Subagent, depth: number) => {
    out.push({ agent: a, depth });
    for (const c of agents) if (c.parentId === a.id) walk(c, Math.min(depth + 1, 3));
  };
  for (const a of agents) if (!a.parentId || !ids.has(a.parentId)) walk(a, 0);
  return out;
}

function AgentRow({ agent: a, depth, now }: { agent: Subagent; depth: number; now: number }) {
  const look = LOOK[a.status];
  const running = a.status === "running";
  const took = duration((running ? now : (a.endedAt ?? a.lastActivityAt)) - a.startedAt);
  return (
    <li className="flex items-start gap-2 py-1.5 pr-3" style={{ paddingLeft: 12 + depth * 14 }}>
      <span className={`tone-${look.tone} mt-0.5 shrink-0 text-(--tone)`} title={look.label}>
        <StatusIcon name={look.icon} width={12} height={12} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{a.description || a.type}</span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-3">{took}</span>
        </span>
        <span className="block truncate text-[11px] text-ink-3">
          {running ? (a.activity ?? "Working") : `${look.label} ${relative(a.endedAt, now)}`}
          {a.model ? ` · ${a.model}` : ""}
        </span>
      </span>
    </li>
  );
}

const OPEN_KEY = "sb.agentsOpen";
const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
};

/** Above the transcript: one line ("3 agents working"), and the list when opened. */
export function SubagentsPanel({ agents }: { agents: Subagent[] | undefined }) {
  const now = useNow(); // here, not in the pane: the transcript shouldn't redraw every tick
  const [open, setOpen] = useState(readOpen);
  const [showDone, setShowDone] = useState(false);
  if (!agents?.length) return null;
  const running = agents.filter((a) => a.status === "running");
  const done = agents.filter((a) => a.status !== "running");
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(OPEN_KEY, open ? "0" : "1");
    } catch {}
  };
  return (
    <section aria-label="Subagents" className="border-b border-line bg-panel">
      <button onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-hover sm:px-4">
        <Chevron className={`shrink-0 text-ink-3 ${open ? "rotate-90" : ""}`} width={12} height={12} />
        {running.length > 0 ? (
          <span className="tone-blue inline-flex items-center gap-1 font-medium text-(--tone)">
            <StatusIcon name="active" width={11} height={11} />
            {running.length} agent{running.length === 1 ? "" : "s"} working
          </span>
        ) : (
          <span className="font-medium text-ink-2">No agents working</span>
        )}
        {done.length > 0 && <span className="text-ink-3">· {done.length} finished recently</span>}
      </button>
      {open && (
        <div className="max-h-[45vh] overflow-y-auto pb-1">
          {running.length > 0 && (
            <ul className="divide-y divide-line/50">
              {agentTree(running).map(({ agent, depth }) => (
                <AgentRow key={agent.id} agent={agent} depth={depth} now={now} />
              ))}
            </ul>
          )}
          {done.length > 0 && (
            <>
              <button onClick={() => setShowDone(!showDone)} aria-expanded={showDone} className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11px] text-ink-3 hover:text-ink-2 sm:px-4">
                <Chevron className={showDone ? "rotate-90" : ""} width={10} height={10} />
                Finished ({done.length})
              </button>
              {showDone && (
                <ul className="divide-y divide-line/50">
                  {done.map((a) => (
                    <AgentRow key={a.id} agent={a} depth={0} now={now} />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
