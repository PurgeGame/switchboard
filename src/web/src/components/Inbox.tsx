import { useMemo, useState } from "react";
import type { AttentionItem, PerspectiveGroup, Session } from "../../../shared/types.ts";
import { autoHandled, groupIdOf, groupInbox, subjectName, isAckable, KIND, openItems, OUTCOME, recentlyResolved, RESOLUTION } from "../attention.ts";
import { duration, relative } from "../format.ts";
import { sessionTitle } from "../status.ts";
import { answerApproval, type ApprovalDecision } from "../api.ts";
import { acknowledge, openGroup, openSession, selectInboxItem, setInboxOpen, setReplyOpen, useNow, useStore } from "../store.ts";
import { Composer } from "./Composer.tsx";
import { ProviderGlyph } from "./Badges.tsx";
import { Chevron, StatusIcon } from "./Icons.tsx";

const COLLAPSE_AT = 420;

function Tag({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className="rounded border border-line-strong px-1.5 py-px text-[10px] text-ink-2">
      {children}
    </span>
  );
}

function ItemText({ text }: { text: string }) {
  const long = text.length > COLLAPSE_AT || text.split("\n").length > 8;
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div
        className={`whitespace-pre-wrap break-words rounded-md border border-line bg-bg px-3 py-2 text-[12.5px] leading-relaxed text-ink ${
          long && !open ? "max-h-32 overflow-hidden [mask-image:linear-gradient(#000_60%,transparent)]" : "max-h-96 overflow-y-auto"
        }`}
      >
        {text}
      </div>
      {long && (
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-1 text-[11px] text-focus hover:underline">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function FinishedMeta({ item }: { item: AttentionItem }) {
  const durationMs = item.meta.durationMs;
  if (!item.outcome && typeof durationMs !== "number") return null;
  const outcome = item.outcome ? OUTCOME[item.outcome] : null;
  return (
    <div className="flex items-center gap-2 text-[11px] text-ink-3">
      {outcome && (
        <>
          <span>Agent's claim, not verified:</span>
          <span className={`pill tone-${outcome.tone} rounded-full px-2 py-0.5 font-medium`}>{outcome.label}</span>
        </>
      )}
      {typeof durationMs === "number" && <span className="ml-auto font-mono tabular-nums">ran {duration(durationMs)}</span>}
    </div>
  );
}

const APPROVAL_HINT = "This approval can only be answered in its session.";

const DECISIONS: { decision: ApprovalDecision; label: string }[] = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Approve for session" },
  { decision: "decline", label: "Deny" },
];

function ApprovalActions({ item }: { item: AttentionItem }) {
  const [pending, setPending] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = async (decision: ApprovalDecision) => {
    setPending(decision);
    setError(null);
    try {
      await answerApproval(item.id, decision);
    } catch (err) {
      setError((err as Error).message);
      setPending(null);
    }
  };
  return (
    <>
      {DECISIONS.map(({ decision, label }) => (
        <button
          key={decision}
          disabled={pending !== null}
          onClick={(e) => {
            e.stopPropagation();
            void answer(decision);
          }}
          className={`rounded-md border px-2.5 py-1 text-[12px] disabled:opacity-50 ${
            decision === "decline" ? "border-red/50 text-red hover:bg-red/10" : "border-amber/60 text-amber hover:bg-amber/10"
          }`}
        >
          {pending === decision ? "Sending…" : label}
        </button>
      ))}
      {error && <p className="w-full text-[11px] text-red">{error}</p>}
    </>
  );
}

function InboxItem({ item, session, selected, now }: { item: AttentionItem; session: Session | undefined; selected: boolean; now: number }) {
  const meta = KIND[item.kind];
  const groupId = groupIdOf(item);
  const name = useStore((s) => subjectName(item, s.sessions, s.groups));
  const replying = useStore((s) => s.replyOpenId === item.id);
  const canReply = item.kind === "question" && !!session && session.sendMethods.length > 0;
  const answerable = item.kind === "approval" && typeof item.meta.answerKey === "string";
  const jumpOnly = item.kind === "approval" && !answerable;
  return (
    <li
      data-inbox-id={item.id}
      onClick={() => selectInboxItem(item.id)}
      aria-current={selected ? "true" : undefined}
      className={`tone-${meta.tone} relative space-y-2 border-b border-line px-4 py-3 pl-5 ${selected ? "bg-raised" : ""}`}
    >
      <span aria-hidden className="rail absolute inset-y-2 left-0 w-[3px] rounded-r" />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {session && <ProviderGlyph provider={session.provider} />}
        <span className="min-w-0 max-w-[55%] truncate font-medium">{name}</span>
        <span className="pill inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
          <StatusIcon name={meta.icon} width={11} height={11} />
          {meta.label}
        </span>
        {item.kind === "question" && item.meta.continuationAsk === true && <Tag title="The agent is asking whether to carry on">asks to continue</Tag>}
        {item.historical && <Tag title="Found while reading past activity">from history</Tag>}
        <time className="ml-auto text-[11px] text-ink-3">{relative(item.createdAt, now)}</time>
      </div>
      <p className="font-medium">{item.title}</p>
      {item.text && <ItemText text={item.text} />}
      {item.kind === "question" && typeof item.meta.autoDeclined === "string" && (
        <p className="text-[11px] text-ink-3">Not auto-answered: {item.meta.autoDeclined}</p>
      )}
      {item.kind === "finished" && <FinishedMeta item={item} />}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {answerable && <ApprovalActions item={item} />}
        {item.kind === "question" && !groupId && (
          <button
            disabled={!canReply}
            aria-expanded={replying}
            onClick={(e) => {
              e.stopPropagation();
              setReplyOpen(replying ? null : item.id);
            }}
            className="rounded-md border border-amber/60 px-2.5 py-1 text-[12px] text-amber hover:bg-amber/10 disabled:cursor-not-allowed disabled:border-line disabled:text-ink-3 disabled:opacity-70"
          >
            Reply <kbd className="ml-1 font-mono text-[10px] opacity-70">r</kbd>
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (groupId) openGroup(groupId);
            else openSession(item.sessionId);
          }}
          className="rounded-md border border-line-strong px-2.5 py-1 text-[12px] hover:bg-hover"
        >
          {jumpOnly ? "Jump to session" : "Open"}
        </button>
        {isAckable(item.kind) && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void acknowledge(item.id);
            }}
            className="rounded-md border border-line-strong px-2.5 py-1 text-[12px] hover:bg-hover"
          >
            Acknowledge <kbd className="ml-1 font-mono text-[10px] text-ink-3">a</kbd>
          </button>
        )}
        {jumpOnly && <span className="min-w-0 flex-1 text-[11px] text-ink-3">{APPROVAL_HINT}</span>}
        {item.kind === "question" && !canReply && !groupId && <span className="min-w-0 flex-1 text-[11px] text-ink-3">Replying from here isn't available for this session. Answer it in the session.</span>}
      </div>
      {replying && session && canReply && (
        <div onClick={(e) => e.stopPropagation()}>
          <Composer
            session={session}
            draftKey={`reply:${item.id}`}
            prefill={typeof item.meta.suggestedReply === "string" ? item.meta.suggestedReply : undefined}
            compact
            autoFocus
            onSent={() => setReplyOpen(null)} />
        </div>
      )}
    </li>
  );
}

function AutoHandledList({ items, sessions, groups, now }: { items: AttentionItem[]; sessions: Record<string, Session>; groups: Record<string, PerspectiveGroup>; now: number }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <section>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-y border-line px-4 py-1.5 text-left text-[12px] font-semibold text-ink-3 hover:text-ink-2"
      >
        <Chevron width={12} height={12} className={open ? "rotate-90" : ""} />
        Auto-handled <span className="font-normal">{items.length}</span>
      </button>
      {open && (
        <ul>
          {items.map((i) => {
            const name = subjectName(i, sessions, groups);
            const quote = typeof i.meta.autoQuote === "string" ? i.meta.autoQuote : null;
            const reason = typeof i.meta.autoReason === "string" ? i.meta.autoReason : null;
            return (
              <li key={i.id} className="space-y-1 border-b border-line/60 px-4 py-2 text-[12px]">
                <div className="flex items-baseline gap-2 text-ink-3">
                  <span className="min-w-0 flex-1 truncate text-ink-2">{name}</span>
                  <time>{relative(i.resolvedAt, now)}</time>
                </div>
                <p className="line-clamp-3 whitespace-pre-wrap text-ink-2">{i.text ?? i.title}</p>
                {quote && <p className="text-ink-3">You said: "{quote}"</p>}
                {reason && <p className="text-ink-3">{reason}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ResolvedList({ items, sessions, groups, now }: { items: AttentionItem[]; sessions: Record<string, Session>; groups: Record<string, PerspectiveGroup>; now: number }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <section>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-y border-line px-4 py-1.5 text-left text-[12px] font-semibold text-ink-3 hover:text-ink-2"
      >
        <Chevron width={12} height={12} className={open ? "rotate-90" : ""} />
        Recently resolved <span className="font-normal">{items.length}</span>
      </button>
      {open && (
        <ul>
          {items.map((i) => {
            const name = subjectName(i, sessions, groups);
            return (
              <li key={i.id} className="space-y-0.5 border-b border-line/60 px-4 py-2 text-[12px] text-ink-3">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-ink-2">{name}</span>
                  <span>{KIND[i.kind].label}</span>
                  <time>{relative(i.resolvedAt, now)}</time>
                </div>
                <p className="truncate">{i.title}</p>
                <p>
                  {i.resolution ? RESOLUTION[i.resolution] : "resolved"}
                  {i.resolutionNote ? ` · ${i.resolutionNote}` : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function Inbox() {
  const attention = useStore((s) => s.attention);
  const sessions = useStore((s) => s.sessions);
  const perspectiveGroups = useStore((s) => s.groups);
  const selectedItem = useStore((s) => s.inboxSelectedId);
  const error = useStore((s) => s.attentionError);
  const now = useNow();
  const groups = useMemo(() => groupInbox(openItems(attention)), [attention]);
  const resolved = useMemo(() => recentlyResolved(attention).filter((i) => i.resolution !== "auto"), [attention]);
  const auto = useMemo(() => autoHandled(attention), [attention]);

  return (
    <aside aria-label="Attention inbox" className="fixed bottom-0 right-0 top-11 z-30 flex w-[min(440px,100vw)] flex-col border-l border-line-strong bg-panel shadow-2xl lg:static lg:z-auto lg:w-[400px] lg:shrink-0 lg:shadow-none">
      <div className="flex items-center border-b border-line px-4 py-2">
        <h2 className="flex-1 text-[14px] font-semibold">Inbox</h2>
        <button onClick={() => setInboxOpen(false)} aria-label="Close inbox" className="rounded px-2 py-0.5 text-[12px] text-ink-3 hover:bg-hover hover:text-ink">
          Close <kbd className="font-mono text-[10px]">Esc</kbd>
        </button>
      </div>
      {error && (
        <p role="alert" className="border-b border-red/40 bg-red/10 px-4 py-1.5 text-red">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 && <p className="p-4 text-ink-3">Nothing needs you right now.</p>}
        {groups.map((g) => (
          <section key={g.id} aria-label={g.label}>
            <h3 className={`tone-${g.tone} sticky top-0 z-10 flex items-baseline gap-2 border-y border-line bg-panel px-4 py-1 text-[12px] font-semibold text-(--tone)`}>
              {g.label}
              <span className="font-normal text-ink-3">{g.items.length}</span>
            </h3>
            <ul>
              {g.items.map((i) => (
                <InboxItem key={i.id} item={i} session={sessions[i.sessionId]} selected={i.id === selectedItem} now={now} />
              ))}
            </ul>
          </section>
        ))}
        <AutoHandledList items={auto} sessions={sessions} groups={perspectiveGroups} now={now} />
        <ResolvedList items={resolved} sessions={sessions} groups={perspectiveGroups} now={now} />
      </div>
    </aside>
  );
}
