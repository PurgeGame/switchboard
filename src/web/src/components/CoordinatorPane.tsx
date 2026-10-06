// Home: talk to the coordinator, decide what needs you, see what's happening. The coordinator
// handles the details (routing, tasks, grants, delivery); this screen only shows decisions and
// plain-language progress.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CoordinatorChatEntry, CoordinatorPlan, CoordinatorProposal, Session, Task } from "../../../shared/types.ts";
import { acceptTask, stopObjective, approveProposal, declineProposal, retryPlanTask, setCoordinatorMode, tellCoordinator } from "../api.ts";
import { clip, clock } from "../format.ts";
import { sessionTitle } from "../status.ts";
import { openSession, showList, useNow, useStore } from "../store.ts";
import { agentSeen, needsYou } from "../home.ts";
import { modelLabel } from "../../../shared/models.ts";
import { MessageBox } from "./MessageBox.tsx";
import { Thumbnails, useAttachments } from "./Attachments.tsx";
import { ArrowLeft } from "./Icons.tsx";
import { btn, Card, PermissionCard, primary, useAction, WaitingLink } from "./NeedsYouParts.tsx";

const nameOf = (sessions: Record<string, Session>, id: string | null) => (id && sessions[id] ? sessionTitle(sessions[id]) : "a session");
const unprefix = (t: string) => t.replace(/^\[coordinator\]\s*/, "");

interface PlanLine {
  key: string;
  title: string;
  brief: string;
  acceptance: string[];
  prerequisites: string[];
  paths: string[];
  provider: string;
  model: string;
  effort: string | null;
  tier: string;
  tierOverride?: string | null;
}
/** "opus" -> "Opus"; full Claude ids get their short label; other ids stay as they are. */
const planModel = (m: string) => (/^[a-z]+$/.test(m) ? m[0].toUpperCase() + m.slice(1) : (modelLabel(m) ?? m));
const inRoot = (root: string, p: string) => (p === root ? "the whole folder" : p.startsWith(root + "/") ? p.slice(root.length + 1) : p);

/**
 * A delegation plan: everything approving it authorizes, straight from the payload the daemon
 * validated (and whose digest the approval sends back): folder, resources, and for every task its
 * title, agent/model/effort, scope paths and prerequisites, with the brief and checks on expand.
 * Nothing is clipped.
 */
function PlanSummary({ p }: { p: CoordinatorProposal }) {
  const tasks = (Array.isArray(p.payload?.tasks) ? p.payload.tasks : []) as PlanLine[];
  const root = typeof p.payload?.root === "string" ? p.payload.root : "";
  const resources = Array.isArray(p.payload?.resources) ? (p.payload.resources as string[]) : [];
  const titleOf = new Map(tasks.map((t) => [t.key, t.title]));
  return (
    <>
      <p className="break-words text-[12px] text-ink-2">
        Works in <span className="font-mono">{root}</span>
        {resources.length > 0 && <> · also uses {resources.join(", ")}</>}
      </p>
      <p className="text-[12px] text-ink-3">
        {tasks.length} task{tasks.length === 1 ? "" : "s"}. Going ahead creates all of them and starts each one when it's ready; a task with prerequisites starts only after
        you've verified them.
      </p>
      <ol className="space-y-1.5 text-[12px] text-ink-2">
        {tasks.map((t, i) => (
          <li key={t.key} className="break-words">
            <span className="text-ink-3">{i + 1}. </span>
            {t.title} <span className="text-ink-3">· {t.provider === "codex" ? "Codex" : "Claude"} {planModel(t.model)}{t.effort ? ` · ${t.effort}` : ""}</span>
            {t.tierOverride && <span className="block text-ink-3">Settings rule: {t.tierOverride}</span>}
            <span className="block text-ink-3">
              Changes: <span className="font-mono">{(t.paths ?? []).map((x) => inRoot(root, x)).join(", ")}</span>
            </span>
            {t.prerequisites?.length > 0 && <span className="block text-ink-3">After: {t.prerequisites.map((k) => titleOf.get(k) ?? k).join(", ")}</span>}
            <details className="text-ink-3">
              <summary className="cursor-pointer">Brief and checks</summary>
              <p className="whitespace-pre-wrap rounded-md bg-panel px-2.5 py-2 text-ink-2">{t.brief}</p>
              <ul className="list-disc pl-5">
                {(t.acceptance ?? []).map((x, j) => (
                  <li key={j}>{x}</li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ol>
    </>
  );
}

function ProposalCard({ p, sessions }: { p: CoordinatorProposal; sessions: Record<string, Session> }) {
  const a = useAction();
  const plan = p.payload?.action === "plan";
  const heading =
    p.kind === "send_message" ? `Send this to ${nameOf(sessions, p.sessionId)}?` : p.kind === "launch_session" ? `Start a new session: ${p.title}?` : plan ? `Plan: ${p.title}` : `${p.title}?`;
  return (
    <Card>
      <p className="text-[13px] font-medium text-ink">{heading}</p>
      {(p.kind === "send_message" || p.payload?.action === "route") && p.text && <p className="whitespace-pre-wrap rounded-md bg-panel px-2.5 py-2 text-[12px] text-ink-2">{unprefix(p.text)}</p>}
      {p.payload?.action === "new_objective" && typeof p.payload.root === "string" && (
        // The folder comes from the request itself, not the coordinator's wording above.
        <p className="text-[12px] text-ink-2">
          Works in <span className="font-mono">{p.payload.root}</span>
          {Array.isArray(p.payload.resources) && p.payload.resources.length > 0 && <> · also uses {(p.payload.resources as string[]).join(", ")}</>}
        </p>
      )}
      {plan && <PlanSummary p={p} />}
      {p.reason && <p className="text-[12px] text-ink-3">{plan ? `Coordinator's note: ${p.reason}` : p.reason}</p>}
      <div className="flex items-center gap-2">
        <button className={primary} disabled={a.busy || (plan && !p.digest)} onClick={() => void a.run(() => approveProposal(p.id, p.digest))}>
          {p.kind === "send_message" || p.payload?.action === "route" ? "Send" : p.kind === "launch_session" ? "Start" : "Go ahead"}
        </button>
        <button className={btn} disabled={a.busy} onClick={() => void a.run(() => declineProposal(p.id))}>
          No thanks
        </button>
        {a.error && <span className="text-[12px] text-red">{a.error}</span>}
      </div>
    </Card>
  );
}

/** A plan task that couldn't start. Retry runs every launch check again. */
function FailedTaskCard({ plan, task }: { plan: CoordinatorPlan; task: CoordinatorPlan["tasks"][number] }) {
  const a = useAction();
  return (
    <Card>
      <p className="text-[13px] font-medium text-ink">
        {task.title} <span className="font-normal text-ink-3">couldn't start.</span>
      </p>
      {task.error && <p className="whitespace-pre-wrap break-words text-[12px] text-ink-2">{clip(task.error, 400)}</p>}
      <p className="text-[12px] text-ink-3">From the plan: {plan.title}</p>
      <div className="flex items-center gap-2">
        <button className={primary} disabled={a.busy} onClick={() => void a.run(() => retryPlanTask(plan.proposalId, task.key))}>
          Retry
        </button>
        {a.error && <span className="text-[12px] text-red">{a.error}</span>}
      </div>
    </Card>
  );
}

function DoneCard({ t, sessions }: { t: Task; sessions: Record<string, Session> }) {
  const a = useAction();
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState("");
  return (
    <Card>
      <p className="text-[13px] font-medium text-ink">
        <span>{t.title}</span> <span className="font-normal text-ink-3">is done. Look good?</span>
      </p>
      {t.result && <p className="whitespace-pre-wrap text-[12px] text-ink-2">{clip(t.result, 600)}</p>}
      {sending ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What's missing?"
            className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2.5 py-1 text-[12px]"
          />
          <button
            className={primary}
            disabled={a.busy || !note.trim()}
            onClick={() => void a.run(() => tellCoordinator(`"${t.title}" isn't done yet: ${note.trim()}`, [])).then(() => setSending(false))}
          >
            Send back
          </button>
          <button className={btn} onClick={() => setSending(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button className={primary} disabled={a.busy} onClick={() => void a.run(() => acceptTask(t))}>
            Looks good
          </button>
          <button className={btn} onClick={() => setSending(true)}>
            Not yet…
          </button>
          {t.owner && sessions[t.owner] && (
            <button className="text-[12px] text-ink-3 underline-offset-2 hover:underline" onClick={() => openSession(t.owner!)}>
              See the session
            </button>
          )}
          {a.error && <span className="text-[12px] text-red">{a.error}</span>}
        </div>
      )}
    </Card>
  );
}

function NeedsYou() {
  const coordinator = useStore((s) => s.coordinator);
  const tasks = useStore((s) => s.coordination.tasks);
  const sessions = useStore((s) => s.sessions);
  const attention = useStore((s) => s.attention);
  const proposals = (coordinator?.proposals ?? []).filter((p) => p.state === "pending");
  const done = tasks.filter((t) => t.status === "finished_unverified");
  const failed = (coordinator?.plans ?? []).flatMap((plan) => plan.tasks.filter((t) => t.state === "failed").map((task) => ({ plan, task })));
  const { prompts, waiting } = needsYou(attention);
  if (!proposals.length && !done.length && !failed.length && !prompts.length && !waiting) return null;
  // Only the built-in coordinator judges prompts (D29, D34); otherwise the note is Switchboard's always-ask reason.
  const recLabel = coordinator?.agent === "external" ? null : "Coordinator";
  return (
    <section aria-label="Needs you" className="space-y-2">
      <h2 className="text-[12px] font-semibold uppercase tracking-wide text-amber">Needs you</h2>
      <ul className="space-y-2">
        {prompts.map((i) => (
          <PermissionCard key={i.id} item={i} sessions={sessions} recLabel={recLabel} />
        ))}
        {proposals.map((p) => (
          <ProposalCard key={p.id} p={p} sessions={sessions} />
        ))}
        {failed.map(({ plan, task }) => (
          <FailedTaskCard key={`${plan.proposalId}:${task.key}`} plan={plan} task={task} />
        ))}
        {done.map((t) => (
          <DoneCard key={t.id} t={t} sessions={sessions} />
        ))}
      </ul>
      <WaitingLink count={waiting} />
    </section>
  );
}

function ChatLine({ e, sessions }: { e: CoordinatorChatEntry; sessions: Record<string, Session> }) {
  if (e.role === "system") return null; // event digests are for the coordinator, not you
  const mine = e.role === "user";
  return (
    <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
      <div className={`max-w-[85%] space-y-1.5 rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed ${mine ? "bg-focus/15 text-ink" : "bg-raised text-ink"}`}>
        {e.text && <p className="whitespace-pre-wrap break-words">{e.text}</p>}
        {e.images && e.images.length > 0 && <Thumbnails paths={e.images} size={72} />}
      </div>
      <span className="mt-0.5 px-1 text-[10px] text-ink-3">
        {clock(e.at)}
        {mine && e.routedTo && (
          <>
            {" · sent to "}
            <button className="underline-offset-2 hover:underline" onClick={() => openSession(e.routedTo!)}>
              {nameOf(sessions, e.routedTo)}
            </button>
          </>
        )}
      </span>
    </div>
  );
}

function ChatBox({ off }: { off: boolean }) {
  const [text, setText] = useState("");
  const files = useAttachments();
  const a = useAction();
  const ready = !a.busy && !files.uploading && (text.trim() !== "" || files.paths.length > 0);
  const send = () =>
    void a.run(async () => {
      await tellCoordinator(text.trim(), files.paths);
      setText("");
      files.clear();
    });
  if (off)
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-line-strong bg-raised px-3.5 py-3 text-[13px]">
        <span className="text-ink-2">The coordinator is off.</span>
        <button className={primary} onClick={() => void a.run(() => setCoordinatorMode("active"))}>
          Turn it on
        </button>
      </div>
    );
  return (
    <div className="space-y-1.5">
      <MessageBox
        value={text}
        onChange={setText}
        onSend={send}
        canSend={ready}
        busy={a.busy}
        label="Message the coordinator"
        placeholder="Tell the coordinator what you need, or paste a screenshot. It'll pass it to the right session."
        attachments={files}
      />
      {a.error && <p className="px-1 text-[12px] text-red">{a.error}</p>}
    </div>
  );
}

/**
 * External coordinator (D34): your own agent drives it through `sb mcp`, so there's no chat box
 * here. Talk to that agent in its own window; this says whether it's connected.
 */
function ExternalNote() {
  const c = useStore((s) => s.coordinator);
  const now = useNow();
  const seen = agentSeen(c?.lastToolCallAt ?? null, now);
  // Its own session, recognized by the daemon from the `sb mcp` process it runs.
  const own = useStore((s) => Object.values(s.sessions).find((x) => x.meta.coordinatorClient && !x.meta.coordinatorAgent && x.execution !== "ended"));
  return (
    <section aria-label="External coordinator" className="space-y-1 rounded-xl border border-line-strong bg-raised px-3.5 py-3 text-[13px]">
      <p className="text-ink-2">
        The coordinator is your own agent, connected with <code className="font-mono text-[12px]">sb mcp</code>. Talk to it in its own window
        {own ? (
          <>
            {": "}
            <button className="text-focus underline-offset-2 hover:underline" onClick={() => openSession(own.id)}>
              {sessionTitle(own)}
            </button>
          </>
        ) : null}
        .
      </p>
      <p className={`text-[12px] ${seen.connected ? "text-green" : "text-ink-3"}`}>{seen.text}</p>
    </section>
  );
}

const MODE_WORD = { active: "On", paused: "Paused", manual: "Off" } as const;

/** Header of the coordinator's chat: who it is, whether it's on, and a quick on/pause switch. */
function CoordinatorHeader() {
  const c = useStore((s) => s.coordinator);
  const a = useAction();
  const mode = c?.mode ?? "manual";
  const external = c?.agent === "external";
  const busy = !external && !!c?.busy;
  return (
    <div className="flex items-center gap-2.5 border-b border-line px-3 py-2 sm:px-4">
      <button onClick={showList} aria-label="Back to session list" className="rounded p-1 text-ink-2 hover:bg-hover lg:hidden">
        <ArrowLeft width={16} height={16} />
      </button>
      <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${mode === "active" ? (busy ? "lamp-pulse bg-blue" : "bg-green") : "bg-line-strong"}`} />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[14px] font-semibold">Coordinator</h2>
        <p className="truncate text-[11px] text-ink-3">
          {MODE_WORD[mode]}
          {mode === "active" && busy ? " · thinking…" : ""}
          {external ? " · your agent" : c?.model ? ` · ${modelLabel(c.model) ?? c.model}` : ""}
        </p>
      </div>
      {mode === "active" ? (
        <button className={btn} disabled={a.busy} onClick={() => void a.run(() => setCoordinatorMode("paused"))}>
          Pause
        </button>
      ) : (
        <button className={primary} disabled={a.busy} onClick={() => void a.run(() => setCoordinatorMode("active"))}>
          {mode === "paused" ? "Resume" : "Turn on"}
        </button>
      )}
    </div>
  );
}

const TASK_WORD: Record<Task["status"], string> = {
  unassigned: "Not started",
  assigned: "Starting",
  in_progress: "In progress",
  blocked: "Waiting on other work",
  finished_unverified: "Done, needs your OK",
  verified: "Done",
  rejected: "Sent back",
};

function Happening() {
  const external = useStore((s) => s.coordinator?.agent === "external");
  const { objectives, tasks } = useStore((s) => s.coordination);
  const sessions = useStore((s) => s.sessions);
  const working = Object.values(sessions).filter((s) => s.execution === "working").length;
  // A plan whose every task was rejected is abandoned: it drops off instead of lingering with a Stop button.
  const active = objectives.filter((o) => {
    const mine = tasks.filter((t) => t.objectiveId === o.id);
    return o.status === "active" && !(mine.length > 0 && mine.every((t) => t.status === "rejected"));
  });
  return (
    <section aria-label="What's happening" className="space-y-3">
      <h2 className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">What's happening</h2>
      <p className="text-[12px] text-ink-2">{working === 0 ? "No sessions are working right now." : working === 1 ? "1 session is working." : `${working} sessions are working.`}</p>
      {active.length === 0 ? (
        <p className="text-[12px] text-ink-3">{external ? "No projects yet." : "No projects yet. Tell the coordinator what you want done."}</p>
      ) : (
        <ul className="space-y-3">
          {active.map((o) => {
            const mine = tasks.filter((t) => t.objectiveId === o.id && t.status !== "rejected");
            const finished = mine.filter((t) => t.status === "verified").length;
            return (
              <li key={o.id} className="space-y-1.5">
                <p className="flex items-baseline gap-2 text-[13px] font-medium text-ink">
                  <span className="min-w-0 flex-1">
                    {o.title}
                    {mine.length > 0 && <span className="ml-2 text-[11px] font-normal text-ink-3">{finished}/{mine.length} done</span>}
                  </span>
                  {o.grant && !o.grant.revokedAt ? (
                    <button className="shrink-0 text-[11px] font-normal text-ink-3 hover:text-red" title="The coordinator stops starting or messaging work for this" onClick={() => void stopObjective(o.id)}>
                      Stop
                    </button>
                  ) : (
                    o.grant?.revokedAt && <span className="shrink-0 text-[11px] font-normal text-ink-3">Stopped</span>
                  )}
                </p>
                <ul className="space-y-1">
                  {mine.map((t) => (
                    <li key={t.id} className="flex items-baseline gap-2 text-[12px]">
                      <span className={t.status === "verified" ? "text-green" : t.status === "finished_unverified" ? "text-amber" : "text-ink-3"}>●</span>
                      <span className="min-w-0 flex-1 truncate text-ink-2">{t.title}</span>
                      {t.owner && sessions[t.owner] ? (
                        <button className="shrink-0 text-ink-3 underline-offset-2 hover:underline" onClick={() => openSession(t.owner!)}>
                          {TASK_WORD[t.status]}
                        </button>
                      ) : (
                        <span className="shrink-0 text-ink-3">{TASK_WORD[t.status]}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function CoordinatorPane() {
  const coordinator = useStore((s) => s.coordinator);
  const sessions = useStore((s) => s.sessions);
  const chat = coordinator?.chat ?? [];
  const end = useRef<HTMLDivElement>(null);
  const last = chat.at(-1)?.id;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [last]);
  const off = !coordinator || coordinator.mode === "manual";
  const external = coordinator?.agent === "external";
  const visible = useMemo(() => chat.slice(-100), [chat]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CoordinatorHeader />
      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-h-0 flex-col">
          {/* Pinned above the chat: the chat scrolls to its newest line, which used to push these cards out of sight. */}
          <div className="max-h-[60vh] shrink-0 overflow-y-auto empty:hidden [&:has(section)]:border-b [&:has(section)]:border-line">
            <div className="mx-auto max-w-3xl px-4 py-3 empty:hidden sm:px-6">
              <NeedsYou />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-5 px-4 py-4 sm:px-6">
              {external ? (
                // No chat with an external agent here; what it tells you (tell_user) still shows.
                visible.length > 0 && (
                  <section aria-label="Messages from the coordinator" className="space-y-3">
                    {visible.map((e) => (
                      <ChatLine key={e.id} e={e} sessions={sessions} />
                    ))}
                    <div ref={end} />
                  </section>
                )
              ) : (
                <section aria-label="Coordinator chat" className="space-y-3">
                  {visible.length === 0 && (
                    <p className="py-6 text-center text-[13px] text-ink-3">
                      Tell the coordinator what you want done, or paste something for one of your sessions. It works out where it goes.
                    </p>
                  )}
                  {visible.map((e) => (
                    <ChatLine key={e.id} e={e} sessions={sessions} />
                  ))}
                  <div ref={end} />
                </section>
              )}
            </div>
          </div>
          <div className="shrink-0 border-t border-line bg-panel px-3 py-3 sm:px-6">
            <div className="mx-auto max-w-3xl">{external ? <ExternalNote /> : <ChatBox off={off} />}</div>
          </div>
        </div>
        <aside className="hidden min-h-0 overflow-y-auto border-l border-line px-4 py-4 xl:block">
          <Happening />
        </aside>
      </div>
    </div>
  );
}
