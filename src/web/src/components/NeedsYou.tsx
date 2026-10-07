import { useState } from "react";
import { flushSync } from "react-dom";
import { needsYouItems, type NeedsYouItem } from "../../../shared/needs-you.ts";
import { acceptTask, answerApproval, approveProposal, declineProposal, retryPlanTask } from "../api.ts";
import { acknowledge, openSession, useStore } from "../store.ts";
import { focusComposer } from "../send.ts";
import { disablePhoneNotifications, enablePhoneNotifications } from "../push.ts";
import { questionsOf } from "../questions.ts";
import { DoneCard, FailedTaskCard, ProposalCard } from "./CoordinatorPane.tsx";
import { AttentionCard, PermissionCard, useAction } from "./NeedsYouParts.tsx";

const button = "min-h-11 shrink-0 rounded-md border border-line-strong px-2 text-[12px] text-ink hover:bg-hover disabled:opacity-40";
function Row({ item }: { item: NeedsYouItem }) {
  const a = useAction();
  const [expanded, expand] = useState(false);
  const sessions = useStore((s) => s.sessions);
  const run = (fn: () => Promise<unknown>) => () => void a.run(fn);
  let actions: React.ReactNode;
  let detail: React.ReactNode;
  switch (item.kind) {
    case "proposal":
      actions = <><button className={button} disabled={a.busy || (item.proposal.payload.action === "plan" && !item.proposal.digest)} onClick={run(() => approveProposal(item.proposal.id, item.proposal.digest))}>Go ahead</button><button className={button} disabled={a.busy} onClick={run(() => declineProposal(item.proposal.id))}>No thanks</button></>;
      detail = <ProposalCard p={item.proposal} sessions={sessions} />;
      break;
    case "review":
      actions = <button className={button} disabled={a.busy} onClick={run(() => acceptTask(item.task))}>Looks good</button>;
      detail = <DoneCard t={item.task} sessions={sessions} />;
      break;
    case "launch":
      actions = <button className={button} disabled={a.busy} onClick={run(() => retryPlanTask(item.plan.proposalId, item.task.key))}>Retry</button>;
      detail = <FailedTaskCard plan={item.plan} task={item.task} />;
      break;
    case "attention": {
      const i = item.attention;
      const question = questionsOf(i);
      const permission = i.kind === "approval" && !!i.meta.answerKey;
      const deliveryPending = ["sending", "queued", "uncertain"].includes(String(i.meta.replyState));
      if (question) actions = <button className={button} onClick={() => expand(!expanded)}>Answer</button>;
      else if (permission) actions = <><button className={button} disabled={a.busy || deliveryPending} onClick={run(() => answerApproval(i.id, "accept"))}>Allow</button><button className={button} disabled={a.busy || deliveryPending} onClick={run(() => answerApproval(i.id, "decline"))}>Deny</button></>;
      else if (i.kind === "escalation") actions = <button className={button} disabled={a.busy} onClick={run(() => acknowledge(i.id))}>Got it</button>;
      else actions = <button className={button} onClick={() => {
        // Mount the destination synchronously so tapping Reply also opens the phone keyboard.
        flushSync(() => openSession(i.sessionId));
        focusComposer(`sess:${i.sessionId}`);
      }}>{i.kind === "question" ? "Reply" : "Open"}</button>;
      detail = permission ? <PermissionCard item={i} sessions={sessions} recLabel={null} /> : <AttentionCard item={i} sessions={sessions} />;
      break;
    }
  }
  return <li data-needs-you-id={item.id} className="border-t border-line px-3 py-1 sm:px-4">
    <div className="flex min-w-0 items-center gap-1.5">
      <button aria-expanded={expanded} title={item.summary} onClick={() => expand(!expanded)} className="flex min-h-11 min-w-0 flex-1 items-center gap-1 text-left text-[13px] text-ink-2 hover:text-ink"><span className="truncate">{item.summary}</span><span aria-hidden className="shrink-0 text-[10px] text-ink-3">{expanded ? "▴" : "▾"}</span></button>
      {actions}
    </div>
    {a.error && <p role="alert" className="break-words pb-2 text-[12px] text-red">{a.error}</p>}
    {expanded && <div className="pb-2"><p className="break-words py-2 text-[13px]">{item.summary}</p><ul>{detail}</ul></div>}
  </li>;
}

/** All pending decisions and notification controls, shown inside the inbox. */
export function NeedsYou() {
  const attention = useStore((s) => s.attention);
  const coordinator = useStore((s) => s.coordinator);
  const tasks = useStore((s) => s.coordination.tasks);
  const sessions = useStore((s) => s.sessions);
  const enabled = useStore((s) => s.prefs.notifications);
  const a = useAction();
  const items = needsYouItems({ attention: Object.values(attention), coordinator, tasks, sessions });
  return <section id="needs-you" tabIndex={-1} aria-label="Needs you" className="border-b border-amber/40 bg-panel">
    <div className="flex min-h-12 shrink-0 items-center gap-2 px-3 sm:px-4">
      <h2 className="text-[13px] font-semibold text-amber">Needs you</h2>
      <span aria-label={`${items.length} items need you`} aria-live="polite" className="rounded-full bg-amber/15 px-2 text-[12px] font-semibold tabular-nums text-amber">{items.length}</span>
      {!enabled && <button className={`${button} ml-auto`} disabled={a.busy} onClick={() => void a.run(enablePhoneNotifications)}>{a.busy ? "Enabling…" : "Enable notifications"}</button>}
      {enabled && <button className={`${button} ml-auto`} aria-label="Disable phone notifications" disabled={a.busy} onClick={() => void a.run(disablePhoneNotifications)}>{a.busy ? "Disabling…" : "Notifications on"}</button>}
    </div>
    {a.error && <p role="alert" className="shrink-0 px-3 pb-2 text-[12px] text-amber">{a.error}</p>}
    {items.length ? <ul>{items.map((item) => <Row key={item.id} item={item} />)}</ul> : <p className="px-3 pb-2 text-[12px] text-ink-3">Nothing needs you right now.</p>}
  </section>;
}
