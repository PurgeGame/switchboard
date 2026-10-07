import { ProviderIcon } from "./ProviderIcon.tsx";
import { useMemo, useState } from "react";
import type { AttentionItem, PerspectiveGroup, Session } from "../../../shared/types.ts";
import { autoHandled, subjectName, KIND, recentlyResolved, RESOLUTION } from "../attention.ts";
import { relative } from "../format.ts";
import { setInboxOpen, useNow, useStore } from "../store.ts";
import { Chevron } from "./Icons.tsx";
import { NeedsYou } from "./NeedsYou.tsx";

function AutoHandledList({ items, sessions, groups, now }: { items: AttentionItem[]; sessions: Record<string, Session>; groups: Record<string, PerspectiveGroup>; now: number }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <section>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-y border-line px-4 py-1.5 text-left text-[12px] font-semibold text-ink-3 hover:text-ink-2"
      >
        <Chevron width={12} height={12} className={open ? "rotate-90" : ""} />
        Auto-handled <span className="font-normal">{items.length}</span>
      </button>
      {open && (
        <ul>
          {items.map((i) => {
            const name = subjectName(i, sessions, groups);
            const quote = typeof i.meta.autoQuote === "string" ? i.meta.autoQuote : null;
            const reason = typeof i.meta.autoRule === "string" ? `Rule: ${i.meta.autoRule}` : typeof i.meta.autoReason === "string" ? i.meta.autoReason : null;
            return (
              <li key={i.id} className="space-y-1 border-b border-line/60 px-4 py-2 text-[12px]">
                <div className="flex items-baseline gap-2 text-ink-3">
                  {sessions[i.sessionId] && <ProviderIcon provider={sessions[i.sessionId].provider} />}
                  <span className="min-w-0 flex-1 truncate text-ink-2">{name}</span>
                  <time>{relative(i.resolvedAt, now)}</time>
                </div>
                {i.meta.autoRule ? <details><summary className="cursor-pointer text-ink-2">{i.title}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-ink-2">{i.text}</pre></details> : <p className="line-clamp-3 whitespace-pre-wrap text-ink-2">{i.text ?? i.title}</p>}
                {quote && <p className="text-ink-3">You said: "{quote}"</p>}
                {reason && <p className="text-ink-3">{reason}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ResolvedList({ items, sessions, groups, now }: { items: AttentionItem[]; sessions: Record<string, Session>; groups: Record<string, PerspectiveGroup>; now: number }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <section>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-y border-line px-4 py-1.5 text-left text-[12px] font-semibold text-ink-3 hover:text-ink-2"
      >
        <Chevron width={12} height={12} className={open ? "rotate-90" : ""} />
        Recently resolved <span className="font-normal">{items.length}</span>
      </button>
      {open && (
        <ul>
          {items.map((i) => {
            const name = subjectName(i, sessions, groups);
            return (
              <li key={i.id} className="space-y-0.5 border-b border-line/60 px-4 py-2 text-[12px] text-ink-3">
                <div className="flex items-baseline gap-2">
                  {sessions[i.sessionId] && <ProviderIcon provider={sessions[i.sessionId].provider} />}
                  <span className="min-w-0 flex-1 truncate text-ink-2">{name}</span>
                  <span>{KIND[i.kind].label}</span>
                  <time>{relative(i.resolvedAt, now)}</time>
                </div>
                <p className="truncate">{i.title}</p>
                <p>
                  {i.resolution ? RESOLUTION[i.resolution] : "resolved"}
                  {i.resolutionNote ? ` · ${i.resolutionNote}` : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function Inbox() {
  const attention = useStore((s) => s.attention);
  const sessions = useStore((s) => s.sessions);
  const perspectiveGroups = useStore((s) => s.groups);
  const error = useStore((s) => s.attentionError);
  const now = useNow();
  const resolved = useMemo(() => recentlyResolved(attention).filter((i) => i.resolution !== "auto"), [attention]);
  const auto = useMemo(() => autoHandled(attention), [attention]);


  return (
    <aside id="attention-inbox" aria-label="Attention inbox" className="fixed bottom-0 right-0 top-11 z-30 flex w-[min(440px,100vw)] flex-col border-l border-line-strong bg-panel shadow-2xl lg:static lg:z-auto lg:w-[400px] lg:shrink-0 lg:shadow-none">
      <div className="flex items-center border-b border-line px-4 py-2">
        <h2 className="flex-1 text-[14px] font-semibold">Inbox</h2>
        <button onClick={() => setInboxOpen(false)} aria-label="Close inbox" className="min-h-11 min-w-11 rounded px-2 text-[12px] text-ink-3 hover:bg-hover hover:text-ink">
          Close <kbd className="font-mono text-[10px]">Esc</kbd>
        </button>
      </div>
      {error && (
        <p role="alert" className="border-b border-red/40 bg-red/10 px-4 py-1.5 text-red">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <NeedsYou />
        <AutoHandledList items={auto} sessions={sessions} groups={perspectiveGroups} now={now} />
        <ResolvedList items={resolved} sessions={sessions} groups={perspectiveGroups} now={now} />
      </div>
    </aside>
  );
}
