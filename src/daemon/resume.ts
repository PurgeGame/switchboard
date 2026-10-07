import { statSync } from "node:fs";
import type { Session } from "../shared/types.ts";
import { shq, type BridgeHub } from "./bridge.ts";
import { SendError } from "./messaging.ts";
import { readStat } from "./proc.ts";
import type { Registry } from "./registry.ts";

export function resumeCommand(s: Session): string {
  if (s.provider !== "claude" && s.provider !== "codex") throw new SendError("this provider cannot be resumed", 409);
  if (!s.nativeId || s.nativeId.startsWith("-")) throw new SendError("missing conversation ID", 409);
  return s.provider === "claude" ? `claude --resume ${shq(s.nativeId)}` : `codex resume ${shq(s.nativeId)}`;
}

/** Launch once, and report success only when discovery sees that same conversation again. */
export class SessionResumer {
  waitMs = 20_000;
  private pending = new Map<string, Promise<{ ok: boolean; error?: string }>>();
  constructor(private registry: Registry, private bridge: Pick<BridgeHub, "launch">) {}

  resume(id: string) {
    const pending = this.pending.get(id);
    if (pending) return pending;
    const run = this.resumeOnce(id).finally(() => this.pending.delete(id));
    this.pending.set(id, run);
    return run;
  }

  private async resumeOnce(id: string): Promise<{ ok: boolean; error?: string }> {
    const s = this.registry.sessions.get(id);
    if (!s) throw new SendError("unknown session", 404);
    const command = resumeCommand(s);
    if (s.execution !== "ended") return { ok: true };
    if (!s.cwd || !s.cwd.startsWith("/")) throw new SendError("the original folder is unknown", 409);
    try {
      if (!statSync(s.cwd).isDirectory()) throw new Error();
    } catch { throw new SendError("the original folder no longer exists", 409); }
    const cwd = s.cwd;
    // Persist an in-flight attempt: retries (even after a daemon restart or a bridge timeout)
    // must not open a second process for the same conversation.
    if (!s.meta.resumePending) {
      s.meta.resumePending = { at: Date.now() };
      this.registry.markDirty(id);
      this.registry.flush();
      const r = await this.bridge.launch(cwd, s.name ?? `${s.provider}-${s.nativeId.slice(0, 8)}`, command);
      if (!r.ok) {
        // No window means nothing could have launched. A timeout has an unknown outcome.
        if (!r.error?.includes("timeout")) {
          delete s.meta.resumePending;
          this.registry.markDirty(id);
          this.registry.flush();
        }
        return { ok: false, error: r.error ?? "Could not open a terminal" };
      }
    }
    const deadline = Date.now() + this.waitMs;
    while (Date.now() < deadline) {
      await this.registry.tick();
      const live = this.registry.sessions.get(id);
      const process = live?.pid ? readStat(live.pid) : null;
      if (live && live.execution !== "ended" && live.cwd === cwd && live.pidConfidence === "confirmed" && process && process.state !== "Z") return { ok: true };
      await Bun.sleep(200);
    }
    return { ok: false, error: "Resume was launched, but the conversation has not appeared yet. Check its terminal for a startup prompt; retry checks this launch without opening another." };
  }
}
