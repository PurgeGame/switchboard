import { useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Session, Task } from "../../../shared/types.ts";
import { stopObjective } from "../api.ts";
import { openItems } from "../attention.ts";
import { duration } from "../format.ts";
import { happeningLabels as labels, happeningTaskSummary, happeningTaskView, happeningView, type HappeningObjective, type HappeningStatus as Status, type HappeningTaskView as TaskView } from "../happening.ts";
import { sessionTitle } from "../status.ts";
import { openSession, setInboxOpen, useNow, useStore } from "../store.ts";
import { Chevron, StatusIcon } from "./Icons.tsx";
import { useAction } from "./NeedsYouParts.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { TaskHistory } from "./TaskHistory.tsx";
import "./Happening.css";

/** Open the inbox before focusing its decisions. */
function reviewDecisions() {
  flushSync(() => setInboxOpen(true));
  const region = document.getElementById("needs-you");
  region?.scrollIntoView({ block: "nearest" });
  region?.focus({ preventScroll: true });
}

const legend: Status[] = ["running", "needs", "waiting", "idle", "queued", "failed", "done"];

function StatusMark({ status }: { status: Status }) {
  if (status === "running" || status === "queued") return <span aria-hidden className={`happening-dot ${status === "running" ? "happening-pulse" : ""}`} />;
  if (status === "waiting") return <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="m6 10 4-4M6.5 5l1.8-1.8a3.2 3.2 0 0 1 4.5 4.5L11 9.5M5 6.5 3.2 8.3a3.2 3.2 0 0 0 4.5 4.5L9.5 11" /></svg>;
  return <StatusIcon width={16} height={16} name={status === "needs" ? "question" : status === "done" ? "check" : status === "stopped" ? "stop" : status === "idle" ? "pause" : "cross"} />;
}

/** A separate 44px status target leaves the rest of the row free to open its session. */
function TaskStatus({ status, label }: { status: Status; label: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  return <div ref={root} className={`happening-status happening-${status}`}>
    <button type="button" className="happening-status-button" aria-label={`Status: ${label}`} aria-expanded={open} aria-describedby={open ? id : undefined} title={label} onClick={() => setOpen(!open)}>
      <StatusMark status={status} />
    </button>
    {open && <div id={id} role="tooltip" className="happening-tooltip">{label}</div>}
  </div>;
}

function WorkerTime({ session }: { session: Session }) {
  const now = useNow();
  const since = session.turnStartedAt ?? session.startedAt;
  return <span className="happening-worker">
    <ProviderIcon provider={session.provider} size={14} />
    <span aria-label={since === null ? "Elapsed time unavailable" : "Elapsed time"}>{since === null ? "–" : duration(now - since)}</span>
  </span>;
}

function ObjectiveCard({ item, allTasks, view, expanded, toggle, decision }: {
  item: HappeningObjective; allTasks: Task[]; view: (t: Task) => TaskView;
  expanded: boolean; toggle: () => void; decision: boolean;
}) {
  const { objective: o } = item;
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const action = useAction();
  const rowsId = useId();
  const mine = allTasks.filter((t) => t.objectiveId === o.id);
  const summary = happeningTaskSummary(item.tasks, view);
  const collapsible = item.state === "active";
  const full = !collapsible || expanded;
  const rows = full ? item.tasks : summary.running;
  const summaryText = [summary.text, decision ? "Decision pending" : ""].filter(Boolean).join(" · ");
  const canStop = item.state === "active" && o.grant && !o.grant.revokedAt;
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (menu.current && !menu.current.contains(e.target as Node)) menu.current.open = false; };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && menu.current?.open) { e.stopImmediatePropagation(); menu.current.open = false; trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, []);
  return <li className={`happening-card ${full ? "happening-details-open" : ""} ${item.state !== "active" ? "happening-finished" : ""}`} data-objective-id={o.id}>
    <div className="happening-card-heading">
      <h4>{collapsible ? <button type="button" className="happening-objective-toggle" aria-expanded={expanded} aria-controls={rowsId} aria-label={`${expanded ? "Collapse" : "Expand"} ${o.title}. ${summary.other.length} other ${summary.other.length === 1 ? "task" : "tasks"}. ${summaryText}`} onClick={toggle}>
        <Chevron className={expanded ? "happening-expanded" : ""} />
        <span className="happening-heading-text"><span className="happening-title" title={o.title}>{o.title}</span><span className="happening-task-counts">{summaryText}</span></span>
      </button> : <span className="happening-title">{o.title}</span>}</h4>
      {canStop && <details ref={menu} className="happening-actions">
        <summary ref={trigger} aria-label={`Actions for ${o.title}`} title="Objective actions">⋯</summary>
        <div className="happening-menu">
          <button type="button" disabled={action.busy} onClick={() => void action.run(async () => {
            // Re-granting changes worker bindings and verified evidence; it is not an Undo.
            await stopObjective(o.id);
            if (menu.current) menu.current.open = false;
          })}>{action.busy ? "Stopping…" : "Stop objective"}</button>
        </div>
      </details>}
    </div>
    {item.state !== "active" && <p className="happening-outcome">{o.grant?.revokedAt ? "Stopped" : item.state === "done" ? "Done" : "Closed"}</p>}
    <div className="happening-progress" role="progressbar" aria-label={`${o.title}: verified tasks`} aria-valuemin={0} aria-valuemax={Math.max(1, item.total)} aria-valuenow={item.done} aria-valuetext={item.total ? `${item.done} of ${item.total} tasks verified` : "No tasks yet"}>
      {mine.length ? mine.map((t) => <span key={t.id} className={`happening-segment happening-${view(t).status}`} />) : <span className="happening-segment happening-queued" />}
    </div>
    <ul id={rowsId} className="happening-tasks" hidden={!rows.length}>
      {rows.map((t) => {
        const v = view(t);
        const canOpen = !!v.session || v.status === "needs" || v.status === "failed";
        const content = <><span className="happening-title" title={t.title}>{t.title}</span>{v.running && v.session && <WorkerTime session={v.session} />}</>;
        return <li key={t.id} className="happening-task flex-wrap" data-task-id={t.id}>
          <TaskStatus status={v.status} label={v.label} />
          {canOpen ? <button type="button" className="happening-task-content" aria-label={`${t.title}. ${v.label}. ${v.session ? "Open worker session" : "Review decisions"}`} onClick={() => v.session ? openSession(v.session.id) : reviewDecisions()}>{content}</button> : <div className="happening-task-content">{content}</div>}
          {full && <div className="happening-task-details">
            <p className={`happening-${v.status}`}>{v.label} <span className="happening-task-lifecycle">· Task {t.status.replaceAll("_", " ")}</span></p>
            {t.description && <p className="happening-task-text">{t.description}</p>}
            {v.session ? <button type="button" className="happening-owner" onClick={() => openSession(v.session!.id)}>Worker: {sessionTitle(v.session)}</button> : <p>Owner: {t.owner ?? "Unassigned"}</p>}
            {!!t.prerequisites.length && <div>Depends on:<ul className="happening-dependencies">{t.prerequisites.map((id) => {
              const dependency = allTasks.find((task) => task.id === id);
              return <li key={id}>{dependency?.title ?? id} <span>({dependency ? view(dependency).label : "Unavailable"})</span></li>;
            })}</ul></div>}
            {!!t.acceptance.length && <div>Acceptance:<ul className="happening-dependencies">{t.acceptance.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
            {t.result && <p className="happening-task-text">{t.result}</p>}
            {(v.status === "needs" || v.status === "failed") && <button type="button" className="happening-review" onClick={reviewDecisions}>Review decisions <Chevron /></button>}
            <TaskHistory task={t} />
          </div>}
        </li>;
      })}
    </ul>
    {full && mine.length === 0 && <p className="happening-empty-card">No tasks started yet.</p>}
    {action.error && <p role="alert" className="happening-error">{action.error}</p>}
  </li>;
}

export function Happening() {
  const coordinator = useStore((s) => s.coordinator);
  const { objectives, tasks } = useStore((s) => s.coordination);
  const sessions = useStore((s) => s.sessions);
  const attention = useStore((s) => s.attention);
  const [showFinished, setShowFinished] = useState(false);
  // Cards move between groups on live pushes. Keep user choices above those mounts.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const finishedId = useId();
  const model = useMemo(() => {
    const open = openItems(attention);
    const failed = new Set((coordinator?.plans ?? []).flatMap((p) => p.tasks.filter((t) => t.state === "failed").map((t) => t.taskId)));
    const pending = (coordinator?.proposals ?? []).filter((p) => p.state === "pending");
    const view = (t: Task) => happeningTaskView(t, { sessions, open, failed, pending });
    const hasDecision = (item: HappeningObjective) => pending.some((p) => p.payload?.objectiveId === item.objective.id) || open.some((i) => i.meta.objectiveId === item.objective.id);
    const hidden = happeningView(objectives, tasks, false).hidden;
    const visible = happeningView(objectives, tasks, showFinished).objectives;
    const groups: Record<"needs" | "running" | "queued" | "finished", HappeningObjective[]> = { needs: [], running: [], queued: [], finished: [] };
    for (const item of visible) {
      const states = item.tasks.map((t) => view(t).status);
      const decision = hasDecision(item);
      const group = item.state !== "active" ? "finished" : decision || states.includes("needs") || states.includes("failed") ? "needs" : item.tasks.some((t) => view(t).running) ? "running" : "queued";
      groups[group].push(item);
    }
    return { groups, hidden, view, hasDecision };
  }, [objectives, tasks, sessions, attention, coordinator, showFinished]);
  const { groups, hidden, view, hasDecision } = model;
  const jump = (key: string) => {
    requestAnimationFrame(() => {
      sectionRefs.current[key]?.scrollIntoView({ block: "start", behavior: "smooth" });
      sectionRefs.current[key]?.focus({ preventScroll: true });
    });
  };
  const cards = (items: HappeningObjective[]) => <ul className="happening-cards">{items.map((item) => <ObjectiveCard key={item.objective.id} item={item} allTasks={tasks} view={view} decision={hasDecision(item)} expanded={!!expanded[item.objective.id]} toggle={() => setExpanded((current) => ({ ...current, [item.objective.id]: !current[item.objective.id] }))} />)}</ul>;
  return <section aria-label="What's happening" className="happening">
    <div className="happening-header"><h2>What's happening</h2>
    <details className="happening-legend">
      <summary aria-label="Status guide" title="Status guide"><StatusIcon name="question" width={16} height={16} /></summary>
      <ul>{legend.map((status) => <li key={status} className={`happening-${status}`}><StatusMark status={status} /><span>{labels[status]}</span></li>)}</ul>
    </details></div>
    <nav className="happening-summary" aria-label="Objective counts">
      {groups.running.length > 0 && <button type="button" className="happening-running" onClick={() => jump("running")}><strong>{groups.running.length}</strong> running</button>}
      {groups.needs.length > 0 && <button type="button" className="happening-needs" onClick={() => jump("needs")}><strong>{groups.needs.length}</strong> needs you</button>}
      {groups.queued.length > 0 && <button type="button" onClick={() => jump("queued")}><strong>{groups.queued.length}</strong> queued</button>}
    </nav>
    <section hidden={!groups.needs.length} className="happening-group" aria-label="Objectives needing you" tabIndex={-1} ref={(el) => { sectionRefs.current.needs = el; }}>
      <h3 className="happening-needs">Needs you <span>{groups.needs.length}</span></h3>
      {groups.needs.length ? <>{cards(groups.needs)}<button type="button" className="happening-review" onClick={() => reviewDecisions()}>Review decisions <Chevron /></button></> : <p className="happening-empty">Nothing waiting on you.</p>}
    </section>
    <section hidden={!groups.running.length} className="happening-group" aria-label="Running objectives" tabIndex={-1} ref={(el) => { sectionRefs.current.running = el; }}>
      <h3 className="happening-running">Running <span>{groups.running.length}</span></h3>
      {groups.running.length ? cards(groups.running) : <p className="happening-empty">No active workers right now.</p>}
    </section>
    <section hidden={!groups.queued.length} className="happening-group" aria-label="Queued objectives" tabIndex={-1} ref={(el) => { sectionRefs.current.queued = el; }}>
      <h3>Waiting / queued <span>{groups.queued.length}</span></h3>
      {groups.queued.length ? cards(groups.queued) : <p className="happening-empty">Nothing queued.</p>}
    </section>
    {(hidden > 0 || showFinished) && <>
      <button type="button" className="happening-show-finished" aria-expanded={showFinished} aria-controls={finishedId} onClick={() => setShowFinished(!showFinished)}>{showFinished ? "Hide finished" : `Show finished (${hidden})`}</button>
      <div id={finishedId} hidden={!showFinished}>{cards(groups.finished)}</div>
    </>}
    {objectives.length === 0 && <p className="happening-empty">{coordinator?.agent === "external" ? "No projects yet." : "No projects yet. Tell the coordinator what you want done."}</p>}
  </section>;
}
