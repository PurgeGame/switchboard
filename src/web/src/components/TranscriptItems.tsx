import { memo, useMemo, useState } from "react";
import type { SbEvent } from "../../../shared/types.ts";
import { clip, clock, duration } from "../format.ts";
import { renderMarkdown } from "../markdown.ts";
import { Chevron } from "./Icons.tsx";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function Label({ children, tone = "text-ink-3" }: { children: React.ReactNode; tone?: string }) {
  return <div className={`mb-1 flex items-baseline gap-2 text-[11px] font-medium ${tone}`}>{children}</div>;
}

function Stamp({ ts }: { ts: number }) {
  return <time className="font-normal text-ink-3/80">{clock(ts)}</time>;
}

function Message(props: { event: SbEvent; label: string; tone: string; box: string }) {
  const { event } = props;
  return (
    <div className={`rounded-lg px-3.5 py-2.5 ${props.box}`}>
      <Label tone={props.tone}>
        {props.label} <Stamp ts={event.ts} />
      </Label>
      <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{str(event.data.text)}</div>
    </div>
  );
}

function Assistant({ event }: { event: SbEvent }) {
  const html = useMemo(() => renderMarkdown(str(event.data.text)), [event.data.text]);
  return (
    <div className="px-1">
      <Label>
        Assistant <Stamp ts={event.ts} />
      </Label>
      <div className="md break-words text-[13.5px] leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function Rule({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1 text-[11px] text-ink-3" role="separator">
      <span className="h-px flex-1 bg-line" />
      {children}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function Note({ event, tone, children }: { event: SbEvent; tone: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-md border border-dashed px-3 py-1.5 text-[12px] ${tone}`}>
      {children} <Stamp ts={event.ts} />
    </div>
  );
}

function ToolLine({ call, result }: { call: SbEvent; result?: SbEvent }) {
  const [open, setOpen] = useState(false);
  const paths = Array.isArray(call.data.paths) ? (call.data.paths as string[]) : [];
  const summary = str(call.data.summary);
  const failed = result?.data.isError === true;
  const exit = call.data.exitCode;
  return (
    <div className="rounded-md">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] hover:bg-hover"
      >
        <Chevron width={11} height={11} className={`shrink-0 text-ink-3 ${open ? "rotate-90" : ""}`} />
        <span className="shrink-0 font-mono font-medium text-ink-2">{str(call.data.name) || "tool"}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-ink-3">{clip(summary, 140)}</span>
        {failed && <span className="shrink-0 text-red">failed</span>}
        {typeof exit === "number" && exit !== 0 && <span className="shrink-0 text-red">exit {exit}</span>}
      </button>
      {open && (
        <div className="ml-6 space-y-1.5 border-l border-line pb-2 pl-3 text-[12px]">
          <pre className="whitespace-pre-wrap break-all font-mono text-ink-2">{summary}</pre>
          {paths.length > 0 && (
            <ul className="font-mono text-ink-3">
              {paths.map((p) => (
                <li key={p} className="break-all">
                  {p}
                </li>
              ))}
            </ul>
          )}
          {result ? (
            <pre className={`max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-panel p-2 font-mono ${failed ? "text-red" : "text-ink-2"}`}>
              {str(result.data.preview) || "(empty result)"}
            </pre>
          ) : (
            <p className="text-ink-3">No result recorded for this call.</p>
          )}
        </div>
      )}
    </div>
  );
}

function ToolGroup({ calls, results }: { calls: SbEvent[]; results: Map<string, SbEvent> }) {
  const [open, setOpen] = useState(false);
  const line = (c: SbEvent) => <ToolLine key={c.id ?? c.sourceId} call={c} result={results.get(str(c.data.toolUseId))} />;
  if (calls.length === 1) return <div className="px-1">{line(calls[0])}</div>;
  const names = [...new Set(calls.map((c) => str(c.data.name)))].slice(0, 4).join(", ");
  return (
    <div className="rounded-md border border-line bg-panel/60 px-1 py-0.5">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-ink-2 hover:bg-hover"
      >
        <Chevron width={11} height={11} className={`shrink-0 text-ink-3 ${open ? "rotate-90" : ""}`} />
        <span className="font-medium">{calls.length} tool calls</span>
        <span className="min-w-0 flex-1 truncate font-mono text-ink-3">{names}</span>
      </button>
      {open && <div>{calls.map(line)}</div>}
    </div>
  );
}

function EventItemBase({ event: e }: { event: SbEvent }) {
  switch (e.type) {
    case "user_msg":
      return <Message event={e} label="You" tone="text-focus" box="border border-line-strong bg-raised" />;
    case "peer_msg":
      return (
        <Message
          event={e}
          label={`peer · ${str(e.data.from) || "unknown"}`}
          tone="text-ink-3 italic"
          box="border border-dashed border-line-strong text-ink-2"
        />
      );
    case "auto_msg":
      return <Message event={e} label="auto" tone="text-ink-3" box="border border-line bg-panel text-ink-2" />;
    case "coordinator_msg":
      return <Message event={e} label="coordinator" tone="text-ink-3" box="border border-line bg-panel text-ink-2" />;
    case "assistant_msg":
      return <Assistant event={e} />;
    case "turn_started":
      return <Rule>turn started {clock(e.ts)}</Rule>;
    case "turn_ended":
      return <Rule>turn ended{typeof e.data.durationMs === "number" ? ` · ${duration(e.data.durationMs)}` : ""}</Rule>;
    case "interrupted":
      return (
        <Note event={e} tone="border-redmuted/50 text-redmuted">
          Interrupted{str(e.data.reason) ? ` (${str(e.data.reason)})` : ""}
        </Note>
      );
    case "error":
      return (
        <Note event={e} tone="border-red/40 text-red/90">
          <span className="font-medium">Error</span> {clip(str(e.data.text), 400)}
        </Note>
      );
    case "needs_input":
      return (
        <Note event={e} tone="border-amber/40 text-amber">
          Waiting for input {clip(str(e.data.text), 300)}
        </Note>
      );
    case "queued_input":
      return (
        <Note event={e} tone="border-line text-ink-3">
          Queued: {clip(str(e.data.text), 200)}
        </Note>
      );
    case "session_started":
      return <Rule>session started {clock(e.ts)}</Rule>;
    case "session_ended":
      return <Rule>session ended {clock(e.ts)}</Rule>;
    case "renamed":
      return <Rule>renamed to {str(e.data.name) || "a new name"}</Rule>;
    default:
      return null;
  }
}

export const EventItem = memo(EventItemBase);
export const ToolRun = memo(ToolGroup);
