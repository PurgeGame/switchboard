// The parts of "Needs you" that don't depend on a coordinator: permission prompts held for you and
// the link to waiting sessions. The coordinator's home and the no-coordinator home (D34) both use them.
import { useState } from "react";
import type { AttentionItem, Session } from "../../../shared/types.ts";
import { answerApproval } from "../api.ts";
import { clip } from "../format.ts";
import { sessionTitle } from "../status.ts";
import { openSession, setInboxOpen } from "../store.ts";

export const btn = "rounded-md border border-line-strong px-2.5 py-1 text-[12px] text-ink-2 hover:bg-hover disabled:opacity-40";
export const primary = "rounded-md bg-focus px-2.5 py-1 text-[12px] font-medium text-[#10141a] hover:opacity-90 disabled:opacity-40";

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function Card({ children }: { children: React.ReactNode }) {
  return <li className="space-y-2 rounded-lg border border-amber/40 bg-raised px-3.5 py-3">{children}</li>;
}

/**
 * A permission prompt held for you. recLabel: who the one-line note is from ("Coordinator" when the
 * built-in coordinator judged it; null when it's only Switchboard's always-ask reason).
 */
export function PermissionCard({ item, sessions, recLabel }: { item: AttentionItem; sessions: Record<string, Session>; recLabel: string | null }) {
  const a = useAction();
  const who = sessions[item.sessionId] ? sessionTitle(sessions[item.sessionId]) : (item.sessionName ?? "A session");
  const rec = typeof item.meta.recommendation === "string" ? item.meta.recommendation : null;
  return (
    <Card>
      <p className="text-[13px] font-medium text-ink">
        {who} <span className="font-normal text-ink-3">wants to:</span>
      </p>
      {item.text && <p className="whitespace-pre-wrap break-words rounded-md bg-panel px-2.5 py-2 font-mono text-[12px] text-ink-2">{clip(item.text, 600)}</p>}
      {rec && <p className="text-[12px] text-ink-3">{recLabel ? `${recLabel}: ${rec}` : rec}</p>}
      <div className="flex items-center gap-2">
        <button className={primary} disabled={a.busy} onClick={() => void a.run(() => answerApproval(item.id, "accept"))}>
          Allow
        </button>
        <button className={btn} disabled={a.busy} onClick={() => void a.run(() => answerApproval(item.id, "decline"))}>
          Deny
        </button>
        <button className="text-[12px] text-ink-3 underline-offset-2 hover:underline" onClick={() => openSession(item.sessionId)}>
          See the session
        </button>
        {a.error && <span className="text-[12px] text-red">{a.error}</span>}
      </div>
    </Card>
  );
}

/** Questions and other items waiting on you live in the inbox: one link there. */
export function WaitingLink({ count }: { count: number }) {
  if (!count) return null;
  return (
    <button onClick={() => setInboxOpen(true)} className="text-[12px] text-amber underline-offset-2 hover:underline">
      {count === 1 ? "A session is waiting for you" : `${count} sessions are waiting for you`} →
    </button>
  );
}
