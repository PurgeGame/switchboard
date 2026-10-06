import { useEffect } from "react";
import type { AttentionItem, Session } from "../../../shared/types.ts";
import type { ListModel } from "../sessionList.ts";
import { baseName, shortPath } from "../format.ts";
import {
  isUnread,
  selectSession,
  setGroupFilter,
  setProviderFilter,
  setSearch,
  toggleBackground,
  toggleEnded,
  useNow,
  useStore,
  COORDINATOR_ID,
  openSession,
  type GroupFilter,
  type ProviderFilter,
} from "../store.ts";
import { STATUS_GROUPS } from "../status.ts";
import { Chevron, SearchIcon } from "./Icons.tsx";
import { Launcher } from "./Launcher.tsx";
import { homeRow } from "../home.ts";
import { SessionRow } from "./SessionRow.tsx";

const PROVIDERS: { id: ProviderFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "other", label: "Other" },
];

function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={props.label} className="flex flex-wrap gap-1">
      {props.options.map((o) => (
        <button
          key={o.id}
          aria-pressed={props.value === o.id}
          onClick={() => props.onChange(o.id)}
          className={`rounded px-2 py-0.5 text-[11px] ${
            props.value === o.id ? "bg-raised text-ink ring-1 ring-line-strong" : "text-ink-3 hover:text-ink-2"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const GROUP_OPTIONS: { id: GroupFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "attention", label: "Needs you" },
  { id: "active", label: "Working" },
];

/**
 * Home, pinned first: the coordinator (on/off, and how many things wait for you in its chat), or
 * with no coordinator configured, a plain "Needs you" row (D34).
 */
function HomeRow({ selected }: { selected: boolean }) {
  const kind = useStore((s) => s.coordinatorAgent);
  const c = useStore((s) => s.coordinator);
  const tasks = useStore((s) => s.coordination.tasks);
  const attention = useStore((s) => s.attention);
  const { title, status, waiting, lamp } = homeRow(kind, c, tasks, attention);
  const showStatus = kind === "none" ? false : (c?.mode ?? "manual") !== "active";
  return (
    <button
      data-session-id={COORDINATOR_ID}
      aria-current={selected ? "true" : undefined}
      onClick={() => openSession(COORDINATOR_ID)}
      className={`relative flex w-full items-center gap-2.5 border-b border-line py-2.5 pl-4 pr-3 text-left ${selected ? "bg-raised" : "hover:bg-hover"}`}
    >
      <span aria-hidden className={`absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r ${waiting ? "bg-amber" : selected ? "bg-focus" : "bg-transparent"}`} />
      <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${lamp === "busy" ? "lamp-pulse bg-blue" : lamp === "on" ? "bg-green" : "bg-line-strong"}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold">{title}</span>
        <span className="block truncate text-[11px] text-ink-3">{waiting ? (
            <>
              {/* Not running is worth seeing even when something needs you. */}
              {showStatus && `${status} · `}
              <span className="text-amber">
                {waiting} need{waiting === 1 ? "s" : ""} you
              </span>
            </>
          ) : (
            status
          )}
        </span>
      </span>
    </button>
  );
}

function ProjectHeading({ path, count }: { path: string; count: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-baseline gap-2 border-y border-line bg-panel/95 px-3 py-1 backdrop-blur" title={path}>
      <span className="truncate text-[12px] font-semibold text-ink-2">{path.startsWith("/") ? baseName(path) : path}</span>
      <span className="flex-1" />
      <span className="text-[11px] text-ink-3">{count}</span>
    </div>
  );
}

export function SessionList(props: {
  model: ListModel;
  attention: Map<string, AttentionItem[]>;
  searchRef: React.RefObject<HTMLInputElement | null>;
}) {
  const { model, attention, searchRef } = props;
  const search = useStore((s) => s.search);
  const provider = useStore((s) => s.providerFilter);
  const group = useStore((s) => s.groupFilter);
  const selectedId = useStore((s) => s.selectedId);
  const endedOpen = useStore((s) => s.endedOpen);
  const backgroundOpen = useStore((s) => s.backgroundOpen);
  const lastSeen = useStore((s) => s.lastSeen);
  const autoPending = useStore((s) => s.autoPending);
  const now = useNow();

  useEffect(() => {
    if (!selectedId) return;
    document.querySelector(`[data-session-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const open = (id: string) => selectSession(id, true);
  const renderRow = (s: Session) => (
    <SessionRow key={s.id} session={s} selected={s.id === selectedId} unread={isUnread(lastSeen, s)}
      attention={attention.get(s.id)}
      autoDeadline={autoPending[s.id]?.deadline} now={now} onOpen={open} />
  );
  const endedShown = endedOpen || search.trim() !== "";
  const backgroundShown = backgroundOpen || search.trim() !== "" || group !== "all";

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <Launcher />
      <div className="space-y-2 border-b border-line p-3">
        <label className="relative block">
          <span className="sr-only">Search sessions</span>
          <SearchIcon className="pointer-events-none absolute left-2.5 top-2 text-ink-3" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, folder, goal"
            className="w-full rounded-md border border-line bg-bg py-1.5 pl-8 pr-8 text-[13px] placeholder:text-ink-3 focus-visible:border-focus"
          />
          <kbd className="pointer-events-none absolute right-2 top-1.5 rounded border border-line px-1 font-mono text-[10px] text-ink-3">/</kbd>
        </label>
        <Segmented label="Show" value={group} options={GROUP_OPTIONS} onChange={setGroupFilter} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <HomeRow selected={selectedId === COORDINATOR_ID} />
        {model.total === 0 && (
          <p className="p-4 text-ink-3">{search || provider !== "all" || group !== "all" ? "No sessions match these filters." : "No sessions yet. Start Claude Code or Codex and it will appear here."}</p>
        )}
        {model.projects.map((p) => (
          <section key={p.key} aria-label={`Project ${p.label}`}>
            <ProjectHeading path={p.label} count={p.sessions.length} />
            <ul className="divide-y divide-line/60">{p.sessions.map(renderRow)}</ul>
          </section>
        ))}
        {model.background.length > 0 && (
          <section aria-label="Background agents">
            <button
              onClick={toggleBackground}
              aria-expanded={backgroundShown}
              className="flex w-full items-center gap-2 border-y border-line bg-panel px-3 py-1.5 text-left text-[12px] font-semibold text-ink-3 hover:text-ink-2"
            >
              <Chevron className={backgroundShown ? "rotate-90" : ""} width={12} height={12} />
              Background agents ({model.background.length})
              {model.backgroundWaiting > 0 && <span className="font-normal text-amber">{model.backgroundWaiting} need{model.backgroundWaiting === 1 ? "s" : ""} you</span>}
            </button>
            {backgroundShown && <ul className="divide-y divide-line/60">{model.background.map(renderRow)}</ul>}
          </section>
        )}
        {model.ended.length > 0 && (
          <section aria-label="Ended sessions">
            <button
              onClick={toggleEnded}
              aria-expanded={endedShown}
              className="flex w-full items-center gap-2 border-y border-line bg-panel px-3 py-1.5 text-left text-[12px] font-semibold text-ink-3 hover:text-ink-2"
            >
              <Chevron className={endedShown ? "rotate-90" : ""} width={12} height={12} />
              Ended
              <span className="font-normal">{model.ended.length}</span>
            </button>
            {endedShown && <ul className="divide-y divide-line/60">{model.ended.map(renderRow)}</ul>}
          </section>
        )}
      </div>
    </div>
  );
}
