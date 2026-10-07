import type { ProviderUsage } from "./types.ts";

/** Derive freshness without changing any observed percentage or reset timestamp. */
export function usageStatus(p: ProviderUsage, now: number) {
  const resetElapsed = p.windows.some((w) => w.resetsAt !== null && w.resetsAt <= now);
  const stale = !p.available || !!p.stale || !!p.error || resetElapsed;
  return {
    stale,
    ageMs: p.asOf == null ? null : Math.max(0, now - p.asOf),
    staleReason: p.error ? "refresh failed" : p.staleReason ?? (resetElapsed ? "recorded reset time passed; awaiting a new reading" : !p.available ? "no successful reading" : null),
  };
}
