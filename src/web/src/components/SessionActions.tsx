import { useSyncExternalStore } from "react";
import type { Session } from "../../../shared/types.ts";
import { endSession, resumeSession } from "../api.ts";
import { openSession } from "../store.ts";

type Action = { pending?: "ending" | "resuming"; error?: string };
let actions: Record<string, Action> = {};
let toasts: string[] = [];
const listeners = new Set<() => void>();
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const emit = () => listeners.forEach((fn) => fn());
const setAction = (id: string, value: Action) => { actions = { ...actions, [id]: value }; emit(); };
const dismissToast = (id: string) => {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  toasts = toasts.filter((x) => x !== id);
  emit();
};
export const useSessionAction = (id: string) => useSyncExternalStore(subscribe, () => actions[id]);

export async function endSessionNow(id: string) {
  if (actions[id]?.pending) return;
  setAction(id, { pending: "ending" });
  try {
    const r = await endSession(id);
    if (!r.ok) throw new Error(r.error ?? "Could not end this session");
    toasts = [...toasts.filter((x) => x !== id), id];
    clearTimeout(toastTimers.get(id));
    toastTimers.set(id, setTimeout(() => dismissToast(id), 30_000));
    setAction(id, {});
  } catch (e) { setAction(id, { error: (e as Error).message }); }
}

async function resume(id: string) {
  if (actions[id]?.pending) return;
  setAction(id, { pending: "resuming" });
  try {
    const r = await resumeSession(id);
    if (!r.ok) throw new Error(r.error ?? "Could not resume this session");
    dismissToast(id);
    setAction(id, {});
    openSession(id);
  } catch (e) { setAction(id, { error: (e as Error).message }); }
}

export function ResumeButton({ session: s }: { session: Session }) {
  const action = useSessionAction(s.id);
  if (s.execution !== "ended" || !s.cwd || !s.nativeId || (s.provider !== "claude" && s.provider !== "codex")) return null;
  return <button disabled={!!action?.pending} onClick={() => void resume(s.id)} title="Resume this conversation in the same folder"
    className="shrink-0 rounded-md border border-line px-2 py-1 text-[12px] text-ink-2 hover:bg-hover disabled:opacity-60">
    {action?.pending === "resuming" ? "Resuming…" : "Resume"}
  </button>;
}

export function SessionActionError({ sessionId }: { sessionId: string }) {
  const action = useSessionAction(sessionId);
  if (!action?.error) return null;
  return <div role="group" aria-label="Session action" className="flex items-start gap-2 border-t border-line/60 px-3 py-2 text-[12px]">
    <span role="alert" className="min-w-0 flex-1 break-words text-ink-2">{action.error}</span>
    <button className="shrink-0 rounded px-2 text-ink-3 hover:bg-hover" onClick={() => setAction(sessionId, {})}>OK</button>
  </div>;
}

export function EndedToasts() {
  const ids = useSyncExternalStore(subscribe, () => toasts);
  return <div className="fixed bottom-5 left-1/2 z-50 flex max-w-[calc(100%-2rem)] -translate-x-1/2 flex-col gap-2">
    {ids.map((id) => <EndedToast key={id} id={id} />)}
  </div>;
}

function EndedToast({ id }: { id: string }) {
  const action = useSessionAction(id);
  return <div role="status" className="rounded-md bg-raised px-3 py-2 text-[12px] text-ink-2 shadow-lg ring-1 ring-line-strong">
    Ended · <button disabled={!!action?.pending} onClick={() => void resume(id)} className="rounded px-1 text-focus hover:underline disabled:opacity-60">
      {action?.pending === "resuming" ? "Resuming…" : "Undo"}
    </button>
    {action?.error && <span role="alert" className="mt-1 block">{action.error}</span>}
  </div>;
}
