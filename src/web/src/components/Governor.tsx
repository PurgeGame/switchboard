import { useState } from "react";
import { restoreSession, setGameMode, setGamePriority, throttleSession, type GamePriority } from "../api.ts";
import { refreshGovernor, useStore } from "../store.ts";

export const RUNTIME_NOTE = "Runtime-only: nothing changes after a reboot. Never kills processes.";
const LEVEL_LABEL = ["", "throttled", "throttled hard"] as const;

export function GamepadIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.6 4.6h6.8a3 3 0 0 1 2.9 2.4l.6 3a1.9 1.9 0 0 1-3.3 1.5L10 10H6l-1.6 1.5a1.9 1.9 0 0 1-3.3-1.5l.6-3a3 3 0 0 1 2.9-2.4ZM5 6.6v2M4 7.6h2M10.6 7.2v.1M11.8 8.2v.1" />
    </svg>
  );
}

export function GameModeBadge() {
  const on = useStore((s) => s.governor?.gameMode ?? s.system?.gameMode ?? false);
  if (!on) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded border border-line-strong px-1.5 text-[11px] text-ink-2" title="Game mode is on: background sessions are limited to keep the game smooth">
      <GamepadIcon size={12} />
      Game mode
    </span>
  );
}

export function ThrottleChip({ sessionId }: { sessionId: string }) {
  const g = useStore((s) => s.governor?.sessions[sessionId]);
  if (!g || g.level === 0) return null;
  return (
    <span title={g.reason ?? undefined} className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line-strong px-1.5 py-px text-[10.5px] text-ink-2">
      {LEVEL_LABEL[g.level]}
      {g.reason && <span className="max-w-[10rem] truncate text-ink-3">· {g.reason}</span>}
    </span>
  );
}

/** Runs a governor action, refreshes state afterwards, and exposes any error. */
export function useGovernorAction() {
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    fn()
      .then(refreshGovernor)
      .catch((err: Error) => setError(err.message));
  };
  return { error, run };
}

export function PrioritySelect({ sessionId, onError }: { sessionId: string; onError?: (m: string) => void }) {
  const priority = useStore((s) => s.governor?.sessions[sessionId]?.priority ?? "normal");
  const { error, run } = useGovernorAction();
  if (error) onError?.(error);
  return (
    <select
      aria-label="Resource priority"
      value={priority}
      onChange={(e) => run(() => setGamePriority(sessionId, e.target.value as GamePriority))}
      className="rounded border border-line bg-bg px-1.5 py-1 text-[12px] text-ink-2"
    >
      <option value="protected">Protected</option>
      <option value="high">High</option>
      <option value="normal">Normal</option>
      <option value="low">Low</option>
    </select>
  );
}

export function ThrottleControls({ sessionId }: { sessionId: string }) {
  const level = useStore((s) => s.governor?.sessions[sessionId]?.level ?? 0);
  const { error, run } = useGovernorAction();
  const btn = "rounded border border-line-strong px-2 py-0.5 text-[11px] hover:bg-hover";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button className={btn} onClick={() => run(() => throttleSession(sessionId, 1))}>
        Throttle
      </button>
      <button className={btn} onClick={() => run(() => throttleSession(sessionId, 2))}>
        Throttle hard
      </button>
      {level > 0 && (
        <button className={btn} onClick={() => run(() => restoreSession(sessionId))}>
          Restore
        </button>
      )}
      {error && <span role="alert" className="text-[11px] text-red">{error}</span>}
    </span>
  );
}

export function GameModeControl() {
  const manual = useStore((s) => s.governor?.gameManual ?? null);
  const active = useStore((s) => s.governor?.gameMode ?? false);
  const { error, run } = useGovernorAction();
  const options: { label: string; value: boolean | null }[] = [
    { label: "Auto", value: null },
    { label: "On", value: true },
    { label: "Off", value: false },
  ];
  return (
    <div className="space-y-1">
      <p className="text-ink">Game mode</p>
      <div role="group" aria-label="Game mode" className="flex gap-1">
        {options.map((o) => (
          <button
            key={o.label}
            aria-pressed={manual === o.value}
            onClick={() => run(() => setGameMode(o.value))}
            className={`rounded px-2.5 py-1 text-[12px] ${manual === o.value ? "bg-bg text-ink ring-1 ring-line-strong" : "text-ink-3 hover:text-ink-2"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-ink-3">
        {manual === null ? `Auto detects a running game${active ? " (a game is running now)" : ""}.` : manual ? "Forced on." : "Forced off."} {RUNTIME_NOTE}
      </p>
      {error && <p className="text-[11px] text-red">{error}</p>}
    </div>
  );
}
