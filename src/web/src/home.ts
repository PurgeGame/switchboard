// Home (D34): the first row of the list and the pane it opens. With a coordinator (built-in or your
// own agent) it is the coordinator; with none it is a plain "Needs you" list of permission prompts
// and waiting sessions. Pure functions, shared by the row, the panes and tests.
import type { AttentionItem, CoordinatorAgentKind, CoordinatorState, Task } from "../../shared/types.ts";
import { needsYouItems } from "../../shared/needs-you.ts";
import { openItems } from "./attention.ts";
import { relative } from "./format.ts";

/**
 * Prompts you can answer here (held by Switchboard), oldest first; the other items waiting on you
 * (a session's question, a coordinator escalation, a failure, a prompt only its session can answer),
 * oldest first; and how many of those there are.
 */
export function needsYou(attention: Record<number, AttentionItem>) {
  const open = openItems(attention).sort((a, b) => a.createdAt - b.createdAt);
  const prompts = open.filter((i) => i.kind === "approval" && typeof i.meta.answerKey === "string");
  const others = open.filter((i) => !prompts.includes(i));
  return { prompts, others, waiting: others.length };
}

/** What the coordinator has waiting on you: its pending cards, plan tasks that couldn't start, work waiting for "Looks good". */
export function coordinatorWaiting(c: CoordinatorState | null, tasks: Task[]) {
  const proposals = (c?.proposals ?? []).filter((p) => p.state === "pending");
  const failed = (c?.plans ?? []).flatMap((plan) => plan.tasks.filter((t) => t.state === "failed").map((task) => ({ plan, task })));
  const done = tasks.filter((t) => t.status === "finished_unverified");
  return { proposals, failed, done, count: proposals.length + failed.length + done.length };
}

export interface HomeRow {
  title: string;
  status: string;
  waiting: number;
  lamp: "on" | "busy" | "off";
}

/** kind null: not known yet (before the first message from the daemon): today's coordinator row. */
export function homeRow(kind: CoordinatorAgentKind | null, c: CoordinatorState | null, tasks: Task[], attention: Record<number, AttentionItem>): HomeRow {
  const total = needsYouItems({ attention: Object.values(attention), coordinator: c, tasks, sessions: {} }).length;
  if (kind === "none") {
    const waiting = total;
    return { title: "Needs you", status: waiting ? `${waiting} need${waiting === 1 ? "s" : ""} you` : "Nothing right now", waiting, lamp: "off" };
  }
  const mode = c?.mode ?? "manual";
  const external = kind === "external";
  // An external agent's thinking happens in its own window: we can't see it, so never "Thinking…".
  const busy = !external && mode === "active" && !!c?.busy;
  const word = mode === "active" ? (busy ? "Thinking…" : "On") : mode === "paused" ? "Paused" : "Off";
  const waiting = total;
  return { title: "Coordinator", status: external ? `${word} · your agent` : word, waiting, lamp: mode === "active" ? (busy ? "busy" : "on") : "off" };
}

/** Whether your own agent (external) has called in recently: a long-polling agent calls at least every minute. */
export function agentSeen(lastToolCallAt: number | null, now: number): { connected: boolean; text: string } {
  if (!lastToolCallAt) return { connected: false, text: "Not connected since Switchboard started." };
  const connected = now - lastToolCallAt < 10 * 60_000;
  return { connected, text: connected ? `Connected: last call ${relative(lastToolCallAt, now)}.` : `Last call ${relative(lastToolCallAt, now)}.` };
}
