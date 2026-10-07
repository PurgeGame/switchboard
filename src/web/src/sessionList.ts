import type { AttentionItem, Session } from "../../shared/types.ts";
import type { GroupFilter, ProviderFilter } from "./store.ts";
import { compareSessions } from "./attention.ts";
import { projectOf, sessionTitle, STATUS, STATUS_GROUPS, workerFolder } from "./status.ts";
import type { Execution } from "../../shared/types.ts";

export interface ProjectGroup {
  key: string;
  label: string;
  sessions: Session[];
}

export interface ListModel {
  projects: ProjectGroup[];
  ended: Session[];
  /** Live short-lived agents the coordinator started (delegated workers, perspective members): kept out of the projects so the list holds still. */
  background: Session[];
  /** Visible rows in display order, for keyboard navigation. */
  orderedIds: string[];
  total: number;
  /** Unread matches for the current search/provider, regardless of the selected status filter. */
  unreadCount: number;
}

export interface ListFilters {
  search: string;
  provider: ProviderFilter;
  group: GroupFilter;
  endedOpen: boolean;
  backgroundOpen: boolean;
  mainSessionIds?: string[];
  attention: Map<string, AttentionItem[]>;
  lastSeen?: Record<string, number>;
  lastAssistantEvent?: Record<string, number>;
  /**
   * The row order as of the last reorder (the UI refreshes it once a minute), so rows don't jump
   * around as statuses change. Sessions it doesn't know yet go first, in urgency order.
   */
  order?: string[];
}

export function isUnread(lastSeen: Record<string, number>, s: Session, lastAssistantEvent: Record<string, number>): boolean {
  return (lastAssistantEvent[s.id] ?? 0) > (lastSeen[s.id] ?? 0);
}

function matches(s: Session, f: ListFilters): boolean {
  if (f.provider !== "all" && s.provider !== f.provider) return false;
  if (f.group === "unread") {
    if (!isUnread(f.lastSeen ?? {}, s, f.lastAssistantEvent ?? {})) return false;
  } else if (f.group !== "all") {
    const group = STATUS_GROUPS.find((g) => g.id === f.group);
    if (!group?.members.includes(s.execution)) return false;
  }
  const q = f.search.trim().toLowerCase();
  if (!q) return true;
  return [sessionTitle(s), s.name, s.cwd, s.goal, s.project].some((v) => v?.toLowerCase().includes(q));
}

/**
 * An open session nobody has used yet (no prompt, not working, nothing waiting on you). Hidden
 * unless Switchboard started it, so the list shows real work only.
 */
function isEmpty(s: Session, f: ListFilters): boolean {
  if (s.meta.coordinatorAgent) return true; // the coordinator's own process is plumbing, not a session of yours
  if (s.firstPrompt || s.goal || s.execution === "working" || s.meta.launchedHere) return false;
  if ((f.attention.get(s.id) ?? []).length) return false;
  return true;
}

/**
 * Started by the coordinator (the daemon sets meta.background), not by you. A session in one of its
 * worktrees counts too: after a /clear it has a new id the coordinator doesn't know.
 */
export const isBackground = (s: Session) => !!s.meta.background || !!workerFolder(s.cwd);

export function buildListModel(sessions: Session[], f: ListFilters): ListModel {
  const urgency = compareSessions(f.attention);
  const rank = f.order ? new Map(f.order.map((id, i) => [id, i])) : null;
  const compare = rank
    ? (a: Session, b: Session) => {
        const ra = rank.get(a.id) ?? -1, rb = rank.get(b.id) ?? -1;
        return ra !== rb ? ra - rb : urgency(a, b);
      }
    : urgency;
  const shown = sessions.filter((s) => matches(s, f) && !isEmpty(s, f));
  const unreadCount = sessions.filter((s) => matches(s, { ...f, group: "unread" }) && !isEmpty(s, f)).length;
  const liveAll = shown.filter((s) => s.execution !== "ended").sort(compare);
  const pinned = new Set(f.mainSessionIds);
  const inBackground = (s: Session) => isBackground(s) && !pinned.has(s.id);
  const live = liveAll.filter((s) => !inBackground(s));
  const background = liveAll.filter(inBackground);
  const ended = shown.filter((s) => s.execution === "ended").sort(compare);

  const byProject = new Map<string, Session[]>();
  for (const s of live) {
    const key = projectOf(s);
    byProject.set(key, [...(byProject.get(key) ?? []), s]);
  }
  // Rows are already attention-sorted, so a project's first row is its most urgent.
  const projects = [...byProject.entries()]
    .map(([key, list]) => ({ key, label: key, sessions: list }))
    .sort((a, b) => compare(a.sessions[0], b.sessions[0]));

  const endedVisible = f.endedOpen || f.search.trim() !== "" || f.group === "unread";
  // A filter or search is looking for something specific: don't leave matches behind a collapsed section.
  const backgroundVisible = f.backgroundOpen || f.search.trim() !== "" || f.group !== "all";
  const orderedIds = [...projects.flatMap((p) => p.sessions), ...(backgroundVisible ? background : []), ...(endedVisible ? ended : [])].map((s) => s.id);
  return { projects, ended, background, orderedIds, total: shown.length, unreadCount };
}

/** Order the summary reads in: what needs you first, then trouble, work under way, the rest. */
const SUMMARY_ORDER: Execution[] = ["waiting_answer", "waiting_approval", "failed", "interrupted", "working", "stalled", "idle", "unknown", "ended"];

/** A folder group's sessions by state, for its heading: one entry per state present, most urgent first. */
export function stateSummary(sessions: Session[]): { execution: Execution; count: number; label: string }[] {
  const counts = new Map<Execution, number>();
  for (const s of sessions) counts.set(s.execution, (counts.get(s.execution) ?? 0) + 1);
  return SUMMARY_ORDER.filter((x) => counts.has(x)).map((execution) => ({ execution, count: counts.get(execution)!, label: STATUS[execution].label }));
}
