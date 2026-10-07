// The parts of "Needs you" that don't depend on a coordinator: permission prompts held for you and
// the link to waiting sessions. The coordinator's home and the no-coordinator home (D34) both use them.
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AttentionItem, Session } from "../../../shared/types.ts";
import { answerApproval, answerQuestion } from "../api.ts";
import { renderMarkdown } from "../markdown.ts";
import { answersFrom, answersOnTap, pick, questionsOf, type Question } from "../questions.ts";
import { sessionTitle } from "../status.ts";
import { acknowledge, openSession, setInboxOpen } from "../store.ts";
import { Composer } from "./Composer.tsx";

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
  const card = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    // Expanded details can start below the inbox's visible area. Bring the whole card
    // into that area, so its text and actions are visible as soon as it opens.
    if (card.current?.closest("[data-needs-you-id]")) card.current.scrollIntoView({ block: "nearest" });
  }, []);
  return <li ref={card} className="needs-you-card flex min-w-0 flex-col gap-2 rounded-lg border border-amber/40 bg-raised px-3.5 py-3">{children}</li>;
}

/** Only the details scroll; the card's heading and actions stay outside this region. */
export function CardContent({ children, label }: { children: React.ReactNode; label: string }) {
  return <div className="needs-you-content space-y-2 text-[12px] text-ink-2" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}

export function CardText({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md needs-you-text" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function CardActions({ children }: { children: React.ReactNode }) {
  return <div className="needs-you-actions sticky bottom-0 -mx-3.5 -mb-3 flex shrink-0 flex-wrap items-center gap-2 rounded-b-lg bg-raised px-3.5 pb-3 pt-2">{children}</div>;
}

/**
 * A permission prompt held for you. recLabel: who the one-line note is from ("Coordinator" when the
 * built-in coordinator judged it; null when it's only Switchboard's always-ask reason).
 */
/** The session whose own view these cards are shown in (null elsewhere). */
export const CardsHere = createContext<string | null>(null);

/** "See the session", except on cards already in that session. */
export function SessionLink({ id, children }: { id: string; children: React.ReactNode }) {
  if (useContext(CardsHere) === id) return null;
  return (
    <button className="text-[12px] text-ink-3 underline-offset-2 hover:underline" onClick={() => openSession(id)}>
      {children}
    </button>
  );
}

export function PermissionCard({ item, sessions, recLabel }: { item: AttentionItem; sessions: Record<string, Session>; recLabel: string | null }) {
  const questions = questionsOf(item);
  if (questions) return <QuestionCard item={item} questions={questions} sessions={sessions} />;
  return <ApprovalCard item={item} sessions={sessions} recLabel={recLabel} />;
}

function ApprovalCard({ item, sessions, recLabel }: { item: AttentionItem; sessions: Record<string, Session>; recLabel: string | null }) {
  const a = useAction();
  const who = sessions[item.sessionId] ? sessionTitle(sessions[item.sessionId]) : (item.sessionName ?? "A session");
  const rec = typeof item.meta.recommendation === "string" ? item.meta.recommendation : null;
  const denial = typeof item.meta.denialReason === "string" ? item.meta.denialReason : null;
  const waiting = item.meta.replyState === "sending" || item.meta.replyState === "queued";
  const uncertain = item.meta.replyState === "uncertain";
  return (
    <Card>
      <p className="text-[13px] font-medium text-ink">
        {who} <span className="font-normal text-ink-3">wants to:</span>
      </p>
      <CardContent label="Permission details">
        {item.text && <CardText text={item.text} />}
        {denial && <CardText text={`Denied by the session: ${denial}`} />}
        {waiting && <p className="text-ink-3">Sending your decision to the session…</p>}
        {uncertain && <p className="text-red">Delivery is uncertain. Check the reply in the session before sending again.</p>}
        {item.meta.replyState === "failed" && <p className="text-red">The reply was not delivered. You can try again.</p>}
        {rec && <CardText text={recLabel ? `${recLabel}: ${rec}` : rec} />}
      </CardContent>
      <CardActions>
        <button className={primary} disabled={a.busy || waiting || uncertain} onClick={() => void a.run(() => answerApproval(item.id, "accept"))}>
          Allow
        </button>
        <button className={btn} disabled={a.busy || waiting || uncertain} onClick={() => void a.run(() => answerApproval(item.id, "decline"))}>
          Deny
        </button>
        <SessionLink id={item.sessionId}>See the session</SessionLink>
        {a.error && <span className="text-[12px] text-red">{a.error}</span>}
      </CardActions>
    </Card>
  );
}

/** A session asks you something (Claude's AskUserQuestion): its options as buttons, or your own words. */
function QuestionCard({ item, questions, sessions }: { item: AttentionItem; questions: Question[]; sessions: Record<string, Session> }) {
  const who = sessions[item.sessionId] ? sessionTitle(sessions[item.sessionId]) : (item.sessionName ?? "A session");
  return (
    <Card>
      <p className="text-[13px] font-medium text-ink">
        {who} <span className="font-normal text-ink-3">asks you:</span>
      </p>
      <QuestionForm item={item} questions={questions} />
      <SessionLink id={item.sessionId}>See the session</SessionLink>
    </Card>
  );
}

/**
 * The answer form: one button per option and a box for your own words, per question. A single
 * single-choice question is answered by one tap; otherwise pick or type for each, then Send.
 * The answers go back to the session (it continues as if you'd answered in its own dialog).
 */
export function QuestionForm({ item, questions }: { item: AttentionItem; questions: Question[] }) {
  const a = useAction();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const onTap = answersOnTap(questions);
  const ready = answersFrom(questions, picked, typed);
  const send = (answers: Record<string, string>) => void a.run(() => answerQuestion(item.id, answers));
  return (
    <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
      {questions.map((q) => (
        <div key={q.question} className="space-y-1.5">
          <CardContent label="Question details">
            {q.header && <span className="rounded bg-panel px-1.5 py-0.5 text-[11px] text-ink-3">{q.header}</span>}
            <CardText text={q.question} />
            {q.multiSelect && <span className="text-[11px] text-ink-3">(pick any)</span>}
          </CardContent>
          {q.options.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {q.options.map((o) => {
                const on = (picked[q.question] ?? []).includes(o.label);
                return (
                  <button
                    key={o.label}
                    disabled={a.busy}
                    aria-pressed={onTap ? undefined : on}
                    onClick={() => (onTap ? send({ [q.question]: o.label }) : setPicked({ ...picked, [q.question]: pick(q, picked[q.question] ?? [], o.label) }))}
                    className={`rounded-md border px-2.5 py-1.5 text-left text-[12px] disabled:opacity-40 ${on ? "border-focus bg-focus/15 text-ink" : "border-line-strong text-ink-2 hover:bg-hover"}`}
                  >
                    <span className="font-medium">{o.label}</span>
                    {o.description && <span className="block text-[11px] text-ink-3">{o.description}</span>}
                  </button>
                );
              })}
            </div>
          )}
          <input
            value={typed[q.question] ?? ""}
            onChange={(e) => setTyped({ ...typed, [q.question]: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready) send(ready);
            }}
            placeholder={q.options.length ? "Or answer in your own words" : "Your answer"}
            aria-label={`Your answer: ${q.question}`}
            className="w-full rounded-md border border-line bg-bg px-2.5 py-1 text-[12px]"
          />
        </div>
      ))}
      <div className="flex items-center gap-2">
        {(!onTap || (typed[questions[0].question] ?? "").trim() !== "") && (
          <button className={primary} disabled={a.busy || !ready} onClick={() => ready && send(ready)}>
            Send {questions.length > 1 ? "answers" : "answer"}
          </button>
        )}
        {a.error && <span className="text-[12px] text-red">{a.error}</span>}
      </div>
    </div>
  );
}

/**
 * Anything else waiting on you, as a card that settles it: a session's question (Reply right here;
 * it's settled when your answer reaches the session), a coordinator escalation or a failure (Got it),
 * or a prompt only its session can answer (open it there).
 */
export function AttentionCard({ item, sessions }: { item: AttentionItem; sessions: Record<string, Session> }) {
  const a = useAction();
  const [replying, setReplying] = useState(false);
  const session = sessions[item.sessionId];
  const who = session ? sessionTitle(session) : (item.sessionName ?? (item.sessionId === "coordinator" ? "The coordinator" : "A session"));
  const canReply = item.kind === "question" && !!session && session.sendMethods.length > 0;
  const line =
    item.kind === "question" ? `${who} asks you:` : item.kind === "escalation" ? `${item.title}` : item.kind === "failed" ? `${who} failed.` : `${who} needs approval in its own window.`;
  return (
    <Card>
      <p className="text-[13px] font-medium text-ink">{line}</p>
      {item.text && <CardContent label="Attention details"><CardText text={item.text} /></CardContent>}
      {replying && session ? (
        <CardActions><Composer session={session} draftKey={`reply:${item.id}`} compact autoFocus onSent={() => setReplying(false)} /></CardActions>
      ) : (
        <CardActions>
          {canReply && (
            <button className={primary} onClick={() => setReplying(true)}>
              Reply
            </button>
          )}
          {(item.kind === "escalation" || item.kind === "failed") && (
            <button className={primary} disabled={a.busy} onClick={() => void a.run(() => acknowledge(item.id))}>
              Got it
            </button>
          )}
          {session && <SessionLink id={item.sessionId}>{canReply || item.kind !== "question" ? "See the session" : "Answer in the session"}</SessionLink>}
          {a.error && <span className="text-[12px] text-red">{a.error}</span>}
        </CardActions>
      )}
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
