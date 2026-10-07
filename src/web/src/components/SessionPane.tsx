import { ProviderIcon } from "./ProviderIcon.tsx";
import type { Session } from "../../../shared/types.ts";
import { endSessionNow, ResumeButton, SessionActionError, useSessionAction } from "./SessionActions.tsx";
import { baseName, duration } from "../format.ts";
import { contextPct, modelLabel } from "../../../shared/models.ts";
import { sessionTitle } from "../status.ts";
import { showList, useNow, useStore } from "../store.ts";
import { idleRunning, RunningChip, StatusPill } from "./Badges.tsx";
import { ArrowLeft } from "./Icons.tsx";
import { AutoBanner } from "./AutoBanner.tsx";
import { JumpToTerminal } from "./JumpToTerminal.tsx";
import { Composer } from "./Composer.tsx";
import { Transcript } from "./Transcript.tsx";
import { SubagentsPanel } from "./Subagents.tsx";
import { canPinSession, SessionPlacement } from "./SessionPlacement.tsx";

/** "Opus 5.5 · medium · 54% context": what's driving this session and how full its context is. */
function ModelLine({ session: s }: { session: Session }) {
  const pct = contextPct(s.contextTokens, s.contextWindow);
  const parts = [modelLabel(s.model), s.effort].filter(Boolean);
  if (!parts.length && pct === null) return null;
  return (
    <>
      <span aria-hidden>·</span>
      <span className="truncate">{parts.join(" · ")}</span>
      {pct !== null && (
        <span
          title={`${Math.round((s.contextTokens ?? 0) / 1000)}k of ${Math.round((s.contextWindow ?? 0) / 1000)}k tokens in context`}
          className={pct >= 85 ? "text-red" : pct >= 70 ? "text-amber" : ""}
        >
          {parts.length ? "· " : ""}
          {pct}% context
        </span>
      )}
    </>
  );
}

/** The server resolves inferred mappings from the transcript and reports ambiguity inline. */
const canEnd = (s: Session) => s.execution !== "ended" && (s.provider === "claude" || s.provider === "codex");

function PaneHeader({ session: s }: { session: Session }) {
  const now = useNow();
  const action = useSessionAction(s.id);
  const idleRun = idleRunning(s);
  const elapsed = s.execution === "working" && s.turnStartedAt ? duration(now - s.turnStartedAt) : idleRun ? duration(Math.max(0, now - idleRun.since)) : undefined;
  return (
    <div className="border-b border-line">
      <div className="flex items-center gap-2.5 px-3 py-2 sm:px-4">
        <button onClick={showList} aria-label="Back to session list" className="rounded p-1 text-ink-2 hover:bg-hover lg:hidden">
          <ArrowLeft width={16} height={16} />
        </button>
        <ProviderIcon provider={s.provider} size={16} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold">{sessionTitle(s)}</h2>
          <p className="flex min-w-0 items-baseline gap-1.5 truncate text-[11px] text-ink-3">
            <span className="truncate">{s.cwd ? baseName(s.cwd) : ""}</span>
            <ModelLine session={s} />
          </p>
        </div>
        <JumpToTerminal session={s} />
        <StatusPill session={s} elapsed={elapsed} />
        {/* Phones: no room beside the title and End (the row shows it). */}
        {s.execution === "working" && s.resources?.running && (
          <span className="hidden sm:contents">
            <RunningChip running={s.resources.running} now={now} />
          </span>
        )}
        <ResumeButton session={s} />
        {canEnd(s) && (
          <button disabled={!!action?.pending} onClick={() => void endSessionNow(s.id)} title="End this session" className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[12px] text-ink-3 hover:bg-hover hover:text-ink">
            {action?.pending === "ending" ? "Ending…" : "End"}
          </button>
        )}
      </div>
      <SessionActionError sessionId={s.id} />
      {canPinSession(s) && <div className="px-3 pb-2 sm:px-4"><SessionPlacement session={s} /></div>}
    </div>
  );
}

function ComposerArea({ session: s }: { session: Session }) {
  return (
    <div className="border-t border-line bg-panel px-3 py-3 sm:px-6">
      <AutoBanner sessionId={s.id} />
      <div className="mx-auto max-w-3xl">
        {s.sendMethods.length > 0 ? (
          <Composer key={s.id} session={s} draftKey={`sess:${s.id}`} />
        ) : (
          <p className="text-[12px] text-ink-3">{s.execution === "ended" ? "This session has ended." : "You can watch this session here, but reply to it in its own window."}</p>
        )}
      </div>
    </div>
  );
}

export function SessionPane({ session }: { session: Session | undefined }) {
  const transcript = useStore((s) => (session ? s.transcripts[session.id] : undefined));
  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-ink-3">
        <p className="text-[14px] text-ink-2">Pick a session on the left</p>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader key={`head:${session.id}`} session={session} />
      <SubagentsPanel agents={session.subagents} />
      <Transcript key={session.id} sessionId={session.id} transcript={transcript} />
      <ComposerArea session={session} />
    </div>
  );
}
