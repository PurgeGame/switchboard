#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
// switchboardd: the Switchboard daemon.
import { ClaudeAdapter } from "./adapters/claude.ts";
import { CodexAdapter } from "./adapters/codex.ts";
import { ScannerAdapter } from "./adapters/scanner.ts";
import { loadConfig, loadToken, paths, rotateCoordinatorToken } from "./config.ts";
import { PermissionBroker } from "./permissions.ts";
import { retrySafeDenial } from "./permission-retry.ts";
import { SafePermissionPolicy, deniedPermissionInfo, codexApprovalInfo, inOwnWorktree } from "./permission-policy.ts";
import { deniedCallText, type DeniedToolCall } from "./adapters/tool-denial.ts";
import { Store } from "./db.ts";
import { startHttp } from "./http.ts";
import { Registry } from "./registry.ts";
import { SystemMonitor } from "./system.ts";
import type { SystemStats } from "../shared/types.ts";
import { AttentionEngine } from "./attention.ts";
import { AmbiguityResolver, haikuIsQuestion } from "./classify.ts";
import { NeedsYouPush } from "./push.ts";
import { Notifier } from "./notify.ts";
import { CodexLive } from "./adapters/codex-live.ts";
import { Messenger } from "./messaging.ts";
import { Uploads } from "./uploads.ts";
import { BridgeHub } from "./bridge.ts";
import { CompositeTerminal, TmuxSender } from "./tmux.ts";
import { AUTO_TEMPLATE, AutoContinuer } from "./autocontinue.ts";
import { Perspectives } from "./perspectives.ts";
import { Coordination } from "./coordination.ts";
import { UsageMonitor, claudeCredentialsSource } from "./usage.ts";
import { usageCache } from "./usage-cache.ts";
import { Governor, defaultGovernorConfig } from "./governor.ts";
import { CoordinatorAgent } from "./coordinator/agent.ts";
import { loadCoordinatorConfig } from "./coordinator/config.ts";
import { inputBlocker, processBlocker, worktreeState } from "./coordinator/auto-end.ts";
import { pinCodexWorkers } from "./codex-pins.ts";
import { CoordinatorRuntime } from "./coordinator/runtime.ts";
import { TOOL_NAMES } from "./coordinator/tools.ts";
import { createWorktree } from "./coordinator/worktree.ts";

const cfg = loadConfig();
let coordinator: CoordinatorAgent | null = null; // assigned below; callbacks fire only after startup
let bgPerspectives: Perspectives | null = null; // assigned below, for the same reason
const token = loadToken();
const coordinatorToken = rotateCoordinatorToken();
const store = new Store(paths.dataDir);

const claude = new ClaudeAdapter();
const codex = new CodexAdapter();
const registry = new Registry([claude, codex, new ScannerAdapter([claude, codex])], store, cfg);

const notifier = new Notifier({ desktop: cfg.notifyDesktop, finished: cfg.notifyFinished, ignore: cfg.notifyIgnore }, (id) => `http://127.0.0.1:${cfg.port}/#/s/${encodeURIComponent(id)}`);
let broadcast: (m: import("../shared/types.ts").ServerPush) => void = () => {};
const attention = new AttentionEngine(
  store,
  cfg,
  {
    pushItem: (item) => {
      broadcast({ type: "attention", item });
      coordinator?.onAttention(item);
    },
    notify: (item, s) => notifier.notify(item, s),
    setExecution: (s, x, c) =>
      registry.update(s.id, (t) => {
        t.execution = x;
        t.executionConfidence = c;
      }),
    questionRaised: (item) =>
      void auto.onQuestion(item).then((r) => {
        if (r !== "pending") notifyItem(item.id, item.sessionId);
      }).catch(() => notifyItem(item.id, item.sessionId)),
    stoppedShort: (s, text, meta) => void auto.onStoppedShort(s.id, text, meta),
    classifyDenial: (s, call) => permissionPolicy.decide(deniedPermissionInfo(s.id, s.provider === "codex" ? "codex" : "claude", call)),
    retryDenied: (s, item) => {
      const call = item.meta.deniedToolCall as DeniedToolCall;
      coordinator?.log("permission_auto_approval", "ok", deniedCallText(call), { sessionId: s.id, reason: String(item.meta.autoRule) });
      void retrySafeDenial(store, attention, messenger, s, item);
    },
  },
  new AmbiguityResolver(cfg.modelClassifier ? haikuIsQuestion : null),
);
registry.attention = attention;

const uploads = new Uploads(paths.dataDir);
uploads.prune(30 * 24 * 3600_000);
const codexLive = new CodexLive(codex.daemon);
const messenger = new Messenger(store, registry, codexLive, uploads, (message) => {
  broadcast({ type: "outbox", message });
  attention.onDelivery(message);
});
import { defaultHookPaths as _hp, hooksInstalled as _hi } from "../cli/hooks.ts";
const hooksActive = (() => {
  try {
    const hp = _hp();
    return Object.values(_hi(JSON.parse(require("node:fs").readFileSync(hp.settings, "utf8")), hp.script)).every(Boolean);
  } catch {
    return false;
  }
})();
const bridge = new BridgeHub(paths.dataDir);
bridge.listen(`${paths.dataDir}/bridge.sock`);
messenger.terminal = new CompositeTerminal([bridge, new TmuxSender()]);
registry.decorate = (s) => {
  s.sendMethods = messenger.methods(s);
  s.controls = messenger.controls(s);
  const hit = bridge.terminalFor(s);
  s.meta.terminal = hit ? { name: hit.t.name, windowFolders: hit.w.folders } : null;
  // Started from Switchboard: shown in the list even before anything has been said in it.
  if (hit && bridge.isLaunched(hit.t.id)) s.meta.launchedHere = true;
  if (s.cwd?.endsWith("/switchboard/coordinator")) s.meta.coordinatorAgent = true; // the coordinator's own process
  // Short-lived agents the coordinator started (delegated tasks, perspective members): the list files them away.
  const background = coordinator?.isLaunched(s.id) ? "worker" : bgPerspectives?.isBackground(s.id) ? "perspective" : null;
  if (background) s.meta.background = background;
  else delete s.meta.background;
  s.enforcement = s.cwd?.includes("/.switchboard-worktrees/") ? "isolated" : s.provider === "claude" && s.kind === "tui" && hooksActive ? "cooperative" : "observed";
  // Connection reflects what Switchboard can actually do right now.
  s.connection = s.execution === "ended" ? "disconnected" : s.sendMethods.length ? "controllable" : "observe-only";
  if (s.provider === "claude" && s.kind === "tui")
    s.limitations = s.sendMethods.includes("terminal")
      ? [hit ? "Messages are typed into its VS Code terminal, checked first that Claude is the terminal's foreground process." : "Messages are pasted into its tmux pane, checked first that Claude is the pane's foreground process."]
      : ["No VS Code terminal or tmux pane found for this session: only peer messages, which Claude is told are not from you."];
};
registry.eventHooks.push((e) => messenger.onEvent(e));
setInterval(() => {
  try {
    messenger.sweep();
  } catch (e) {
    console.error("[outbox]", e);
  }
}, 10_000);
const notifyItem = (itemId: number, sessionId: string) => {
  const s = registry.sessions.get(sessionId);
  if (s) attention.notifyDeferred(itemId, s);
};
const auto = new AutoContinuer({
  cfg: cfg.autoContinue,
  session: (id) => registry.sessions.get(id),
  userTexts: (id) =>
    store
      .events(id, { limit: 600 })
      .filter((e) => e.type === "user_msg" && typeof e.data.text === "string" && e.data.text.trim() !== AUTO_TEMPLATE)
      .map((e) => String(e.data.text))
      .slice(-15),
  openItem: (id) => store.getAttention(id),
  send: async (sessionId, text) => {
    try {
      const m = await messenger.send({ sessionId, text, author: "auto" });
      return m.state === "failed" ? { ok: false, error: m.error ?? "failed" } : { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  resolveItem: (id, note, meta) => attention.resolveAuto(id, note, meta),
  annotateItem: (id, meta) => attention.annotate(id, meta),
  push: (st) => {
    broadcast(st);
    // A scheduled reply that didn't happen: now the human needs to know.
    if (st.itemId !== null && (st.state === "cancelled" || (st.state === "declined" && st.reason?.startsWith("send failed")))) notifyItem(st.itemId, st.sessionId);
  },
  disabled: (s) => !!s.meta.autoContinueOff || cfg.autoContinue.offProjects.some((p) => s.cwd === p || !!s.cwd?.startsWith(p + "/")),
});
registry.eventHooks.push((e) => auto.onEvent(e));

const perspectives = new Perspectives(
  store,
  registry,
  messenger,
  bridge,
  (group) => broadcast({ type: "group", group }),
  (g, title, text) => attention.raiseGroup(g.id, `Perspectives · ${g.prompt.replace(/\s+/g, " ").slice(0, 60)}`, title, text, `${title}:${g.round}:${Date.now()}`, g.cwd),
);
registry.eventHooks.push((e) => perspectives.onEvent(e));
bgPerspectives = perspectives;

const coordination = new Coordination(store);
messenger.onEnded = (id) => {
  return coordinator ? coordinator.onSessionClosed(id) : coordination.releaseSessionClaims(id);
};
coordination.groupOf = (sid) => perspectives.list().find((g) => g.status !== "suggested" && g.members.some((m) => m.sessionId === sid))?.id ?? null;
let coordTimer: ReturnType<typeof setTimeout> | null = null;
coordination.onChange = () => {
  coordTimer ??= setTimeout(() => {
    coordTimer = null;
    broadcast({ type: "coordination", ...coordination.snapshot() });
  }, 250);
  coordinator?.onCoordinationChange();
};
coordination.onConflict = (c) => {
  // Perspective members are expected to share a task and a folder: only same-file writes count.
  if (c.sameGroup && c.kind !== "same_file") return;
  const s = registry.sessions.get(c.sessions.at(-1)!);
  if (!s) return;
  attention.raiseConflict(s, c.id, c.detail, { conflict: c });
  coordinator?.onConflict(c);
};
registry.eventHooks.push((e) => coordination.onEvent(e, registry.sessions));
const governor = new Governor(
  { ...defaultGovernorConfig, ...(cfg as any).governor },
  () => registry.list(),
  () => (codex.daemonPid ? [codex.daemonPid] : []),
);
governor.onChange = () => broadcast({ type: "governor", ...governor.snapshot() } as any);
(globalThis as any).sbGovernor = governor; // the coordinator's MCP tools look it up

const usage = new UsageMonitor({ claudeSource: cfg.usage?.claudeOAuth === true ? claudeCredentialsSource() : null, cache: usageCache(store.db) });
usage.onChange = (u) => broadcast({ type: "usage", usage: u });

// ---- coordinator agent (Phase 6): starts in manual (off) until the user switches it on.
// coordinator.agent (D34): "builtin" = the engine plus the daemon's own Claude process; "external" =
// the engine only, driven by the user's own agent through `sb mcp`; "none" = no coordinator at all.
const coordCfg = loadCoordinatorConfig();
const coordKind = coordCfg.agent;
const coord = coordKind === "none" ? null : new CoordinatorAgent({
  db: store.db,
  coordination,
  cfg: coordCfg,
  sessions: () => registry.sessions,
  events: (id, limit) => store.events(id, { limit }),
  send: async (sessionId, text, ctx) => {
    try {
      // A human-approved proposal binds the idempotency key, so it can never be delivered twice.
      const clientId = ctx.proposalId !== null ? `proposal:${ctx.proposalId}` : undefined;
      const m = await messenger.send({ sessionId, text, author: "coordinator", clientId, context: ctx });
      return m.state === "failed" ? { ok: false, error: m.error ?? "failed" } : { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  askSeveral: (prompt, cwd, members) =>
    perspectives.create(prompt, [], cwd, members.map((m) => ({ kind: "new" as const, provider: m.provider, model: m.model })), { autoSynthesize: true, background: true }),
  group: (id) => perspectives.get(id),
  groups: () => perspectives.list(),
  // Context maintenance: a native compact for Codex on its daemon; for Claude, the exact command
  // typed into its terminal (slash commands only work as typed input). Rechecked at delivery.
  maintain: async (sessionId, command, focus, ctx) => {
    const s = registry.sessions.get(sessionId);
    if (!s) return { ok: false, error: "unknown session" };
    try {
      if (s.provider === "codex") {
        if (command !== "compact" || !s.meta.onDaemon) return { ok: false, error: "Codex can only be compacted, over its daemon" };
        coord!.authorizeDelivery(sessionId, "/compact", ctx);
        messenger.acquire(sessionId, "codex-daemon");
        const r = await codexLive.compact(s.nativeId);
        return r.outcome === "failed" ? { ok: false, error: r.error ?? "failed" } : { ok: true };
      }
      const text = command === "clear" ? "/clear" : `/compact${focus ? ` ${focus}` : ""}`;
      const m = await messenger.send({ sessionId, text, author: "coordinator", method: "terminal", context: ctx });
      return m.state === "failed" ? { ok: false, error: m.error ?? "failed" } : { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  // The user's own chat message, routed once (clientId route:<chat id>) to the session the coordinator chose.
  route: async (sessionId, text, images, chatId) => {
    try {
      const m = await messenger.send({ sessionId, text, images, author: "human", clientId: `route:${chatId}` });
      return m.state === "failed" ? { ok: false, error: m.error ?? "failed" } : { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  launch: async (spec) => {
    const id = await perspectives.launchAndSend({ id: "coord", cwd: spec.cwd, prompt: spec.prompt, images: [] }, { kind: "new", provider: spec.provider, model: spec.model }, { name: spec.name, author: "coordinator", effort: spec.effort, context: { taskId: spec.taskId, proposalId: null, humanApproved: false, launch: spec.taskId, launchCwd: spec.cwd } });
    registry.markDirty(id); // the coordinator records it as launched next; the list then files it under Background agents
    return id;
  },
  createWorktree: (repo, slug, repoId) => createWorktree(coordCfg.worktreeRoot, repo, slug, repoId),
  // close_session: the same way you end a session from its pane.
  end: (sessionId, guard) => messenger.end(sessionId, guard).catch((e) => ({ ok: false, error: (e as Error).message })),
  autoEndBlocker: (s) => inputBlocker(store, s.id) ?? processBlocker(s, codex.daemonPid),
  worktreeState,
  escalate: (sid, title, text) => attention.raiseEscalation(sid ? (registry.sessions.get(sid) ?? null) : null, title, text),
  reportStall: (sid, checkId, status, reason, action) => registry.reportStall(sid, checkId, status, reason, action),
  governor,
  usage: () => usage.snapshot(),
  push: (st) => broadcast({ type: "coordinator", ...st }),
});
if (coord) {
  // Every coordinator message is re-authorized right before transport (grant, claims, mode, holds,
  // and the exact human approval it carries), after all queueing. Without this hook they are refused
  // (with no coordinator, no coordinator-authored message can exist; your own sends need no hook).
  messenger.authorize = (m) => coord.authorizeDelivery(m.sessionId, m.text, m.context);
  // External: no model process, ever. Your agent drives the same engine through `sb mcp`.
  if (coordKind === "builtin") coord.setRuntime(new CoordinatorRuntime(loadCoordinatorConfig, TOOL_NAMES, cfg.port));
  coordinator = coord;
  registry.eventHooks.push((e) => coord.onEvent(e));
  registry.stallHooks.push((s, check) => coord.onStallSuspected(s, check));
  registry.execHooks.push((s) => coord.onSessionExecution(s));
  // A worker ending frees a launch slot: queued plan tasks launch then, not at the next heartbeat.
  registry.execHooks.push((s) => s.execution === "ended" && coord.onSessionEnded(s.id));
  // A session showing up in an uncertain launch's folder may be its worker (a late Codex thread).
  registry.execHooks.push((s) => coord.linkWorker(s));
}
console.log(`coordinator: ${coordKind}`);
// Codex workers it launched, pinned to their process, so they can be ended like any session.
if (coord)
  setInterval(() => {
    try {
      pinCodexWorkers({ terminals: () => bridge.launchedTerminals(), sessions: () => registry.sessions.values(), taskOf: (id) => coord.launchedTask(id), pin: (t, pid, st) => codex.pin(t, pid, st) });
    } catch (e) {
      console.error("[codex-pins]", e);
    }
  }, 15_000);

/** Periodic jobs must never take the daemon down. */
const every = (ms: number, name: string, fn: () => void) =>
  setInterval(() => {
    try {
      fn();
    } catch (e) {
      console.error(`[${name}]`, e);
    }
  }, ms);
every(30_000, "coordination", () => {
  coordination.sweep(registry.sessions);
  coordination.checkSharedWorktrees(registry.sessions);
});
every(15_000, "perspectives", () => perspectives.detect());
every(5_000, "governor", () => {
  governor.tick(system);
  if (system) system.gameMode = governor.gameMode;
});

every(30_000, "usage", () => usage.refresh());
void usage.refresh();

// Codex approvals reach us only on threads we subscribed to; they carry the full request.
// The Settings policy is authoritative for both providers, even with the coordinator off.
// D44: off unless switched on; when on, project-code execution only for coordinator workers in
// their own worktree unless config says "all"; excluded sessions never.
const launchedCwd = (sessionId: string) => coordination.reservations().find((r) => r.sessionId === sessionId)?.cwd ?? null;
const permissionPolicy = new SafePermissionPolicy(store, (info) => {
  const s = registry.sessions.get(info.sessionId);
  return launchedCwd(info.sessionId) ?? s?.project ?? null;
}, cfg.autoApproveSafePermissions ?? false, {
  excluded: (sessionId) => coordinator?.authority(sessionId) === "excluded",
  ownWorktree: (info) => inOwnWorktree(!!coordinator?.isLaunched(info.sessionId), coordination.reservations().find((r) => r.sessionId === info.sessionId && r.state === "launched"), info.cwd, coordCfg.worktreeRoot),
});
const permissions = new PermissionBroker({
  checking: (id, checking) => attention.setPermissionChecking(id, checking),
  holdMs: () => (cfg.permissionHoldMinutes ?? 10) * 60_000,
  safeDecision: (info) => permissionPolicy.decide(info),
  mayJudge: () => false,
  roots: () => [],
  judge: async () => null,
  raise: (info, answerKey, recommendation, questions) => {
    const s = registry.sessions.get(info.sessionId);
    // AskUserQuestion: the card shows the questions and their options, and takes the answers.
    if (s) attention.raisePermission(s, { tool: info.tool, summary: JSON.stringify({ input: info.input, cwd: info.cwd }, null, 2), answerKey, recommendation, ...(questions ? { questions } : {}) });
  },
  settle: (key, how) => attention.settlePermission(key, how),
  logAuto: (info, v) => {
    const s = registry.sessions.get(info.sessionId);
    coordinator?.log("permission_auto_approval", "ok", JSON.stringify({ tool: info.tool, input: info.input, cwd: info.cwd }), { sessionId: info.sessionId, reason: v.rule ?? v.reason });
    if (s) attention.recordAutoApproval(s, { tool: info.tool, summary: JSON.stringify({ tool: info.tool, input: info.input, cwd: info.cwd }), reason: v.reason, rule: v.rule, key: randomUUID() });
  },
});

// A crash between approval and sending must not silently hide an unconfirmed retry.
for (const row of store.db.query("SELECT data FROM attention WHERE json_extract(data, '$.meta.retryPending')=1").all() as { data: string }[]) {
  const item = JSON.parse(row.data);
  const message = store.outboxByClientId(`tool-denial-auto:${item.id}`);
  if (message) {
    attention.annotate(item.id, { replyOutboxId: message.id });
    attention.onDelivery(message);
  }
  if (!message || message.state !== "accepted") attention.retryFailed(item.id, "Automatic retry was interrupted. Check delivery in the session.");
}

codexLive.onApproval = (a) => {
  const sid = `codex:${a.threadId}`;
  const answerKey = `${a.threadId}:${a.rpcId}`;
  const s = registry.sessions.get(sid);
  // Tool from the request method; a command's cwd only from the request (codexApprovalInfo).
  const info = codexApprovalInfo(a, s?.cwd ?? null);
  const summary = info.summary;
  void permissions.decide(info).then(({ allow, recommendation }) => {
    if (allow) {
      try {
        messenger.acquire(sid, "codex-daemon"); // same control-path rule as an approval answered by you
        codexLive.answer(answerKey, "accept");
        return;
      } catch {
        // A control-path conflict must still leave the pending prompt actionable.
        if (codexLive.approvals.has(answerKey) && s) attention.raisePermission(s, { tool: info.tool, summary, answerKey, recommendation: "Automatic approval could not be delivered; choose Allow or Deny." });
        return;
      }
    }
    const fullCall = JSON.stringify({ command: a.rawCommand, cwd: info.cwd, reason: a.reason, request: a.raw }, null, 2);
    attention.noteApproval(sid, { tool: a.kind, summary: fullCall, ts: a.ts, answerKey });
    if (s) attention.raisePermission(s, { tool: a.kind, summary: fullCall, answerKey, recommendation });
  });
};

codexLive.onApprovalResolved = (_thread, key) => attention.settlePermission(key, "answered in the session");

const monitor = new SystemMonitor();
let system: SystemStats | null = null;

const phonePush = new NeedsYouPush(store.db, cfg.push?.subject || "mailto:switchboard@localhost", undefined, { details: cfg.push?.details === true });
let http;
try {
  http = startHttp({ port: cfg.port, remoteHost: cfg.remoteHost, token, coordinatorToken, registry, store, webDist: paths.webDist, system: () => system, attention, messenger, codexLive, uploads, bridge, auto, perspectives, coordination, governor, usage, coordinator: coord ?? undefined, coordinatorAgent: coordKind, permissions, permissionPolicy, push: phonePush });
  broadcast = http.broadcast;
} catch (e) {
  console.error(`switchboardd: cannot listen on 127.0.0.1:${cfg.port} (${(e as Error).message}). Is another instance running?`);
  process.exit(1);
}

registry.start(2000);
setInterval(() => {
  system = monitor.sample();
  http.broadcast({ type: "system", system });
}, 2000);

console.log(`switchboardd listening on http://127.0.0.1:${cfg.port}  (data: ${paths.dataDir})`);

const shutdown = () => {
  coord?.runtime?.stop();
  registry.stop();
  codex.daemon.close();
  process.exit(0);
};
process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
