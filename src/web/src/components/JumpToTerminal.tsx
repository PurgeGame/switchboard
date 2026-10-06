import { useState } from "react";
import type { Session } from "../../../shared/types.ts";
import { showTerminal } from "../api.ts";

export const hasTerminal = (s: Session) => !!s.meta.terminal;

export function JumpToTerminal({ session }: { session: Session }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!hasTerminal(session)) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={() => {
          setError(null);
          showTerminal(session.id)
            .then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 4000);
            })
            .catch((err: Error) => setError(err.message));
        }}
        className="rounded border border-line-strong px-2 py-1 text-[11px] text-ink-2 hover:bg-hover"
      >
        Jump to terminal
      </button>
      {done && <span className="text-[11px] text-ink-3">Opened in VS Code on the PC</span>}
      {error && (
        <span role="alert" className="text-[11px] text-red">
          {error}
        </span>
      )}
    </span>
  );
}
