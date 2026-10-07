import type { Database } from "bun:sqlite";
import type { ProviderUsage } from "../shared/types.ts";

type UsageProvider = "claude" | "codex";
export interface UsageCache {
  load(provider: UsageProvider): unknown;
  save(provider: UsageProvider, reading: ProviderUsage): void;
}

/** Uses the daemon's existing database. Only observed usage is stored, never auth or errors. */
export function usageCache(db: Database): UsageCache {
  db.exec("CREATE TABLE IF NOT EXISTS usage_cache (provider TEXT PRIMARY KEY, data TEXT NOT NULL)");
  return {
    load(provider) {
      const row = db.query("SELECT data FROM usage_cache WHERE provider = ?").get(provider) as { data: string } | null;
      return row ? JSON.parse(row.data) : null;
    },
    save(provider, reading) {
      const data = {
        asOf: reading.asOf,
        plan: reading.plan ?? null,
        windows: reading.windows.map(({ label, usedPct, remainingPct, resetsAt }) => ({ label, usedPct, remainingPct, resetsAt })),
      };
      db.query("INSERT INTO usage_cache (provider, data) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET data = excluded.data").run(provider, JSON.stringify(data));
    },
  };
}
