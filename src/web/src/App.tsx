import { useEffect, useMemo, useRef, useState } from "react";
import { Inbox } from "./components/Inbox.tsx";
import { Header } from "./components/Header.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { SessionPane } from "./components/SessionPane.tsx";
import { CoordinatorPane } from "./components/CoordinatorPane.tsx";
import { HomePane } from "./components/HomePane.tsx";
import { useAttentionChrome } from "./attentionChrome.ts";
import { useShortcuts } from "./keys.ts";
import { useCopyOnSelect } from "./copyOnSelect.ts";
import { buildListModel } from "./sessionList.ts";
import { bySession, countAttention, groupInbox, openItems } from "./attention.ts";
import { COORDINATOR_ID, toggleInbox, setView, useStore } from "./store.ts";

export function App() {
  const sessionsById = useStore((s) => s.sessions);
  const conn = useStore((s) => s.conn);
  const authError = useStore((s) => s.authError);
  const view = useStore((s) => s.view);
  const selectedId = useStore((s) => s.selectedId);
  const mobilePane = useStore((s) => s.mobilePane);
  const search = useStore((s) => s.search);
  const provider = useStore((s) => s.providerFilter);
  const group = useStore((s) => s.groupFilter);
  const endedOpen = useStore((s) => s.endedOpen);
  const backgroundOpen = useStore((s) => s.backgroundOpen);
  const attention = useStore((s) => s.attention);
  const inboxOpen = useStore((s) => s.inboxOpen);
  const groups = useStore((s) => s.groups);
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const coordinatorAgent = useStore((s) => s.coordinatorAgent);
  const searchRef = useRef<HTMLInputElement>(null);

  const sessions = useMemo(() => Object.values(sessionsById), [sessionsById]);
  const open = useMemo(() => openItems(attention), [attention]);
  const openBySession = useMemo(() => bySession(open), [open]);
  const counts = useMemo(() => countAttention(open, sessions), [open, sessions]);
  const inboxOrder = useMemo(() => groupInbox(open).flatMap((g) => g.items.map((i) => i.id)), [open]);
  // Rows move at most once a minute (or when you change the filter/search), not on every status change.
  const [order, setOrder] = useState<string[] | undefined>(undefined);
  const fullOrder = useRef<() => string[]>(() => []);
  fullOrder.current = () => buildListModel(sessions, { search, provider, group, endedOpen: true, backgroundOpen: true, attention: openBySession }).orderedIds;
  useEffect(() => setOrder(fullOrder.current()), [search, provider, group]);
  // The first snapshot can predate the session list arriving: take one as soon as there is one.
  const hasSessions = sessions.length > 0;
  useEffect(() => {
    if (hasSessions) setOrder((o) => (o?.length ? o : fullOrder.current()));
  }, [hasSessions]);
  useEffect(() => {
    const t = setInterval(() => setOrder(fullOrder.current()), 60_000);
    return () => clearInterval(t);
  }, []);
  const model = useMemo(
    () => buildListModel(sessions, { search, provider, group, endedOpen, backgroundOpen, attention: openBySession, order }),
    [sessions, search, provider, group, endedOpen, backgroundOpen, openBySession, order],
  );

  useAttentionChrome(counts.needYou, counts.finished > 0);
  const copied = useCopyOnSelect();
  useShortcuts(model.orderedIds, inboxOrder, searchRef);

  const selected = selectedId ? sessionsById[selectedId] : undefined;
  const detailOnly = mobilePane === "detail";

  return (
    <div className="flex h-full flex-col">
      <Header counts={counts} conn={conn} authError={authError} view={view} onView={setView} inboxOpen={inboxOpen} onInbox={toggleInbox} />
      {authError && (
        <p role="alert" className="border-b border-red/40 bg-red/10 px-4 py-1.5 text-red">
          {authError}
        </p>
      )}
      {/* On wide screens the inbox is a column that pushes the view over; on narrow ones it overlays. */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {(
            <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
              <nav aria-label="Sessions" className={`min-h-0 border-r border-line ${detailOnly ? "hidden lg:block" : ""}`}>
                <SessionList model={model} attention={openBySession} searchRef={searchRef} />
              </nav>
              <div className={`min-h-0 min-w-0 ${detailOnly ? "" : "hidden lg:block"}`}>
                {selectedId === COORDINATOR_ID || !selected ? coordinatorAgent === "none" ? <HomePane /> : <CoordinatorPane /> : <SessionPane session={selected} />}
              </div>
            </main>
          )}
        </div>
        {inboxOpen && <Inbox />}
      </div>
      {copied && (
        <div role="status" className="pointer-events-none fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-md bg-raised px-3 py-1 text-[12px] text-ink-2 shadow-lg ring-1 ring-line-strong">
          {copied}
        </div>
      )}
    </div>
  );
}
