import type { CoordinatorProposal, CoordinatorState, AttentionItem, Claim, Conflict, Objective, OutboxMessage, PerspectiveGroup, Task, TaskStatus, SbEvent, SendMethod, SendMode, Session, SystemStats } from "../../shared/types.ts";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (res.status === 401) throw new Error("Not signed in. Run `sb open` to log in.");
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchSessions = () => get<Session[]>("/api/sessions");
export const fetchSystem = () => get<SystemStats | null>("/api/system");

export function fetchEvents(sessionId: string, opts: { limit?: number; before?: number } = {}): Promise<SbEvent[]> {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 200) });
  if (opts.before !== undefined) q.set("before", String(opts.before));
  return get<SbEvent[]>(`/api/sessions/${encodeURIComponent(sessionId)}/events?${q}`);
}

/** WebSockets open with a single-use, 10-second ticket; the session cookie alone isn't enough. */
export async function wsUrl(): Promise<string> {
  const res = await fetch("/api/ws-ticket", { method: "POST", credentials: "same-origin" });
  if (res.status === 401) throw new Error("Not signed in. Run `sb open` to log in.");
  if (!res.ok) throw new Error(`/api/ws-ticket: ${res.status}`);
  const { ticket } = (await res.json()) as { ticket: string };
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`;
}

/** Ends this browser's session (other browsers stay signed in). */
export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
}

export const fetchAllAttention = () => get<AttentionItem[]>("/api/attention?all=1");

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function post<T>(path: string, init: { json?: unknown; raw?: Blob }): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: init.raw ? { "content-type": init.raw.type } : init.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.raw ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `${path}: ${res.status}`, res.status);
  return body as T;
}

/** Settle an uncertain delivery after checking the session's transcript. */
export const resolveDelivery = (id: number, as: "delivered" | "not_delivered") => post<OutboxMessage>(`/api/outbox/${id}/resolve`, { json: { as } });

export const ackAttention = (id: number) => post<unknown>(`/api/attention/${id}/ack`, {});

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export const answerApproval = (id: number, decision: ApprovalDecision) => post<unknown>(`/api/attention/${id}/answer`, { json: { decision } });

export interface Upload {
  path: string;
  sha256: string;
  bytes: number;
}
export const uploadImage = (file: Blob) => post<Upload>("/api/uploads", { raw: file });
export const uploadUrl = (path: string) => `/api/uploads/${encodeURIComponent(path.split("/").pop() ?? path)}`;

export interface SendBody {
  text: string;
  images?: string[];
  clientId: string;
  mode?: SendMode;
  method?: SendMethod;
  switchMethod?: boolean;
}
export const sendMessage = (sessionId: string, body: SendBody) =>
  post<OutboxMessage>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { json: body });

export interface InterruptResult {
  outcome: string;
  detail?: string;
  error?: string;
}
export const interruptSession = (sessionId: string) => post<InterruptResult>(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {});

export const fetchOutbox = (sessionId: string) => get<OutboxMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/outbox`);

const sessionPath = (id: string, tail: string) => `/api/sessions/${encodeURIComponent(id)}/${tail}`;

export const signalTyping = (sessionId: string) => post<unknown>(sessionPath(sessionId, "typing"), {});
export const cancelAuto = (sessionId: string) => post<unknown>(sessionPath(sessionId, "auto-cancel"), {});
export const setAutoContinue = (sessionId: string, autoContinue: boolean) => post<unknown>(sessionPath(sessionId, "prefs"), { json: { autoContinue } });

export async function showTerminal(sessionId: string): Promise<void> {
  const r = await post<{ ok: boolean; error?: string }>(sessionPath(sessionId, "show"), {});
  if (!r.ok) throw new Error(r.error ?? "Could not show the terminal");
}

export interface LaunchRequest {
  provider: "claude" | "codex";
  cwd: string;
  name?: string;
  model?: string;
}

export async function launchSession(req: LaunchRequest): Promise<void> {
  const r = await post<{ ok: boolean; error?: string }>("/api/launch", { json: req });
  if (!r.ok) throw new Error(r.error ?? "Could not start the session");
}

export type PerspectiveMemberRequest =
  | { kind: "new"; provider: "claude" | "codex"; model?: string }
  | { kind: "existing"; sessionId: string };

const perspective = (id: string, tail: string) => `/api/perspectives/${encodeURIComponent(id)}/${tail}`;

export const createPerspective = (body: { prompt: string; images: string[]; cwd: string; members: PerspectiveMemberRequest[] }) =>
  post<PerspectiveGroup>("/api/perspectives", { json: body });
export const synthesizePerspective = (id: string, model: string) => post<unknown>(perspective(id, "synthesize"), { json: { model } });
export const crossReviewPerspective = (id: string) => post<unknown>(perspective(id, "cross-review"), {});
export const followUpPerspective = (id: string, text: string, images: string[]) => post<unknown>(perspective(id, "follow-up"), { json: { text, images } });
export const confirmPerspective = (id: string) => post<unknown>(perspective(id, "confirm"), {});
export const dismissPerspective = (id: string) => post<unknown>(perspective(id, "dismiss"), {});

export interface Coordination {
  objectives: Objective[];
  tasks: Task[];
  claims: Claim[];
  conflicts: Conflict[];
}

export const fetchCoordination = () => get<Coordination>("/api/coordination");
export const createObjective = (body: { title: string; description?: string; priority?: Objective["priority"] }) => post<Objective>("/api/objectives", { json: body });

export interface NewTask {
  title: string;
  description?: string;
  objectiveId?: string;
  owner?: string;
  priority?: Task["priority"];
  tier?: Task["tier"];
  prerequisites?: string[];
  acceptance?: string[];
}
export const createTask = (body: NewTask) => post<Task>("/api/tasks", { json: body });

export type TaskPatch = Partial<{ status: TaskStatus; owner: string | null; tier: Task["tier"]; acceptance: string[] }>;
export const updateTask = (id: string, patch: TaskPatch) => post<Task>(`/api/tasks/${encodeURIComponent(id)}`, { json: patch });
export const addEvidence = (id: string, text: string) => post<unknown>(`/api/tasks/${encodeURIComponent(id)}/evidence`, { json: { text } });
export const releaseClaim = (id: number) => post<unknown>(`/api/claims/${id}/release`, {});
export const resolveConflict = (id: string) => post<unknown>(`/api/conflicts/${encodeURIComponent(id)}/resolve`, {});

export type GamePriority = "protected" | "high" | "normal" | "low";

export interface GovernorSession {
  priority: GamePriority;
  level: 0 | 1 | 2;
  reason: string | null;
  since: number | null;
  scope: string | null;
}

export interface GovernorSnapshot {
  gameMode: boolean;
  gameManual: boolean | null;
  sessions: Record<string, GovernorSession>;
  log: { at: number; text: string }[];
}

export const fetchGovernor = () => get<GovernorSnapshot>("/api/governor");
export const setGameMode = (on: boolean | null) => post<GovernorSnapshot>("/api/governor/game", { json: { on } });
export const setGamePriority = (sessionId: string, priority: GamePriority) => post<GovernorSnapshot>("/api/governor/priority", { json: { sessionId, priority } });
export const throttleSession = (sessionId: string, level: 1 | 2) => post<unknown>("/api/governor/throttle", { json: { sessionId, level } });
export const restoreSession = (sessionId: string) => post<GovernorSnapshot>("/api/governor/restore", { json: { sessionId } });

// ---- Coordinator (the home screen talks to it; it handles the details)
export const fetchCoordinator = () => get<CoordinatorState>("/api/coordinator");
export const tellCoordinator = (text: string, images: string[] = []) => post<{ ok: boolean }>("/api/coordinator/chat", { json: { text, images } });
export const setCoordinatorMode = (mode: CoordinatorState["mode"]) => post<CoordinatorState>("/api/coordinator/mode", { json: { mode } });
/** `digest`: for a plan, the digest of the exact payload the card showed (the daemon refuses a mismatch). */
export const approveProposal = (id: number, digest?: string) =>
  post<CoordinatorProposal>(`/api/coordinator/proposals/${id}/approve`, { json: digest ? { digest } : {} });
/** The user retries a plan task that couldn't start. */
export const retryPlanTask = (proposalId: number, key: string) =>
  post<{ ok: boolean }>(`/api/coordinator/plans/${proposalId}/tasks/${encodeURIComponent(key)}/retry`, {});
export const declineProposal = (id: number, note = "") => post<CoordinatorProposal>(`/api/coordinator/proposals/${id}/reject`, { json: { note } });
/** The human accepts finished work: one verification per acceptance criterion. */
export async function acceptTask(task: Task): Promise<void> {
  for (const criterion of task.acceptance) await post<unknown>(`/api/tasks/${encodeURIComponent(task.id)}/evidence`, { json: { criterion, text: "Accepted by you" } });
}
/** Stop a project: revokes its grant, so the coordinator can't start or message work for it. */
export const stopObjective = (id: string) => post<unknown>(`/api/objectives/${encodeURIComponent(id)}/revoke`, {});
/** End a session (its history stays). */
export const endSession = (sessionId: string) => post<{ ok: boolean; how: string; error?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/end`, {});
