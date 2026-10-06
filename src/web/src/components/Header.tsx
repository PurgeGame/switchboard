import type { AttentionCounts } from "../attention.ts";
import { InboxIcon } from "./Icons.tsx";
import { GameModeBadge } from "./Governor.tsx";
import { SettingsPopover } from "./SettingsPopover.tsx";
import type { ConnState, View } from "../store.ts";


function Segment({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <>
      <span className="text-ink-3" aria-hidden>
        ·
      </span>
      <span className={color}>
        {n} {label}
      </span>
    </>
  );
}

function AttentionCounter({ counts }: { counts: AttentionCounts }) {
  const { needYou } = counts;
  return (
    <div className="flex min-w-0 items-center gap-2 whitespace-nowrap text-[12px] font-medium" role="status" aria-live="polite">
      <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${needYou > 0 ? "lamp-pulse bg-amber" : "bg-line-strong"}`} />
      <span className={`hidden sm:inline ${needYou > 0 ? "text-amber" : "text-ink-3"}`}>{needYou > 0 ? `${needYou} need${needYou === 1 ? "s" : ""} you` : "All clear"}</span>
    </div>
  );
}

const CONN_LABEL: Record<ConnState, string> = {
  open: "Live",
  connecting: "Connecting…",
  closed: "Reconnecting…",
};

function ConnDot({ conn, authError }: { conn: ConnState; authError: string | null }) {
  const color = conn === "open" ? "bg-[#4fc08d]" : conn === "connecting" ? "bg-amber" : "bg-red";
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-ink-3" title={authError ?? `Daemon connection: ${CONN_LABEL[conn]}`}>
      <span aria-hidden className={`h-2 w-2 rounded-full ${color}`} />
      <span className="hidden sm:inline">{authError ? "Not signed in" : CONN_LABEL[conn]}</span>
    </span>
  );
}


export function Header(props: {
  counts: AttentionCounts;
  conn: ConnState;
  authError: string | null;
  view: View;
  onView: (v: View) => void;
  inboxOpen: boolean;
  onInbox: () => void;
}) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 sm:gap-4 sm:px-4">
      <h1 className="sr-only text-[14px] font-semibold tracking-tight sm:not-sr-only">Switchboard</h1>
      <div className="ml-auto flex items-center gap-2 sm:gap-4">
        <GameModeBadge />
        <AttentionCounter counts={props.counts} />
        <button
          onClick={props.onInbox}
          aria-label={`Waiting on you, ${props.counts.open} open`}
          aria-expanded={props.inboxOpen}
          title="What sessions are waiting on (i)"
          className={`relative rounded-md p-1.5 hover:bg-hover ${props.inboxOpen ? "bg-raised text-ink" : "text-ink-2"}`}
        >
          <InboxIcon width={16} height={16} />
          {props.counts.open > 0 && (
            <span
              className={`absolute -right-1 -top-1 min-w-4 rounded-full px-1 text-center text-[10px] font-semibold leading-4 text-[#10141a] ${
                props.counts.needYou > 0 ? "bg-amber" : "bg-green"
              }`}
            >
              {props.counts.open}
            </span>
          )}
        </button>
        <SettingsPopover />
        <ConnDot conn={props.conn} authError={props.authError} />
      </div>
    </header>
  );
}
