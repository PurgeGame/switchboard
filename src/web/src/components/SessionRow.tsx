import { ProviderIcon } from "./ProviderIcon.tsx";
import { ResumeButton, SessionActionError } from "./SessionActions.tsx";
import { memo } from "react";
import type { AttentionItem, Session } from "../../../shared/types.ts";
import { baseName, duration, relative } from "../format.ts";
import { projectOf, STATUS, workerFolder } from "../status.ts";
import { AutoChip } from "./AutoBanner.tsx";
import { AttentionBadges, idleRunning, RunningChip, StatusPill } from "./Badges.tsx";
import { AgentsChip, runningAgents } from "./Subagents.tsx";
import { canPinSession, SessionPlacement } from "./SessionPlacement.tsx";

interface Props {
  session: Session;
  /** sessionTitle(session), passed in so the row redraws when a worker's task title arrives. */
  title: string;
  selected: boolean;
  unread: boolean;
  attention: AttentionItem[] | undefined;
  autoDeadline: number | undefined;
  now: number;
  onOpen: (id: string) => void;
  /** The heading of the group it's listed under: its folder isn't repeated when it's the same. */
  heading?: string;
}

function SessionRowBase({ session: s, title, selected, unread, attention, autoDeadline, now, onOpen, heading }: Props) {
  const tone = STATUS[s.execution].tone;
  const idleRun = idleRunning(s);
  const elapsed = s.execution === "working" && s.turnStartedAt ? duration(now - s.turnStartedAt) : idleRun ? duration(Math.max(0, now - idleRun.since)) : undefined;
  // While it's working the pill says Working, so the command gets its own chip; while idle the pill says it.
  const running = s.execution === "working" ? s.resources?.running : undefined;
  // A coordinator worker's folder is named after its task (already the title): show its project instead.
  const worker = workerFolder(s.cwd);
  const folder = worker ? worker.repo : s.cwd ? baseName(s.cwd) : projectOf(s);
  const agents = runningAgents(s.subagents);
  const chips = (attention && attention.length > 0) || autoDeadline !== undefined || !!running || agents > 0;
  return (
    <li className="relative">
      <button
        data-session-id={s.id}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(s.id)}
        className={`tone-${tone} group relative flex w-full flex-col gap-1 py-2 pl-4 ${canPinSession(s) ? "pr-11" : "pr-3"} text-left ${
          selected ? "bg-raised" : "hover:bg-hover"
        } ${s.execution === "ended" ? "opacity-60" : ""}`}
      >
        <span aria-hidden className={`rail absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r ${selected ? "" : "opacity-70"}`} />
        <span className="flex items-center gap-2">
          <ProviderIcon provider={s.provider} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</span>
          {!!s.meta.coordinatorClient && (
            <span title="Connected to Switchboard's coordinator tools (sb mcp)" className="shrink-0 rounded-full border border-line-strong px-1.5 text-[10px] text-ink-3">
              Your coordinator
            </span>
          )}
          {unread && <span role="img" aria-label="Unread activity" title="New activity since you last opened this" className="h-2 w-2 shrink-0 rounded-full bg-focus" />}
          <StatusPill session={s} elapsed={elapsed} />
        </span>
        {/* Always two lines: chips sit on the second line (clipped, never wrapping), and the folder
            shows only when it isn't the group heading above. */}
        <span className="flex h-[18px] items-center gap-2 pl-[22px] text-[11px] text-ink-3">
          <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {chips && (
              <>
                <AttentionBadges session={s} items={attention} />
                {autoDeadline !== undefined && <AutoChip deadline={autoDeadline} now={now} />}
                {running && <RunningChip running={running} now={now} />}
                {agents > 0 && <AgentsChip count={agents} />}
              </>
            )}
            {folder !== heading && (
              <span className="min-w-0 truncate" title={s.cwd ?? undefined}>
                {folder}
              </span>
            )}
          </span>
          <span className="shrink-0 tabular-nums">{relative(s.lastActivityAt, now)}</span>
        </span>
      </button>
      {s.execution === "ended" && (
        <div className="flex justify-end px-3 pb-2">
          <ResumeButton session={s} />
        </div>
      )}
      <SessionActionError sessionId={s.id} />
      <SessionPlacement session={s} menu />
    </li>
  );
}

export const SessionRow = memo(SessionRowBase);
