import type { AttentionItem, Session } from "../../shared/types.ts";
import type { GroupFilter, ProviderFilter } from "./store.ts";
import { compareSessions } from "./attention.ts";
import { projectOf, STATUS_GROUPS } from "./status.ts";

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
  /** How many of them are waiting on you (shown even while the section is collapsed). */
  backgroundWaiting: number;
  /** Visible rows in display order, for keyboard navigation. */
  orderedIds: string[];
  total: number;
}

export interface ListFilters {
  search: string;
  provider: ProviderFilter;
  group: GroupFilter;
  endedOpen: boolean;
  backgroundOpen: boolean;
  attention: Map<string, AttentionItem[]>;
  /**
   * The row order as of the last reorder (the UI refreshes it once a minute), so rows don't jump
   * around as statuses change. Sessions it doesn't know yet go first, in urgency order.
   */
  order?: string[];
}

function matches(s: Session, f: ListFilters): boolean {
  if (f.provider !== "all" && s.provider !== f.provider) return false;
  if (f.group !== "all") {
    const group = STATUS_GROUPS.find((g) => g.id === f.group);
    if (!group?.members.includes(s.execution)) return false;
  }
  const q = f.search.trim().toLowerCase();
  if (!q) return true;
  return [s.name, s.cwd, s.goal, s.project].some((v) => v?.toLowerCase().includes(q));
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

/** Started by the coordinator (the daemon sets meta.background), not by you. */
export const isBackground = (s: Session) => !!s.meta.background;

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
  const liveAll = shown.filter((s) => s.execution !== "ended").sort(compare);
  const live = liveAll.filter((s) => !isBackground(s));
  const background = liveAll.filter(isBackground);
  const waiting = STATUS_GROUPS.find((g) => g.id === "attention")!.members;
  const backgroundWaiting = background.filter((s) => waiting.includes(s.execution)).length;
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

  const endedVisible = f.endedOpen || f.search.trim() !== "";
  // A filter or search is looking for something specific: don't leave matches behind a collapsed section.
  const backgroundVisible = f.backgroundOpen || f.search.trim() !== "" || f.group !== "all";
  const orderedIds = [...projects.flatMap((p) => p.sessions), ...(backgroundVisible ? background : []), ...(endedVisible ? ended : [])].map((s) => s.id);
  return { projects, ended, background, backgroundWaiting, orderedIds, total: shown.length };
}

