import { useEffect, useRef, useState } from "react";
import type { ProviderUsage, UsageWindow } from "../../../shared/types.ts";
import { usageStatus } from "../../../shared/usage.ts";
import { useStore } from "../store.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { relative, until } from "../format.ts";

// Everything here counts down: what is LEFT. Full is green; low is amber, nearly gone is red.
const tone = (left: number) => (left <= 10 ? "text-red" : left <= 25 ? "text-amber" : "text-ink-2");

const barColor = (left: number) => (left <= 10 ? "bg-red" : left <= 25 ? "bg-amber" : "bg-green");
const byLabel = (p: ProviderUsage, label: string): UsageWindow | null => (p.available ? (p.windows.find((w) => w.label === label) ?? null) : null);

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** One thin bar: how full a window is. Empty track when there is no such window. */
function MiniBar({ w, label }: { w: UsageWindow | null; label: string }) {
  const pct = w ? w.remainingPct : 0;
  return (
    <span className="block h-[5px] w-7 shrink-0 overflow-hidden rounded-sm bg-line-strong" role="img" aria-label={w ? `${label} limit ${Math.round(w.remainingPct)}% left` : `${label} limit not reported`}>
      <span className={`block h-full ${barColor(pct)}`} style={{ width: `${Math.max(pct, pct > 0 ? 4 : 0)}%` }} />
    </span>
  );
}

/** A provider's mini graph: weekly % on the left, then two bars: weekly (top) and 5-hour (bottom). */
function Part({ name, p, now }: { name: "Claude" | "Codex"; p: ProviderUsage; now: number }) {
  const week = byLabel(p, "7d");
  const five = byLabel(p, "5h");
  const { stale } = usageStatus(p, now);
  return (
    <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
      <ProviderIcon provider={name === "Claude" ? "claude" : "codex"} size={15} />
      <span className="flex flex-col items-end leading-tight">
        <span className={`min-w-[2.2ch] text-right font-mono tabular-nums ${week ? tone(week.remainingPct) : "text-ink-3"}`}>{week ? `${Math.round(week.remainingPct)}%` : "–"}</span>
        {stale && p.available && <span className="text-[9px] text-ink-3" aria-label={`${name} stale; last updated ${relative(p.asOf, now)}`} title={`Last observed ${relative(p.asOf, now)}; tap for detail`}>stale</span>}
      </span>
      <span className="flex shrink-0 flex-col gap-[3px]">
        <MiniBar w={week} label="Weekly" />
        <MiniBar w={five} label="5-hour" />
      </span>
    </span>
  );
}

function Detail({ name, p, now }: { name: string; p: ProviderUsage; now: number }) {
  const { stale, staleReason } = usageStatus(p, now);
  return (
    <section className="space-y-1">
      <h3 className="flex items-baseline justify-between text-[12px] font-semibold text-ink">
        <span className="flex items-center gap-1.5">
          <ProviderIcon provider={name === "Claude" ? "claude" : "codex"} size={14} />
          {name}
        </span>
        {p.plan && <span className="text-[11px] font-normal text-ink-3">{p.plan}</span>}
      </h3>
      {p.windows.map((w) => (
        <div key={w.label} className="text-[12px]">
          <div className="flex justify-between">
            <span className="text-ink-2">{w.label}</span>
            <span className={`font-mono tabular-nums ${tone(w.remainingPct)}`}>
              {Math.round(w.usedPct)}% used · {Math.round(w.remainingPct)}% left
            </span>
          </div>
          <div className="mt-0.5 h-1 overflow-hidden rounded bg-raised" aria-hidden>
            <div className={`h-full ${barColor(w.remainingPct)}`} style={{ width: `${w.remainingPct}%` }} />
          </div>
          <div className="text-[11px] text-ink-3">{w.resetsAt !== null
            ? `${w.resetsAt <= now ? "Recorded reset time passed; new usage unknown" : `${stale ? "Recorded reset" : "Resets"} in ${until(w.resetsAt, now)}`} (${new Date(w.resetsAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })})`
            : "reset time unknown"}</div>
        </div>
      ))}
      {!p.available && <p className="text-[11px] text-ink-3">Usage unknown; no successful reading yet.</p>}
      {p.asOf != null && <p className="text-[11px] text-ink-3" title={new Date(p.asOf).toLocaleString()}>{stale ? "Stale · last observed" : "Last updated"} {relative(p.asOf, now)}</p>}
      {stale && p.available && staleReason && <p className="text-[11px] text-ink-3">{staleReason}</p>}
      {(p.error || p.note) && <p className="break-words text-[11px] text-ink-3">{p.error || p.note}</p>}
      {p.nextRetryAt != null && <p className="text-[11px] text-ink-3">{p.nextRetryAt > now ? `Next retry in ${until(p.nextRetryAt, now)}` : "Retry pending"}</p>}
    </section>
  );
}

/** Claude and Codex limits in the top bar: weekly % left plus a weekly and a 5-hour bar each, shrinking as usage grows; tap for every window and reset times. */
export function UsageChip() {
  const usage = useStore((s) => s.usage);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const now = useNow();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!usage) return null;
  return (
    <div ref={root} className="sm:relative">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label="Claude and Codex usage limits"
        title="Usage left: weekly % and bars for the weekly (top) and 5-hour (bottom) limits, Claude then Codex. Tap for detail"
        className="flex shrink-0 items-center gap-3 rounded-md px-1.5 py-1 text-[12px] hover:bg-hover"
      >
        <Part name="Claude" p={usage.claude} now={now} />
        <Part name="Codex" p={usage.codex} now={now} />
      </button>
      {open && (
        <div className="fixed inset-x-3 top-12 z-30 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-1 sm:w-80 space-y-3 rounded-lg border border-line-strong bg-panel p-3 shadow-lg" role="dialog" aria-label="Usage limits">
          <Detail name="Claude" p={usage.claude} now={now} />
          <Detail name="Codex" p={usage.codex} now={now} />
        </div>
      )}
    </div>
  );
}
