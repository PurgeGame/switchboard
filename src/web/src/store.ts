import { useSyncExternalStore } from "react";
import type { CoordinatorAgentKind, CoordinatorState, AttentionItem, Claim, Conflict, Objective, OutboxMessage, PerspectiveGroup, SbEvent, ServerPush, Session, SystemStats, Task } from "../../shared/types.ts";
import { ackAttention as postAck, fetchAllAttention, fetchCoordination, fetchCoordinator, fetchEvents, fetchGovernor, type GovernorSnapshot, fetchOutbox, fetchSessions, wsUrl } from "./api.ts";
import type { StatusGroup } from "./status.ts";
import { parseDeepLink, writeDeepLink } from "./deeplink.ts";

/** workspace: the session list and one chat (the coordinator is the first entry). perspectives: compare answers. */
export type View = "workspace";
/** The coordinator appears in the session list under this id. */
export const COORDINATOR_ID = "coordinator";
export type ConnState = "connecting" | "open" | "closed";
export type ProviderFilter = "all" | "claude" | "codex" | "other";
export type GroupFilter = "all" | StatusGroup;

export interface Transcript {
  events: SbEvent[];
  loading: boolean;
  hasMore: boolean;
  error: string | null;
}

export interface AutoPending {
  itemId: number | null;
  deadline: number;
  reason: string | null;
  quote: string | null;
}

export interface CoordinationState {
  objectives: Objective[];
  tasks: Task[];
  claims: Claim[];
  conflicts: Conflict[];
}

export interface Prefs {
  notifications: boolean;
  sound: boolean;
}

export interface State {
  sessions: Record<string, Session>;
  system: SystemStats | null;
  conn: ConnState;
  authError: string | null;
  view: View;
  selectedId: string | null;
  /** Narrow screens: which pane is showing. */
  mobilePane: "list" | "detail";
  transcripts: Record<string, Transcript>;
  /** Every attention item known to this page, open or resolved. */
  attention: Record<number, AttentionItem>;
  outbox: Record<string, OutboxMessage[]>;
  groups: Record<string, PerspectiveGroup>;
  coordination: CoordinationState;
  coordinator: CoordinatorState | null;
  /** Which coordinator the daemon runs (D34); null until its first message. "none": no coordinator anywhere. */
  coordinatorAgent: CoordinatorAgentKind | null;
  governor: GovernorSnapshot | null;
  selectedTaskId: string | null;
  /** Group open in the Perspectives view; null shows the "Ask several" form. */
  selectedGroupId: string | null;
  /** Auto-continue countdowns, by session. */
  autoPending: Record<string, AutoPending>;
  /** Brief "auto-continued" notes, by session. */
  autoNotes: Record<string, string>;
  attentionError: string | null;
  /** Inbox question item whose inline reply composer is open. */
  replyOpenId: number | null;
  inboxOpen: boolean;
  inboxSelectedId: number | null;
  prefs: Prefs;
  /** Last event id the user has seen per session; persisted. */
  lastSeen: Record<string, number>;
  search: string;
  providerFilter: ProviderFilter;
  groupFilter: GroupFilter;
  endedOpen: boolean;
  /** Background agents section expanded; persisted. */
  backgroundOpen: boolean;
  /** Work-context drawer, used below the xl breakpoint where it is not a fixed pane. */
  contextOpen: boolean;
}

const PAGE = 200;
const SEEN_KEY = "switchboard.lastSeen";
const PREFS_KEY = "switchboard.prefs";
const BACKGROUND_KEY = "switchboard.backgroundOpen";

function loadBackgroundOpen(): boolean {
  try {
    return localStorage.getItem(BACKGROUND_KEY) === "1";
  } catch {
    return false;
  }
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return { notifications: p.notifications === true, sound: p.sound === true };
  } catch {
    return { notifications: false, sound: false };
  }
}

function loadSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function saveSeen(seen: Record<string, number>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Storage can be blocked; unread tracking then lasts for this page only.
  }
}

let state: State = {
  sessions: {},
  system: null,
  conn: "connecting",
  authError: null,
  view: "workspace",
  selectedId: COORDINATOR_ID,
  mobilePane: "list",
  transcripts: {},
  attention: {},
  outbox: {},
  groups: {},
  coordination: { objectives: [], tasks: [], claims: [], conflicts: [] },
  coordinator: null,
  coordinatorAgent: null,
  selectedTaskId: null,
  governor: null,
  selectedGroupId: null,
  autoPending: {},
  autoNotes: {},
  attentionError: null,
  replyOpenId: null,
  inboxOpen: false,
  inboxSelectedId: null,
  prefs: loadPrefs(),
  lastSeen: loadSeen(),
  search: "",
  providerFilter: "all",
  groupFilter: "all",
  endedOpen: false,
  backgroundOpen: loadBackgroundOpen(),
  contextOpen: false,
};

const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
}

export const getState = () => state;

// ---- clock ----------------------------------------------------------------

let now = Date.now();
const clockListeners = new Set<() => void>();
setInterval(() => {
  now = Date.now();
  clockListeners.forEach((l) => l());
}, 1000);

/** Wall-clock ms, refreshed every second, for live-ticking durations. */
export function useNow(): number {
  return useSyncExternalStore(
    (cb) => {
      clockListeners.add(cb);
      return () => clockListeners.delete(cb);
    },
    () => now,
  );
}

// ---- actions --------------------------------------------------------------

export const setView = (view: View) => set(view === state.view ? {} : { view, mobilePane: "list" });
export const setSearch = (search: string) => set({ search });
export const setProviderFilter = (providerFilter: ProviderFilter) => set({ providerFilter });
export const setGroupFilter = (groupFilter: GroupFilter) => set({ groupFilter });
export const toggleEnded = () => set({ endedOpen: !state.endedOpen });
export function toggleBackground() {
  const backgroundOpen = !state.backgroundOpen;
  try {
    localStorage.setItem(BACKGROUND_KEY, backgroundOpen ? "1" : "0");
  } catch {
    // The section then stays as set for this page only.
  }
  set({ backgroundOpen });
}
export const setContextOpen = (contextOpen: boolean) => set({ contextOpen });
export const showList = () => set({ mobilePane: "list" });

const eventKey = (e: SbEvent) => (e.id !== undefined ? `i${e.id}` : `s${e.sourceId}:${e.type}`);

function mergeEvents(existing: SbEvent[], incoming: SbEvent[]): SbEvent[] {
  const byKey = new Map<string, SbEvent>();
  for (const e of existing) byKey.set(eventKey(e), e);
  for (const e of incoming) byKey.set(eventKey(e), e);
  return [...byKey.values()].sort((a, b) => (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER));
}

function patchTranscript(id: string, patch: Partial<Transcript>) {
  const prev = state.transcripts[id] ?? { events: [], loading: false, hasMore: true, error: null };
  set({ transcripts: { ...state.transcripts, [id]: { ...prev, ...patch } } });
}

function markSeen(id: string) {
  const ids = [state.sessions[id]?.lastEventId ?? 0, ...(state.transcripts[id]?.events.map((e) => e.id ?? 0) ?? [])];
  const top = Math.max(...ids);
  if (top <= (state.lastSeen[id] ?? 0)) return;
  const lastSeen = { ...state.lastSeen, [id]: top };
  saveSeen(lastSeen);
  set({ lastSeen });
}

export async function loadLatest(id: string) {
  patchTranscript(id, { loading: true, error: null });
  try {
    const fetched = await fetchEvents(id, { limit: PAGE });
    const prev = state.transcripts[id];
    patchTranscript(id, {
      events: mergeEvents(prev?.events ?? [], fetched),
      loading: false,
      hasMore: prev?.events.length ? prev.hasMore : fetched.length >= PAGE,
    });
  } catch (err) {
    patchTranscript(id, { loading: false, error: (err as Error).message });
  }
  if (state.selectedId === id) markSeen(id);
}

export async function loadOlder(id: string) {
  const t = state.transcripts[id];
  const oldest = t?.events.find((e) => e.id !== undefined)?.id;
  if (!t || t.loading || !t.hasMore || oldest === undefined) return;
  patchTranscript(id, { loading: true });
  try {
    const older = await fetchEvents(id, { limit: PAGE, before: oldest });
    patchTranscript(id, {
      events: mergeEvents(state.transcripts[id]?.events ?? [], older),
      loading: false,
      hasMore: older.length >= PAGE,
    });
  } catch (err) {
    patchTranscript(id, { loading: false, error: (err as Error).message });
  }
}

export function selectSession(id: string | null, openDetail = false) {
  set({ selectedId: id, mobilePane: openDetail ? "detail" : state.mobilePane });
  writeDeepLink(id === COORDINATOR_ID ? null : id);
  if (!id || id === COORDINATOR_ID) return;
  void loadOutbox(id);
  if (!state.transcripts[id]) void loadLatest(id);
  else markSeen(id);
}

/** Opens a session in the workspace from anywhere (inbox, wall, notification, deep link). */
export function openSession(id: string) {
  set({ view: "workspace", inboxOpen: false });
  selectSession(id, true);
}

export function isUnread(lastSeen: Record<string, number>, s: Session): boolean {
  return s.lastEventId !== null && s.lastEventId > (lastSeen[s.id] ?? 0);
}

// ---- outbox ---------------------------------------------------------------

export function upsertOutbox(m: OutboxMessage) {
  const list = state.outbox[m.sessionId] ?? [];
  const next = list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m];
  set({ outbox: { ...state.outbox, [m.sessionId]: next } });
}

async function loadOutbox(id: string) {
  try {
    const fetched = await fetchOutbox(id);
    const byId = new Map((state.outbox[id] ?? []).map((m) => [m.id, m]));
    for (const m of fetched) byId.set(m.id, m);
    set({ outbox: { ...state.outbox, [id]: [...byId.values()].sort((a, b) => a.createdAt - b.createdAt) } });
  } catch {
    // The transcript still works without delivery states; pushes will fill them in.
  }
}

// ---- attention ------------------------------------------------------------

const newAttentionListeners = new Set<(item: AttentionItem) => void>();

/** Called for each open, non-historical item that this page has not seen before. */
export function onNewAttention(cb: (item: AttentionItem) => void) {
  newAttentionListeners.add(cb);
}

function upsertAttention(items: AttentionItem[]) {
  const next = { ...state.attention };
  for (const i of items) next[i.id] = i;
  set({ attention: next });
}

export function setInboxOpen(inboxOpen: boolean) {
  set({ inboxOpen });
  if (inboxOpen) {
    fetchAllAttention()
      .then(upsertAttention)
      .catch((err: Error) => set({ attentionError: err.message }));
  }
}

/** Re-reads the governor state; used after actions so the UI never waits on a push. */
export function refreshGovernor() {
  void fetchGovernor().then((governor) => set({ governor })).catch(() => undefined);
}

export const selectTask = (selectedTaskId: string | null) => set({ selectedTaskId });

export function selectGroup(id: string | null) {
  set({ selectedGroupId: id, mobilePane: "detail" });
}

/** Opens a group in the Perspectives view from anywhere (inbox, wall). */
/** Groups are the coordinator's business now: opening one shows the coordinator's chat. */
export function openGroup(_id: string) {
  set({ view: "workspace", inboxOpen: false });
  selectSession(COORDINATOR_ID, true);
}

export const setReplyOpen = (replyOpenId: number | null) => set({ replyOpenId });
export const toggleInbox = () => setInboxOpen(!state.inboxOpen);
export const selectInboxItem = (inboxSelectedId: number | null) => set({ inboxSelectedId });

/** Acknowledges optimistically and rolls back if the daemon refuses. */
export async function acknowledge(id: number) {
  const prev = state.attention[id];
  if (!prev || prev.status !== "open") return;
  upsertAttention([{ ...prev, status: "resolved", resolution: "acknowledged", resolvedAt: Date.now(), resolutionNote: null }]);
  set({ attentionError: null });
  try {
    await postAck(id);
  } catch (err) {
    upsertAttention([prev]);
    set({ attentionError: `Could not acknowledge: ${(err as Error).message}` });
  }
}

export function setPrefs(patch: Partial<Prefs>) {
  const prefs = { ...state.prefs, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Preferences then last for this page only.
  }
  set({ prefs });
}

// ---- deep links -----------------------------------------------------------

let pendingDeepLink: string | null = parseDeepLink();

/** Sessions seen for the first time get a baseline so only later activity counts as unread. */
function baselineSeen(sessions: Session[]): Record<string, number> {
  const lastSeen = { ...state.lastSeen };
  let changed = false;
  for (const s of sessions) {
    if (lastSeen[s.id] === undefined && s.lastEventId !== null) {
      lastSeen[s.id] = s.lastEventId;
      changed = true;
    }
  }
  if (changed) saveSeen(lastSeen);
  return lastSeen;
}

function applyPendingDeepLink() {
  if (pendingDeepLink && state.sessions[pendingDeepLink]) {
    openSession(pendingDeepLink);
    pendingDeepLink = null;
  }
}

window.addEventListener("hashchange", () => {
  const id = parseDeepLink();
  if (id && id !== state.selectedId) {
    pendingDeepLink = id;
    applyPendingDeepLink();
  }
});

// ---- websocket ------------------------------------------------------------

const AUTO_NOTE_MS = 8000;

function applyAuto(msg: Extract<ServerPush, { type: "auto" }>) {
  const { [msg.sessionId]: _gone, ...rest } = state.autoPending;
  if (msg.state === "pending") {
    set({
      autoPending: { ...state.autoPending, [msg.sessionId]: { itemId: msg.itemId, deadline: msg.deadline ?? Date.now(), reason: msg.reason ?? null, quote: msg.quote ?? null } },
    });
    return;
  }
  set({ autoPending: rest });
  if (msg.state === "sent") {
    set({ autoNotes: { ...state.autoNotes, [msg.sessionId]: msg.quote ? `Auto-continued: "${msg.quote}"` : "Auto-continued" } });
    setTimeout(() => {
      const { [msg.sessionId]: _done, ...left } = state.autoNotes;
      set({ autoNotes: left });
    }, AUTO_NOTE_MS);
  }
}

function applyPush(msg: ServerPush) {
  switch (msg.type) {
    case "hello": {
      const sessions: Record<string, Session> = {};
      for (const s of msg.sessions) sessions[s.id] = s;
      set({ sessions, system: msg.system ?? state.system, lastSeen: baselineSeen(msg.sessions) });
      if (msg.attention) upsertAttention(msg.attention);
      refreshGovernor();
      void fetchCoordination().then((coordination) => set({ coordination })).catch(() => undefined);
      // A daemon from before D34 doesn't say: it always had the built-in coordinator.
      const coordinatorAgent = msg.coordinatorAgent ?? "builtin";
      set({ coordinatorAgent });
      if (coordinatorAgent === "none") set({ coordinator: null });
      else void fetchCoordinator().then((coordinator) => set({ coordinator, coordinatorAgent: coordinator.agent ?? coordinatorAgent })).catch(() => undefined);
      if (msg.groups) set({ groups: Object.fromEntries(msg.groups.map((g) => [g.id, g])) });
      applyPendingDeepLink();
      if (state.selectedId && state.selectedId !== COORDINATOR_ID) {
        void loadLatest(state.selectedId); // fill any gap from while we were away
        void loadOutbox(state.selectedId);
      }
      break;
    }
    case "attention": {
      const isNew = !state.attention[msg.item.id];
      upsertAttention([msg.item]);
      if (isNew && msg.item.status === "open" && !msg.item.historical) newAttentionListeners.forEach((cb) => cb(msg.item));
      break;
    }
    case "coordination":
      set({ coordination: { objectives: msg.objectives, tasks: msg.tasks, claims: msg.claims, conflicts: msg.conflicts } });
      break;
    case "coordinator": {
      const { type: _t, ...coordinator } = msg;
      set({ coordinator, coordinatorAgent: coordinator.agent ?? state.coordinatorAgent });
      break;
    }
    case "group":
      set({ groups: { ...state.groups, [msg.group.id]: msg.group } });
      break;
    case "auto":
      applyAuto(msg);
      break;
    case "outbox":
      upsertOutbox(msg.message);
      break;
    case "session":
      set({ sessions: { ...state.sessions, [msg.session.id]: msg.session } });
      if (state.selectedId === msg.session.id && !document.hidden) markSeen(msg.session.id);
      break;
    case "session_removed": {
      const { [msg.id]: _gone, ...rest } = state.sessions;
      set({ sessions: rest, selectedId: state.selectedId === msg.id ? null : state.selectedId });
      break;
    }
    case "system":
      set({ system: msg.system });
      break;
    case "event": {
      const e = msg.event;
      const t = state.transcripts[e.sessionId];
      if (t) set({ transcripts: { ...state.transcripts, [e.sessionId]: { ...t, events: mergeEvents(t.events, [e]) } } });
      if (state.selectedId === e.sessionId && !document.hidden) markSeen(e.sessionId);
      break;
    }
  }
}

let attempts = 0;
let everOpened = false;

function retry() {
  set({ conn: "closed" });
  const delay = Math.min(15000, 500 * 2 ** attempts++);
  setTimeout(connect, delay);
}

async function connect() {
  set({ conn: "connecting" });
  let url: string;
  try {
    url = await wsUrl();
  } catch (err) {
    if (/Not signed in/.test((err as Error).message)) set({ authError: (err as Error).message });
    return retry();
  }
  const ws = new WebSocket(url);
  ws.onopen = () => {
    attempts = 0;
    everOpened = true;
    set({ conn: "open", authError: null });
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data as string) as ServerPush | ({ type: "governor" } & GovernorSnapshot);
    // The governor push is not part of the shared ServerPush union yet.
    if (msg.type === "governor") set({ governor: { gameMode: msg.gameMode, gameManual: msg.gameManual, sessions: msg.sessions, log: msg.log } });
    else applyPush(msg);
  };
  ws.onclose = () => {
    if (!everOpened) void fetchSessions().catch((err: Error) => set({ authError: err.message }));
    retry();
  };
}

export function startStore() {
  void connect();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.selectedId) markSeen(state.selectedId);
  });
}
