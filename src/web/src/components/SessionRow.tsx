import { memo } from "react";
import type { AttentionItem, Session } from "../../../shared/types.ts";
import { baseName, duration, relative } from "../format.ts";
import { projectOf, sessionTitle, STATUS } from "../status.ts";
import { AutoChip } from "./AutoBanner.tsx";
import { AttentionBadges, idleRunning, ProviderGlyph, RunningChip, StatusPill } from "./Badges.tsx";

interface Props {
  session: Session;
  selected: boolean;
  unread: boolean;
  attention: AttentionItem[] | undefined;
  autoDeadline: number | undefined;
  now: number;
  onOpen: (id: string) => void;
}

function SessionRowBase({ session: s, selected, unread, attention, autoDeadline, now, onOpen }: Props) {
  const tone = STATUS[s.execution].tone;
  const idleRun = idleRunning(s);
  const elapsed = s.execution === "working" && s.turnStartedAt ? duration(now - s.turnStartedAt) : idleRun ? duration(Math.max(0, now - idleRun.since)) : undefined;
  // While it's working the pill says Working, so the command gets its own chip; while idle the pill says it.
  const running = s.execution === "working" ? s.resources?.running : undefined;
  return (
    <li className="relative">
      <button
        data-session-id={s.id}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(s.id)}
        className={`tone-${tone} group relative flex w-full flex-col gap-1 py-2 pl-4 pr-3 text-left ${
          selected ? "bg-raised" : "hover:bg-hover"
        } ${s.execution === "ended" ? "opacity-60" : ""}`}
      >
        <span aria-hidden className={`rail absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r ${selected ? "" : "opacity-70"}`} />
        <span className="flex items-center gap-2">
          <ProviderGlyph provider={s.provider} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{sessionTitle(s)}</span>
          {!!s.meta.coordinatorClient && (
            <span title="Connected to Switchboard's coordinator tools (sb mcp)" className="shrink-0 rounded-full border border-line-strong px-1.5 text-[10px] text-ink-3">
              Your coordinator
            </span>
          )}
          {unread && <span role="img" aria-label="Unread activity" title="New activity since you last opened this" className="h-2 w-2 shrink-0 rounded-full bg-focus" />}
          <StatusPill session={s} elapsed={elapsed} />
        </span>
        {((attention && attention.length > 0) || autoDeadline !== undefined || running) && (
          <span className="flex flex-wrap gap-1 pl-[22px]">
            <AttentionBadges session={s} items={attention} />
            {autoDeadline !== undefined && <AutoChip deadline={autoDeadline} now={now} />}
            {running && <RunningChip running={running} now={now} />}
          </span>
        )}
        <span className="flex items-center gap-2 pl-[22px] text-[11px] text-ink-3">
          <span className="min-w-0 flex-1 truncate" title={s.cwd ?? undefined}>
            {s.cwd ? baseName(s.cwd) : projectOf(s)}
          </span>
          <span className="shrink-0 tabular-nums">{relative(s.lastActivityAt, now)}</span>
        </span>
      </button>
    </li>
  );
}

export const SessionRow = memo(SessionRowBase);
