// Home (D34): the first row of the list and the pane it opens. With a coordinator (built-in or your
// own agent) it is the coordinator; with none it is a plain "Needs you" list of permission prompts
// and waiting sessions. Pure functions, shared by the row, the panes and tests.
import type { AttentionItem, CoordinatorAgentKind, CoordinatorState, Task } from "../../shared/types.ts";
import { openItems } from "./attention.ts";
import { relative } from "./format.ts";

/** Prompts you can answer here (held by Switchboard), oldest first, and how many other items wait on you. */
export function needsYou(attention: Record<number, AttentionItem>) {
  const open = openItems(attention);
  const prompts = open.filter((i) => i.kind === "approval" && typeof i.meta.answerKey === "string").sort((a, b) => a.createdAt - b.createdAt);
  return { prompts, waiting: open.length - prompts.length };
}

export interface HomeRow {
  title: string;
  status: string;
  waiting: number;
  lamp: "on" | "busy" | "off";
}

/** kind null: not known yet (before the first message from the daemon): today's coordinator row. */
export function homeRow(kind: CoordinatorAgentKind | null, c: CoordinatorState | null, tasks: Task[], attention: Record<number, AttentionItem>): HomeRow {
  const ny = needsYou(attention);
  if (kind === "none") {
    const waiting = ny.prompts.length + ny.waiting;
    return { title: "Needs you", status: waiting ? `${waiting} need${waiting === 1 ? "s" : ""} you` : "Nothing right now", waiting, lamp: "off" };
  }
  const mode = c?.mode ?? "manual";
  const external = kind === "external";
  // An external agent's thinking happens in its own window: we can't see it, so never "Thinking…".
  const busy = !external && mode === "active" && !!c?.busy;
  const word = mode === "active" ? (busy ? "Thinking…" : "On") : mode === "paused" ? "Paused" : "Off";
  const waiting = (c?.proposals ?? []).filter((p) => p.state === "pending").length + tasks.filter((t) => t.status === "finished_unverified").length + ny.prompts.length;
  return { title: "Coordinator", status: external ? `${word} · your agent` : word, waiting, lamp: mode === "active" ? (busy ? "busy" : "on") : "off" };
}

/** Whether your own agent (external) has called in recently: a long-polling agent calls at least every minute. */
export function agentSeen(lastToolCallAt: number | null, now: number): { connected: boolean; text: string } {
  if (!lastToolCallAt) return { connected: false, text: "Not connected since Switchboard started." };
  const connected = now - lastToolCallAt < 10 * 60_000;
  return { connected, text: connected ? `Connected: last call ${relative(lastToolCallAt, now)}.` : `Last call ${relative(lastToolCallAt, now)}.` };
}
