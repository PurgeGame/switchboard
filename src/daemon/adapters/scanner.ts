// Generic process scanner: known AI CLIs that no provider adapter claimed.
// Observe-only; busy is approximated from CPU activity.
import { cmdlineOf, cwdOf, startedAtMs, ttyOf } from "../proc.ts";
import type { Adapter, DiscoverCtx, Discovered } from "./types.ts";

const KNOWN = ["claude", "codex", "gemini", "aider", "opencode", "cursor-agent", "goose", "amp", "qwen", "crush"];

export class ScannerAdapter implements Adapter {
  readonly provider = "other" as const;
  readonly initialTranscriptBytes = 0;

  constructor(private others: Adapter[]) {}

  claimedPids() {
    return new Set<number>();
  }

  parse() {
    return { events: [] };
  }

  async discover(ctx: DiscoverCtx): Promise<Discovered[]> {
    const claimed = new Set<number>();
    for (const a of this.others) for (const p of a.claimedPids()) claimed.add(p);
    const out: Discovered[] = [];
    for (const p of ctx.procs.values()) {
      if (claimed.has(p.pid) || p.state === "Z") continue;
      const cmd = cmdlineOf(p.pid);
      const bin = (cmd[0] ?? "").split("/").pop() ?? "";
      // node/bun wrappers: look at the script name too (e.g. `node /usr/bin/gemini`).
      const script = (cmd[1] ?? "").split("/").pop() ?? "";
      const name = KNOWN.find((k) => bin === k || ((bin === "node" || bin === "bun") && script === k));
      if (!name) continue;
      // Skip wrapper processes whose real binary child is already claimed (e.g. the codex node shim).
      const kids = ctx.kids.get(p.pid) ?? [];
      if (kids.some((k) => claimed.has(k))) continue;
      // Interactive sessions only: helpers without a terminal are noise.
      const tty = ttyOf(p.pid);
      if (!tty) continue;
      out.push({
        id: `proc:${p.pid}:${p.startTime}`,
        provider: "other",
        kind: "process",
        nativeId: `${p.pid}`,
        name,
        cwd: cwdOf(p.pid),
        pid: p.pid,
        pidConfidence: "confirmed",
        tty,
        transcriptPath: null,
        connection: "observe-only",
        limitations: ["Found by process scan only: no transcript or controls. Busy is inferred from CPU use."],
        startedAt: startedAtMs(p),
        meta: { binary: name },
      });
    }
    return out;
  }
}
