import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../src/daemon/db.ts";
import { Registry } from "../src/daemon/registry.ts";
import { blankSession } from "../src/daemon/state.ts";
import { AttentionEngine } from "../src/daemon/attention.ts";
import { SafePermissionPolicy, deniedPermissionInfo } from "../src/daemon/permission-policy.ts";
import { retrySafeDenial } from "../src/daemon/permission-retry.ts";
import { PermissionBroker } from "../src/daemon/permissions.ts";
import { Messenger } from "../src/daemon/messaging.ts";
import { startHttp } from "../src/daemon/http.ts";
import type { AttentionItem, SbEvent } from "../src/shared/types.ts";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((f) => f()));
function setup(provider: "claude" | "codex" = "claude") {
  mkdirSync(resolve(".sandbox"), { recursive: true });
  const root = mkdtempSync(resolve(".sandbox/permission-flow-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "file.txt"), "safe");
  const store = new Store(root); cleanup.push(() => store.db.close());
  const registry = new Registry([], store, {} as any);
  const s = { ...blankSession(`${provider}:worker`, provider, "tui", "worker"), cwd: root, project: root, execution: "working" as const, meta: { onDaemon: provider === "codex" } };
  registry.sessions.set(s.id, s);
  const policy = new SafePermissionPolicy(store, () => root, "all"); // these flows exercise the execution rules everywhere
  const sent: string[] = []; const notifications: AttentionItem[] = []; const pushed: AttentionItem[] = [];
  let transport: "accepted" | "failed" | "uncertain" = "accepted";
  const pending: Promise<void>[] = [];
  const attention = new AttentionEngine(store, {} as any, {
    pushItem: (i) => pushed.push({ ...i }), notify: (i) => notifications.push(i), setExecution() {},
    classifyDenial: (s, call) => policy.decide(deniedPermissionInfo(s.id, provider, call)),
    retryDenied: (s, item) => pending.push(retrySafeDenial(store, attention, messenger, s, item)),
  });
  registry.attention = attention;
  const messenger = new Messenger(store, registry, { send: async (_id: string, text: string) => { sent.push(text); return { outcome: transport, detail: "test", error: transport === "accepted" ? undefined : transport }; } } as any, {} as any, (m) => attention.onDelivery(m));
  messenger.terminal = { canSend: () => true, send: async (_s, text) => { sent.push(text); return { ok: transport === "accepted", wrote: transport !== "failed", error: transport }; }, interrupt: async () => ({ ok: true }) };
  registry.eventHooks.push((e) => messenger.onEvent(e));
  const broker = new PermissionBroker({ holdMs: () => 10_000, safeDecision: (i) => policy.decide(i), mayJudge: () => true, roots: () => [root], judge: async () => { throw Error("must never call a model"); },
    raise: (i, answerKey, recommendation) => attention.raisePermission(s, { tool: i.tool, summary: i.summary, answerKey, recommendation }), settle: (key, how) => attention.settlePermission(key, how), logAuto: (i, v) => attention.recordAutoApproval(s, { tool: i.tool, summary: JSON.stringify(i.input), reason: v.reason, rule: v.rule, key: `hook-${pushed.length}` }),
  });
  const events = (id: string, command = "cat file.txt", reason = "automatic approval review denied the action", ts = Date.now()): SbEvent[] => [
    { sessionId: s.id, sourceId: `call-${id}`, type: "tool_call", ts, data: { toolUseId: id, name: provider === "claude" ? "Bash" : "exec_command", input: provider === "claude" ? { command } : { cmd: command, workdir: root, max_output_tokens: 2000 }, cwd: root } },
    { sessionId: s.id, sourceId: `result-${id}`, type: "tool_result", ts, data: { toolUseId: id, denialReason: reason } },
  ];
  return { root, store, registry, s, policy, attention, broker, messenger, events, sent, notifications, pushed, ingest: async (es: SbEvent[]) => { registry.ingest(s.id, es); await Promise.all(pending); }, transport: (v: typeof transport) => { transport = v; } };
}

for (const provider of ["claude", "codex"] as const) test(`${provider}: safe denied call gets one exact retry, no open card/notification, full rule log and durable dedup`, async () => {
  const h = setup(provider);
  const es = h.events("one");
  await h.ingest(es);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toContain("read-only-cat"); expect(h.sent[0]).toContain("cat file.txt"); expect(h.sent[0]).toContain(h.root);
  expect(h.sent[0]).not.toContain("The user approved");
  expect(h.attention.open()).toHaveLength(0); expect(h.notifications).toHaveLength(0);
  expect(h.pushed.every((i) => i.status === "resolved")).toBe(true);
  const item = h.store.recentAttention()[0];
  expect(item.meta.autoRule).toBe("read-only-cat"); expect(item.text).toContain("cat file.txt"); expect(item.resolution).toBe("auto");
  if (provider === "claude") await h.ingest([{ sessionId: h.s.id, sourceId: "receipt", type: "user_msg", ts: Date.now(), data: { text: h.sent[0] } }]);
  expect(h.store.getAttention(item.id)?.meta.retryPending).toBe(false);
  await h.ingest(es); expect(h.sent).toHaveLength(1);
  await h.ingest(h.events("repeat")); expect(h.sent).toHaveLength(1); expect(h.attention.open()).toHaveLength(1);
});

for (const reason of ["User denied the call", "The user rejected this action", "Rejected by user", "rejected by user approval settings"]) test(`explicit human rejection stays a card: ${reason}`, async () => {
  const h = setup(); await h.ingest(h.events("human", "cat file.txt", reason));
  expect(h.sent).toHaveLength(0); expect(h.attention.open()).toHaveLength(1);
});

// The user's own deny rules and hooks are their decision: never "approved by the policy, retry".
for (const reason of ["Permission to use Bash with command cat file.txt has been denied.", "PreToolUse:Bash hook error: blocked by the repo's guard", "PreToolUse hook blocked: no reads today", "Hook denied this tool call", "Error: rejected by configuration", "Tool permission request failed: blocked by policy"]) test(`a settings deny rule or hook stays a card with no automatic retry: ${reason}`, async () => {
  const h = setup(); await h.ingest(h.events("rule", "cat file.txt", reason));
  expect(h.sent).toHaveLength(0); expect(h.attention.open()).toHaveLength(1);
  expect(h.attention.open()[0].meta.autoApproved).toBeUndefined();
});
for (const reason of ["Permission for this action was denied by the Claude Code auto mode classifier.\nReason: the policy wants explicit authorization", "Claude requested permissions to use Bash, but you haven't granted it yet."]) test(`an unanswerable provider prompt the policy approves is retried: ${reason.split("\n")[0]}`, async () => {
  const h = setup(); await h.ingest(h.events("prompt", "cat file.txt", reason));
  expect(h.sent).toHaveLength(1); expect(h.attention.open()).toHaveLength(0);
});

test("unsafe, disabled and historical denials remain actionable without sending", async () => {
  for (const variant of ["unsafe", "disabled", "historical"]) {
    const h = setup(); if (variant === "disabled") h.policy.setEnabled(false);
    await h.ingest(h.events(variant, variant === "unsafe" ? "cat ../outside" : "cat file.txt", undefined, variant === "historical" ? 1 : Date.now()));
    expect(h.sent).toHaveLength(0); expect(h.attention.open()).toHaveLength(1);
  }
});

test("uncertain automatic delivery reopens the card, preserves delivery state, and later receipt settles as auto", async () => {
  const h = setup("codex"); h.transport("uncertain"); await h.ingest(h.events("uncertain"));
  const card = h.attention.open()[0]; expect(card.meta.replyState).toBe("uncertain"); expect(card.meta.retryPending).toBe(false);
  h.messenger.resolve(card.meta.replyOutboxId as number, "delivered");
  expect(h.attention.open()).toHaveLength(0); expect(h.store.getAttention(card.id)?.resolution).toBe("auto");
});

test("failed automatic delivery restores Allow/Deny", async () => {
  const h = setup("codex"); h.transport("failed"); await h.ingest(h.events("failed"));
  expect(h.attention.open()).toHaveLength(1); expect(h.attention.open()[0].meta.replyState).toBe("failed");
});

function http(h: ReturnType<typeof setup>) {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = probe.port!; probe.stop(true);
  const token = "a".repeat(64); const coordinatorToken = "c".repeat(64);
  const { server } = startHttp({ port, token, coordinatorToken, registry: h.registry, store: h.store, attention: h.attention, permissions: h.broker, permissionPolicy: h.policy, messenger: h.messenger, webDist: h.root, system: () => null } as any);
  cleanup.push(() => server.stop(true));
  return (path: string, body?: unknown, bearer = token) => fetch(`http://127.0.0.1:${port}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test("HTTP Settings persists a validated human-only switch and immediately controls held hooks", async () => {
  const h = setup(); const api = http(h);
  expect(await (await api("settings/permissions")).json()).toEqual({ autoApproveSafe: true, scope: "all" });
  for (const body of [{ autoApproveSafe: "false" }, {}, { autoApproveSafe: true, other: 1 }]) expect((await api("settings/permissions", body)).status).toBe(400);
  expect((await api("settings/permissions", { autoApproveSafe: false }, "c".repeat(64))).status).toBe(403);
  const hook = () => api("hook/claude/PermissionRequest?wait=1", { session_id: "worker", tool_name: "Bash", tool_input: { command: "cat file.txt" }, cwd: h.root });
  expect(await (await hook()).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
  expect(h.attention.open()).toHaveLength(0); expect(h.notifications).toHaveLength(0);
  expect((await api("settings/permissions", { autoApproveSafe: false })).status).toBe(200);
  const reopenedStore = new Store(h.root); expect(new SafePermissionPolicy(reopenedStore, () => h.root).snapshot().autoApproveSafe).toBe(false); reopenedStore.db.close();
  const pending = hook();
  for (let n = 0; n < 100 && !h.attention.open().length; n++) await Bun.sleep(1);
  const card = h.attention.open()[0]; expect(card.meta.answerKey).toMatch(/^claude-hook:/);
  expect((await api(`attention/${card.id}/answer`, { decision: "decline" })).status).toBe(200);
  expect(await (await pending).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
});

test("HTTP cannot send a second decision while an automatic retry is uncertain", async () => {
  const h = setup("codex"); const api = http(h); h.transport("uncertain"); await h.ingest(h.events("uncertain"));
  const card = h.attention.open()[0];
  for (const decision of ["accept", "decline"]) expect((await api(`attention/${card.id}/answer`, { decision })).status).toBe(409);
  expect(h.sent).toHaveLength(1);
});

test("delivery completing before the denied turn ends does not raise a second question", async () => {
  const h = setup("codex");
  const started = Date.now() - 100;
  await h.ingest(h.events("quick"));
  expect(h.store.recentAttention()[0].meta.retryPending).toBe(false);
  h.attention.onEvent(h.s, { sessionId: h.s.id, sourceId: "end", type: "turn_ended", ts: Date.now(), data: { lastAgentMessage: "May I retry the denied call?" } }, started);
  expect(h.attention.open()).toHaveLength(0);
  // A real choice in a subsequent turn still reaches the user.
  h.attention.onEvent(h.s, { sessionId: h.s.id, sourceId: "end-later", type: "turn_ended", ts: Date.now() + 200, data: { lastAgentMessage: "Which cache should I use, Redis or SQLite?" } }, Date.now() + 100);
  expect(h.attention.open()).toHaveLength(1);
});

test("an actionable live provider card stays singular when the waiting status poll arrives", () => {
  const h = setup("codex");
  const prompt = { tool: "command", summary: "curl https://example.com", answerKey: "worker:rpc", recommendation: "Unknown or network operation" };
  h.attention.raisePermission(h.s, prompt);
  h.s.execution = "waiting_approval" as any; h.s.executionConfidence = "confirmed";
  h.attention.onExecutionChange(h.s, "working"); h.attention.raisePermission(h.s, prompt);
  expect(h.attention.open()).toHaveLength(1); expect(h.notifications).toHaveLength(1);
  h.attention.settlePermission(prompt.answerKey, "answered in the session");
  expect(h.attention.open()).toHaveLength(0);
});

for (const provider of ["claude", "codex"] as const) test(`${provider}: verification denials retry autonomously and later test runs are not blocked by old approvals`, async () => {
  const h = setup(provider);
  writeFileSync(join(h.root, "package.json"), JSON.stringify({ scripts: { test: "arbitrary code", build: "arbitrary code" } }));
  const command = "bun run test && bun run build";
  await h.ingest(h.events("first-tests", command));
  expect(h.sent).toHaveLength(1); expect(h.attention.open()).toHaveLength(0);
  expect(h.store.recentAttention()[0].meta.autoRule).toBe("verification-package-script:bun:test + verification-package-script:bun:build");
  if (provider === "claude") await h.ingest([{ sessionId: h.s.id, sourceId: "first-test-receipt", type: "user_msg", ts: Date.now(), data: { text: h.sent[0] } }]);
  // A real run (even failing assertions) proves permission was obtained. This is not another denial.
  const run = h.events("executed-tests", command);
  run[1].data = { toolUseId: "executed-tests", isError: true, preview: "1 assertion failed" };
  await h.ingest(run);
  await h.ingest(h.events("next-tests", command));
  expect(h.sent).toHaveLength(2); expect(h.attention.open()).toHaveLength(0); expect(h.notifications).toHaveLength(0);
  await h.ingest(h.events("denied-again", command));
  expect(h.sent).toHaveLength(2); expect(h.attention.open()).toHaveLength(1); // bound a stuck retry
});

test("repeated verification asks are logged each time and the Settings switch still controls them", async () => {
  const h = setup(); const api = http(h);
  writeFileSync(join(h.root, "package.json"), JSON.stringify({ scripts: { typecheck: "arbitrary code" } }));
  const hook = () => api("hook/claude/PermissionRequest?wait=1", { session_id: "worker", tool_name: "Bash", tool_input: { command: "bun test && bun run typecheck" }, cwd: h.root });
  for (let i = 0; i < 3; i++) expect(await (await hook()).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
  const logs = h.store.recentAttention();
  expect(logs).toHaveLength(3);
  for (const item of logs) { expect(item.meta.autoRule).toContain("verification-bun:test"); expect(item.meta.autoRule).toContain("verification-package-script:bun:typecheck"); expect(item.text).toContain("bun test && bun run typecheck"); }
  h.policy.setEnabled(false);
  const pending = hook();
  for (let n = 0; n < 100 && !h.attention.open().length; n++) await Bun.sleep(1);
  const item = h.attention.open()[0];
  expect((await api(`attention/${item.id}/answer`, { decision: "decline" })).status).toBe(200);
  expect(await (await pending).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
});
