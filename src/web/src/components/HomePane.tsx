// Home with no coordinator (coordinator.agent "none", D34): permission prompts held for you and
// the sessions waiting on you. Nothing coordinator-specific.
import type { Session } from "../../../shared/types.ts";
import { showList, useStore } from "../store.ts";
import { ArrowLeft } from "./Icons.tsx";

export function HomePane() {
  const sessions = useStore((s) => s.sessions);
  const working = Object.values(sessions).filter((s: Session) => s.execution === "working").length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2.5 border-b border-line px-3 py-2 sm:px-4">
        <button onClick={showList} aria-label="Back to session list" className="rounded p-1 text-ink-2 hover:bg-hover lg:hidden">
          <ArrowLeft width={16} height={16} />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold">Needs you</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section aria-label="Sessions summary" className="px-4 py-4">
          <p className="text-[12px] text-ink-3">{working === 0 ? "No sessions are working right now." : working === 1 ? "1 session is working." : `${working} sessions are working.`}</p>
        </section>
      </div>
    </div>
  );
}
