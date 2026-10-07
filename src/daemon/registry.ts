// Session registry: periodic discovery, transcript tailers, state, resources, persistence.
import { contextWindowFor } from "../shared/models.ts";
import { spawnSync } from "node:child_process";
import type { SbEvent, ServerPush, Session, StallCheck } from "../shared/types.ts";
import type { Adapter, Discovered } from "./adapters/types.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { childrenIndex, cmdlineOf, readStat, CpuSampler, descendants, rssMB, runningCommand, runsSwitchboardMcp, snapshot, type ProcInfo } from "./proc.ts";
import { applyEvent, blankSession, canSuspectStall, checkStalled, isRunning, mergeLiveStatus, stallActivityAt, stepSummary } from "./state.ts";
import { JsonlTail, readHead } from "./tail.ts";
import { ClaudeSubagents } from "./adapters/claude-subagents.ts";
import type { AttentionEngine } from "./attention.ts";
import type { Execution } from "../shared/types.ts";

const MISSING_TICKS_TO_END = 2;

interface Watch {
  tail: JsonlTail;
  path: string;
}

export class Registry {
  readonly sessions = new Map<string, Session>();
  private watches = new Map<string, Watch>();
  private missing = new Map<string, number>();
  private extraPids = new Map<string, { pids: number[]; inferred: boolean }>();
  private dirty = new Set<string>();
  private listeners: ((m: ServerPush) => void)[] = [];
  private cpu = new CpuSampler();
  private gitCache = new Map<string, { at: number; top: string | null; branch: string | null }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private subagents = new ClaudeSubagents();
  readonly adapters: Adapter[];
  attention: AttentionEngine | null = null;
  /** Computes derived fields (send methods, controls) before a session is pushed. */
  decorate: ((s: Session) => void) | null = null;
  readonly eventHooks: ((e: SbEvent) => void)[] = [];
  /** Called after a session's execution state changes (e.g. it ended), with the previous state. */
  readonly execHooks: ((s: Session, prev: Execution) => void)[] = [];

  /** Internal events, never transcript entries or attention items. */
  readonly stallHooks: ((s: Session, check: StallCheck) => void)[] = [];

  constructor(
    adapters: Adapter[],
    private store: Store,
    private cfg: Config,
  ) {
    this.adapters = adapters;
    // Restore persisted sessions; reconciliation on the first tick decides what is still live.
    // Merge over current defaults so sessions saved by an older version get new fields.
    for (const s of store.loadSessions()) {
      if (s.execution === "stalled") s.execution = "working"; // migrate the old inferred status
      this.sessions.set(s.id, { ...blankSession(s.id, s.provider, s.kind, s.nativeId), ...s });
    }
  }

  onPush(fn: (m: ServerPush) => void) {
    this.listeners.push(fn);
  }
  private push(m: ServerPush) {
    for (const l of this.listeners) l(m);
  }

  start(intervalMs = 2000) {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const w of this.watches.values()) w.tail.stop();
    this.flush();
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const procs = snapshot();
      const kids = childrenIndex(procs);
      const ctx = { procs, kids, now };
      // Provider adapters first: the scanner needs their claimed PIDs.
      const providers = this.adapters.filter((a) => a.provider !== "other");
      const scanners = this.adapters.filter((a) => a.provider === "other");
      const found: Discovered[] = [];
      for (const batch of [providers, scanners]) {
        const results = await Promise.all(
          batch.map((a) =>
            a.discover(ctx).catch((e) => {
              console.error(`[registry] ${a.provider} discover failed:`, e);
              return [] as Discovered[];
            }),
          ),
        );
        for (const r of results) found.push(...r);
      }
      const seen = new Set<string>();
      for (const d of found) {
        seen.add(d.id);
        this.missing.delete(d.id);
        this.upsertDiscovered(d, now);
      }
      // Sessions that disappeared.
      for (const s of this.sessions.values()) {
        if (seen.has(s.id) || s.execution === "ended") continue;
        const n = (this.missing.get(s.id) ?? 0) + 1;
        this.missing.set(s.id, n);
        if (n >= MISSING_TICKS_TO_END) this.endSession(s, now);
      }
      // Drop long-ended sessions.
      for (const s of [...this.sessions.values()])
        if (s.execution === "ended" && s.endedAt && now - s.endedAt > this.cfg.endedRetentionMs) {
          if (s.transcriptPath) this.subagents.forget(s.transcriptPath);
          this.sessions.delete(s.id);
          this.store.deleteSession(s.id);
          this.push({ type: "session_removed", id: s.id });
        }
      this.sampleResources(procs, kids, now);
      this.sampleSubagents(now);
      for (const s of this.sessions.values()) this.checkStall(s, now);
      this.flush();
    } finally {
      this.ticking = false;
    }
  }

  private upsertDiscovered(d: Discovered, now: number) {
    let s = this.sessions.get(d.id);
    const isNew = !s;
    if (!s) {
      s = blankSession(d.id, d.provider, d.kind, d.nativeId);
      this.sessions.set(d.id, s);
    }
    // A stale discovery that started before a confirmed close must not revive it. Only a
    // newly identified process can resume an explicitly ended conversation.
    if (s.meta.closedProcess) {
      const old = s.meta.closedProcess as { pid: number; startTime: number };
      const live = d.pid ? readStat(d.pid) : null;
      if (d.pidConfidence !== "confirmed" || !live || live.state === "Z" ||
          old.pid === d.pid && old.startTime === live.startTime) return;
    }
    delete s.meta.closedProcess;
    delete s.meta.resumePending;
    const before = JSON.stringify(s);
    if (s.execution === "ended") {
      // Came back (e.g. daemon restart raced a scan): revive.
      s.endedAt = null;
      s.execution = "unknown";
    }
    s.kind = d.kind;
    s.name = d.name ?? s.name;
    s.cwd = d.cwd ?? s.cwd;
    s.pid = d.pid;
    s.meta.processStartTime = d.pid ? readStat(d.pid)?.startTime : undefined;
    s.pidConfidence = d.pidConfidence;
    s.tty = d.tty;
    s.connection = d.connection;
    s.limitations = d.limitations;
    s.startedAt = d.startedAt ?? s.startedAt;
    s.model = d.model ?? s.model;
    s.meta = { ...s.meta, ...(d.meta ?? {}) };
    if (d.transcriptPath) s.transcriptPath = d.transcriptPath;
    if (s.cwd) {
      const g = this.git(s.cwd, now);
      s.project = g.top;
      if (g.branch) s.branch = g.branch; // live git wins over transcript records
    }
    this.extraPids.set(d.id, { pids: d.extraPids ?? [], inferred: !!d.extraPidsInferred });
    // Replay transcript history first, so a running turn keeps its real start time;
    // then let the provider's live status (fresher) correct the result.
    if (s.transcriptPath) this.ensureWatch(s);
    const prevExec = s.execution;
    // A hook is fresher than a registry status written before it: ignore the stale status.
    const hookAt = typeof s.meta.hookAt === "number" ? s.meta.hookAt : 0;
    const stale = d.liveStatus?.since !== undefined && d.liveStatus.since < hookAt;
    if (!stale) {
      mergeLiveStatus(s, d.liveStatus, now);
      if (d.liveStatus?.detail) s.meta.statusDetail = d.liveStatus.detail;
    }
    this.execChanged(s, prevExec, now);
    this.decorate?.(s);
    if (isNew || JSON.stringify(s) !== before) this.dirty.add(s.id);
  }

  /** Called only once the end path has verified the original process is gone. */
  confirmEnded(sessionId: string, identity = { pid: this.sessions.get(sessionId)?.pid ?? null, startTime: 0 }) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.endSession(s, Date.now());
    // End may have resolved a different process than discovery's inferred mapping. Keep
    // the verified identity with the closed session rather than persisting that old guess.
    if (identity.pid && identity.startTime) {
      s.pid = identity.pid;
      s.pidConfidence = "confirmed";
      s.meta.processStartTime = identity.startTime;
    }
    s.meta.closedProcess = identity;
    this.flush();
  }

  private endSession(s: Session, now: number) {
    const w = this.watches.get(s.id);
    if (w) {
      w.tail.poll(); // final transcript lines must not overwrite the ended state below
      w.tail.stop();
      this.watches.delete(s.id);
    }
    const prevExec = s.execution;
    s.execution = "ended";
    s.executionConfidence = "confirmed";
    s.endedAt ??= now;
    s.turnStartedAt = null;
    s.connection = "disconnected";
    s.resources = null;
    s.sendMethods = [];
    s.controls = { interrupt: false, steer: false, queue: false, approve: false };
    this.execChanged(s, prevExec, now);
    this.decorate?.(s);
    this.dirty.add(s.id);
  }

  private execChanged(s: Session, prev: Execution, now: number) {
    this.clearStaleStall(s, now);
    if (s.execution === prev) return;
    this.attention?.onExecutionChange(s, prev, now);
    for (const h of this.execHooks)
      try {
        h(s, prev);
      } catch (err) {
        console.error(`[registry] execution hook failed for ${s.id}:`, err);
      }
  }

  private stallEligible(s: Session) {
    return canSuspectStall(s) && !this.attention?.open(s.id).some((i) => i.kind === "question" || i.kind === "approval");
  }

  private clearStaleStall(s: Session, now: number) {
    if (!s.stallCheck || (this.stallEligible(s) && s.stallCheck.lastActivityAt === stallActivityAt(s))) return;
    delete s.stallCheck;
    this.attention?.resolveStall(s.id, "activity resumed or the session is waiting or running work", now);
    this.dirty.add(s.id);
  }

  /** One investigation per silent episode; a working verdict suppresses repeats until progress. */
  checkStall(s: Session, now = Date.now()) {
    this.clearStaleStall(s, now);
    if (!s.stallCheck && this.stallEligible(s) && checkStalled(s, now, this.cfg.stalledMs)) {
      const last = this.store.events(s.id, { limit: 80 }).findLast((e) => ["tool_call", "assistant_msg", "turn_started"].includes(e.type));
      s.stallCheck = {
        id: `${now}:${stallActivityAt(s)}`, suspectedAt: now, lastActivityAt: stallActivityAt(s)!,
        silentForMs: now - stallActivityAt(s)!, lastStep: String(s.meta.lastStep ?? (last ? stepSummary(last) : s.meta.lastContentType ?? "unknown")), status: "suspected",
      };
      this.dirty.add(s.id);
    }
    // The coordinator dedupes by id. Offering pending checks also handles off -> on and restart.
    if (s.stallCheck?.status === "suspected") for (const h of this.stallHooks) {
      try { h(s, s.stallCheck); }
      catch (err) { console.error(`[registry] stall hook failed for ${s.id}:`, err); }
    }
  }

  reportStall(sessionId: string, checkId: string, status: "working" | "stuck", reason: string, suggestedAction?: string) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("unknown session");
    this.clearStaleStall(s, Date.now());
    const check = s.stallCheck;
    if (!check || check.id !== checkId) {
      if (status === "working") return { resolved: true, stale: true };
      throw new Error("stall check is stale; get_session again before assessing it");
    }
    if (status === "stuck" && check.status === "working") throw new Error("stall check already resolved as working");
    if (status === "stuck" && !suggestedAction?.trim()) throw new Error("a confirmed problem needs a suggestedAction");
    if (status === "stuck" && !this.attention) throw new Error("attention is unavailable");
    Object.assign(check, { status, reason, suggestedAction: status === "stuck" ? suggestedAction : undefined });
    if (status === "stuck") this.attention!.confirmStall(s, check);
    else this.attention?.resolveStall(s.id, reason);
    this.dirty.add(s.id);
    this.flush();
    return check;
  }

  /** Apply an out-of-band change (hooks, attention decisions) and notify. */
  update(sessionId: string, fn: (s: Session) => void) {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const prev = s.execution;
    fn(s);
    if (s.meta.closedProcess) { s.execution = "ended"; s.turnStartedAt = null; }
    this.execChanged(s, prev, Date.now());
    this.dirty.add(s.id);
    return true;
  }

  private ensureWatch(s: Session) {
    const existing = this.watches.get(s.id);
    if (existing && existing.path === s.transcriptPath) return;
    existing?.tail.stop();
    const adapter = this.adapters.find((a) => a.provider === s.provider);
    if (!adapter || !s.transcriptPath) return;
    const path = s.transcriptPath;
    // The history cap replays only the transcript's tail, so take the real first prompt from its head.
    if (!s.firstPrompt) {
      for (const [i, rec] of readHead(path, 400).entries()) {
        const first = adapter.parse(rec, s.id, `head${i}`).events.find((e) => e.type === "user_msg" && !e.data.queued);
        if (first && typeof first.data.text === "string") {
          s.firstPrompt = first.data.text.trim().slice(0, 1000);
          s.goal ??= s.firstPrompt.split("\n").find((l) => l.trim())?.slice(0, 200) ?? null;
          s.goalInferred = true;
          break;
        }
      }
    }
    const tail = new JsonlTail(
      path,
      (obj, meta) => {
        const r = adapter.parse(obj, s.id, `${meta.offset}`);
        this.ingest(s.id, r.events, r.patch);
      },
      {
        initialMaxBytes: adapter.initialTranscriptBytes,
        getOffset: (p) => this.store.getOffset(p),
        setOffset: (p, ino, off) => this.store.setOffset(p, ino, off),
      },
    );
    this.watches.set(s.id, { tail, path });
    tail.start();
  }

  /** Apply transcript events + state hints. Exposed for hooks and tests. */
  ingest(sessionId: string, events: SbEvent[], patch?: Record<string, unknown>) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.meta.closedProcess) return; // late hooks from the exited process cannot revive it
    let changed = false;
    for (const e of events) {
      const stored = this.store.insertEvent(e);
      if (!stored) continue; // duplicate (restart, re-read)
      const prevTurn = s.turnStartedAt;
      const prevExec = s.execution;
      if (applyEvent(s, stored)) changed = true;
      s.lastEventId = stored.id!;
      changed = true;
      this.push({ type: "event", event: stored });
      this.attention?.onEvent(s, stored, prevTurn);
      this.execChanged(s, prevExec, stored.ts);
      // One hook's exception must not skip the others (the event is already deduped, so it
      // would never be retried for them).
      for (const h of this.eventHooks)
        try {
          h(stored);
        } catch (err) {
          console.error(`[registry] event hook failed for ${stored.type} in ${sessionId}:`, err);
        }
    }
    if (patch) {
      if (typeof patch.name === "string" && patch.name !== s.name && !s.name) {
        s.name = patch.name;
        changed = true;
      }
      if (typeof patch.model === "string" && patch.model !== s.model) {
        s.model = patch.model;
        changed = true;
      }
      for (const k of ["effort", "contextTokens", "contextWindow"] as const) {
        const v = (patch as Record<string, unknown>)[k];
        if (v !== undefined && v !== s[k]) {
          (s as any)[k] = v;
          changed = true;
        }
      }
      if (typeof patch.model === "string" && !s.contextWindow) s.contextWindow = contextWindowFor(patch.model);
      if (typeof patch.branch === "string" && patch.branch !== "HEAD" && !s.branch) {
        s.branch = patch.branch;
        changed = true;
      }
      if (patch.softTurnEnd && isRunning(s.execution)) {
        s.turnStartedAt = null;
        s.execution = "idle";
        s.executionConfidence = "inferred";
        changed = true;
      }
      for (const k of ["tokens", "rateLimitPct", "originator"] as const)
        if (patch[k] !== undefined && s.meta[k] !== patch[k]) {
          s.meta[k] = patch[k];
          changed = true;
        }
    }
    this.clearStaleStall(s, Date.now());
    if (changed) this.dirty.add(sessionId);
  }

  /** A process's argv never changes: read it once per (pid, start time). */
  private argvCache = new Map<string, string[]>();
  private argvOf(pid: number, procs: Map<number, ProcInfo>): string[] {
    const key = `${pid}:${procs.get(pid)?.startTime ?? 0}`;
    let a = this.argvCache.get(key);
    if (!a) this.argvCache.set(key, (a = cmdlineOf(pid)));
    return a;
  }

  private sampleResources(procs: Map<number, ProcInfo>, kids: Map<number, number[]>, now: number) {
    for (const key of this.argvCache.keys()) if (!procs.has(Number(key.split(":")[0]))) this.argvCache.delete(key);
    const cpuOf = new Map<number, number>();
    for (const p of procs.values()) cpuOf.set(p.pid, this.cpu.pct(p, now));
    this.cpu.prune(new Set(procs.keys()));
    for (const s of this.sessions.values()) {
      if (s.execution === "ended") continue;
      const extra = this.extraPids.get(s.id);
      const roots = [...(s.pid ? [s.pid] : []), ...(extra?.pids ?? [])];
      if (!roots.length) {
        if (s.resources) {
          s.resources = null;
          this.dirty.add(s.id);
        }
        continue;
      }
      const all = new Set<number>();
      for (const r of roots) for (const p of descendants(r, kids)) all.add(p);
      let cpu = 0, rss = 0, n = 0, liveChildren = 0;
      let top: { pid: number; name: string; cpuPct: number; rssMB: number } | undefined;
      for (const pid of all) {
        const p = procs.get(pid);
        if (!p) continue;
        n++;
        if (pid !== s.pid && p.state !== "Z" && p.state !== "X") liveChildren++;
        const c = cpuOf.get(pid) ?? 0;
        const m = rssMB(p);
        cpu += c;
        rss += m;
        if (pid !== s.pid && (!top || c > top.cpuPct || (c === top.cpuPct && m > top.rssMB))) top = { pid, name: p.comm, cpuPct: c, rssMB: m };
      }
      const running = s.pid ? runningCommand(s.pid, procs, kids, (pid) => this.argvOf(pid, procs), now) : undefined;
      // An agent connected to Switchboard's tools (`sb mcp`) is a coordinator: the UI labels it and
      // the coordinator engine doesn't feed it its own events.
      const client = !!s.pid && runsSwitchboardMcp(s.pid, kids, (pid) => this.argvOf(pid, procs));
      if (!!s.meta.coordinatorClient !== client) {
        if (client) s.meta.coordinatorClient = true;
        else delete s.meta.coordinatorClient;
        this.dirty.add(s.id);
      }
      const next = { cpuPct: Math.round(cpu * 10) / 10, rssMB: Math.round(rss), procs: n, liveChildren, top: top && (top.cpuPct > 1 || top.rssMB > 200) ? { ...top, cpuPct: Math.round(top.cpuPct), rssMB: Math.round(top.rssMB) } : undefined, inferred: extra?.inferred || undefined, running };
      // Avoid churn: only push when something moved noticeably.
      const prev = s.resources;
      if (!prev || Math.abs(prev.cpuPct - next.cpuPct) >= 2 || Math.abs(prev.rssMB - next.rssMB) >= 20 || prev.procs !== next.procs || prev.liveChildren !== next.liveChildren || prev.top?.pid !== next.top?.pid || prev.running?.since !== running?.since || prev.running?.kind !== running?.kind) {
        s.resources = next;
        this.dirty.add(s.id);
      }
    }
  }

  /** Claude sessions' subagents (from their transcripts on disk). Pushed only when one changes. */
  private sampleSubagents(now: number) {
    for (const s of this.sessions.values()) {
      if (s.provider !== "claude" || !s.transcriptPath) continue;
      const live = s.execution !== "ended";
      // An ended session's agents are settled once (any still running stopped with it), then left alone.
      if (!live && !s.subagents?.some((a) => a.status === "running")) continue;
      let next: NonNullable<Session["subagents"]>;
      try {
        next = this.subagents.read(s.transcriptPath, live, s.startedAt, now);
      } catch (e) {
        console.error(`[subagents] ${s.id}:`, e);
        continue;
      }
      // lastActivityAt moves all the time; what's shown (status, step, timing) decides a push.
      const key = (list: Session["subagents"]) => JSON.stringify((list ?? []).map(({ lastActivityAt: _, ...a }) => a));
      if (key(next) !== key(s.subagents)) {
        s.subagents = next.length ? next : undefined;
        this.dirty.add(s.id);
      }
    }
  }

  private git(cwd: string, now: number) {
    const c = this.gitCache.get(cwd);
    if (c && now - c.at < 30_000) return c;
    const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 2000 });
    const [top, branch] = r.status === 0 ? r.stdout.trim().split("\n") : [null, null];
    const v = { at: now, top: top ?? null, branch: branch && branch !== "HEAD" ? branch : null };
    this.gitCache.set(cwd, v);
    return v;
  }

  flush() {
    for (const id of this.dirty) {
      const s = this.sessions.get(id);
      if (!s) continue;
      this.decorate?.(s);
      this.store.upsertSession(s);
      this.push({ type: "session", session: s });
    }
    this.dirty.clear();
  }

  markDirty(id: string) {
    this.dirty.add(id);
  }
}
