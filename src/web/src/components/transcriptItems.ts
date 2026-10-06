import { sameText } from "../send.ts";
import type { OutboxMessage, SbEvent } from "../../../shared/types.ts";

export type Item =
  | { kind: "event"; key: string; event: SbEvent }
  | { kind: "tools"; key: string; calls: SbEvent[] }
  | { kind: "outbox"; key: string; message: OutboxMessage };

const ECHO_WINDOW_MS = 2 * 60_000;

export interface TranscriptModel {
  items: Item[];
  resultsByToolUse: Map<string, SbEvent>;
}

const keyOf = (e: SbEvent, i: number) => (e.id !== undefined ? `e${e.id}` : `s${e.sourceId}-${i}`);

/** Folds raw events into display items: tool results attach to their call, consecutive calls group. */
export function buildTranscript(events: SbEvent[], outbox: OutboxMessage[] = []): TranscriptModel {
  const items: Item[] = [];
  const resultsByToolUse = new Map<string, SbEvent>();
  const echoes = new Set<number>();
  const pending = outbox.filter((m) => m.state === "accepted");
  events.forEach((e, i) => {
    if (e.type === "user_msg" || e.type === "peer_msg") {
      // The outbox bubble carries delivery state, so it wins over the transcript echo of the same message.
      const echoOf = pending.find((m) => !echoes.has(m.id) && e.ts >= m.createdAt - 5000 && e.ts <= m.createdAt + ECHO_WINDOW_MS && sameText(m.text, String(e.data.text ?? "")));
      if (echoOf) {
        echoes.add(echoOf.id);
        return;
      }
    }
    if (e.type === "tool_result") {
      const id = e.data.toolUseId;
      if (typeof id === "string") resultsByToolUse.set(id, e);
      return; // results never stand alone; they must not break a run of calls
    }
    const last = items[items.length - 1];
    if (e.type === "tool_call") {
      if (last?.kind === "tools") last.calls.push(e);
      else items.push({ kind: "tools", key: keyOf(e, i), calls: [e] });
      return;
    }
    items.push({ kind: "event", key: keyOf(e, i), event: e });
  });
  for (const m of [...outbox].sort((a, b) => a.createdAt - b.createdAt)) {
    const at = items.findIndex((it) => (it.kind === "event" ? it.event.ts : it.kind === "tools" ? it.calls[0].ts : it.message.createdAt) > m.createdAt);
    items.splice(at === -1 ? items.length : at, 0, { kind: "outbox", key: `o${m.id}`, message: m });
  }
  return { items, resultsByToolUse };
}
