import type { AttentionItem, RunningCommand, Session } from "../../../shared/types.ts";
import { duration } from "../format.ts";
import { KIND } from "../attention.ts";
import { STATUS, statusLabel } from "../status.ts";
import { StatusIcon } from "./Icons.tsx";

/** Idle only because a command it started is still going: say what's running instead of "Idle". */
export const idleRunning = (s: Session) => (s.execution === "idle" ? s.resources?.running : undefined);

export function StatusPill({ session, elapsed, large }: { session: Session; elapsed?: string; large?: boolean }) {
  const running = idleRunning(session);
  const meta = running ? { label: RUNNING_LABEL[running.kind], tone: "blue" as const, icon: "active" as const } : STATUS[session.execution];
  return (
    <span
      className={`pill tone-${meta.tone} inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium ${
        large ? "px-3.5 py-1.5 text-2xl" : "px-2 py-0.5 text-[11px]"
      }`}
    >
      <StatusIcon name={meta.icon} width={large ? 24 : 12} height={large ? 24 : 12} />
      {running ? meta.label : statusLabel(session)}
      {elapsed && <span className="font-mono tabular-nums opacity-80">{elapsed}</span>}
    </span>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: "confirmed" | "inferred" }) {
  return (
    <span
      className={`rounded border px-1.5 py-px text-[10px] ${
        confidence === "inferred" ? "border-line-strong text-ink-2" : "border-line text-ink-3"
      }`}
    >
      {confidence === "inferred" ? "~ inferred" : "confirmed"}
    </span>
  );
}

/** Open attention items for a session, shown beside (never instead of) the execution pill. */
export function AttentionBadges({ session, items, large }: { session: Session; items: AttentionItem[] | undefined; large?: boolean }) {
  const waiting = session.execution === "waiting_answer" || session.execution === "waiting_approval";
  const kinds = [...new Set((items ?? []).map((i) => i.kind))].filter((k) => !(waiting && (k === "question" || k === "approval")));
  if (kinds.length === 0) return null;
  return (
    <>
      {kinds.map((k) => {
        const meta = KIND[k];
        const count = items!.filter((i) => i.kind === k).length;
        return (
          <span
            key={k}
            title={`${count} unresolved ${meta.label.toLowerCase()} item${count > 1 ? "s" : ""}`}
            className={`pill tone-${meta.tone} inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full font-medium ${
              large ? "px-2.5 py-1 text-base" : "px-1.5 py-0.5 text-[10.5px]"
            }`}
          >
            <StatusIcon name={meta.icon} width={large ? 18 : 11} height={large ? 18 : 11} />
            {meta.label}
            {count > 1 && <span className="tabular-nums">{count}</span>}
          </span>
        );
      })}
    </>
  );
}

const RUNNING_LABEL: Record<RunningCommand["kind"], string> = { tests: "Tests running", build: "Building", command: "Command running" };

/** A command the agent left running (e.g. tests after its turn ended), so "Idle" doesn't read as done. */
export function RunningChip({ running, now }: { running: RunningCommand; now: number }) {
  return (
    <span title={running.cmd} className="pill tone-blue inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium">
      <StatusIcon name="active" width={11} height={11} />
      {RUNNING_LABEL[running.kind]}
      <span className="font-mono tabular-nums opacity-80">{duration(Math.max(0, now - running.since))}</span>
    </span>
  );
}
