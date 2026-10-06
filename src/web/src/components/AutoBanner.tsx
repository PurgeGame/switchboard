import { useState } from "react";
import { cancelAuto } from "../api.ts";
import { useNow, useStore } from "../store.ts";
import { StatusIcon } from "./Icons.tsx";

export function countdown(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** Countdown for a pending auto-continue, plus the brief note after one was sent. */
export function AutoBanner({ sessionId }: { sessionId: string }) {
  const pending = useStore((s) => s.autoPending[sessionId]);
  const note = useStore((s) => s.autoNotes[sessionId]);
  const now = useNow();
  const [error, setError] = useState<string | null>(null);

  const cancel = () => {
    setError(null);
    cancelAuto(sessionId).catch((err: Error) => setError(err.message));
  };

  if (!pending && !note) return null;
  return (
    <div className="mx-auto mb-2 max-w-3xl space-y-0.5 rounded-md border border-line-strong bg-raised px-3 py-2 text-[12px]" role="status">
      {pending ? (
        <>
          <div className="flex items-center gap-2 text-amber">
            <StatusIcon name="spinner" spin width={13} height={13} />
            <span className="font-medium tabular-nums">Auto-continuing in {countdown(pending.deadline, now)}s</span>
            <button onClick={cancel} className="ml-auto rounded border border-amber/60 px-2 py-0.5 hover:bg-amber/10">
              Cancel
            </button>
          </div>
          {(pending.reason || pending.quote) && (
            <p className="text-[11px] text-ink-3">
              {pending.reason}
              {pending.quote && <> {pending.reason ? "· " : ""}"{pending.quote}"</>}
            </p>
          )}
        </>
      ) : (
        <p className="flex items-center gap-2 text-green">
          <StatusIcon name="check" width={13} height={13} />
          {note}
        </p>
      )}
      {error && <p className="text-red">{error}</p>}
    </div>
  );
}

export function AutoChip({ deadline, now }: { deadline: number; now: number }) {
  return (
    <span className="pill tone-amber inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums">
      <StatusIcon name="spinner" spin width={11} height={11} />
      Auto-continuing in {countdown(deadline, now)}s
    </span>
  );
}
