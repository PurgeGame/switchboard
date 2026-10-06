import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadOlder, useStore, type Transcript as TranscriptState } from "../store.ts";
import { buildTranscript } from "./transcriptItems.ts";
import { OutboxBubble } from "./OutboxBubble.tsx";
import { EventItem, ToolRun } from "./TranscriptItems.tsx";

const BOTTOM_SLACK = 80;
const TOP_TRIGGER = 60;

export function Transcript({ sessionId, transcript }: { sessionId: string; transcript: TranscriptState | undefined }) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prev = useRef({ first: undefined as number | undefined, count: 0, height: 0 });
  const [pill, setPill] = useState(false);

  const events = transcript?.events;
  const outbox = useStore((s) => s.outbox[sessionId]);
  const model = useMemo(() => buildTranscript(events ?? [], outbox), [events, outbox]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !events) return;
    const first = events[0]?.id;
    const before = prev.current;
    if (before.count > 0 && first !== before.first && events.length > before.count) {
      el.scrollTop += el.scrollHeight - before.height; // older page prepended: hold position
    } else if (events.length > before.count) {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
      else if (before.count > 0) setPill(true);
    }
    prev.current = { first, count: events.length, height: el.scrollHeight };
  }, [events]);

  const outboxCount = outbox?.length ?? 0;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [outboxCount]);

  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight <= el.clientHeight && transcript?.hasMore && !transcript.loading) void loadOlder(sessionId);
  }, [events, transcript?.hasMore, transcript?.loading, sessionId]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    if (atBottom.current) setPill(false);
    if (el.scrollTop < TOP_TRIGGER) void loadOlder(sessionId);
  };

  const jumpToEnd = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto px-3 py-4 sm:px-6" role="log" aria-label="Session transcript">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {transcript?.hasMore === false && events && events.length > 0 && (
            <p className="py-2 text-center text-[11px] text-ink-3">Start of recorded history</p>
          )}
          {transcript?.loading && <p className="py-2 text-center text-[11px] text-ink-3">Loading…</p>}
          {transcript?.error && <p className="rounded border border-red/40 p-2 text-red">{transcript.error}</p>}
          {!transcript?.loading && events?.length === 0 && !transcript?.error && (
            <p className="py-8 text-center text-ink-3">No events recorded for this session yet.</p>
          )}
          {model.items.map((item) =>
            item.kind === "tools" ? (
              <ToolRun key={item.key} calls={item.calls} results={model.resultsByToolUse} />
            ) : item.kind === "outbox" ? (
              <OutboxBubble key={item.key} message={item.message} />
            ) : (
              <EventItem key={item.key} event={item.event} />
            ),
          )}
        </div>
      </div>
      {pill && (
        <button
          onClick={jumpToEnd}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line-strong bg-raised px-3 py-1 text-[12px] text-ink shadow-lg hover:bg-hover"
        >
          new activity ↓
        </button>
      )}
    </div>
  );
}
