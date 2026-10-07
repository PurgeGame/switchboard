// Sanitized fixture transcripts model a Claude auto-mode denial and a Codex approval rejection.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseClaudeRecord } from "../src/daemon/adapters/parse-claude.ts";
import { parseCodexLine } from "../src/daemon/adapters/parse-codex.ts";
import { toolDenialReason } from "../src/daemon/adapters/tool-denial.ts";
import { AttentionEngine } from "../src/daemon/attention.ts";
import { Store } from "../src/daemon/db.ts";
import { startHttp } from "../src/daemon/http.ts";
import { Messenger } from "../src/daemon/messaging.ts";
import { Registry } from "../src/daemon/registry.ts";
import { blankSession } from "../src/daemon/state.ts";
import { needsYou } from "../src/web/src/home.ts";
import { needsYouItems } from "../src/shared/needs-you.ts";
import { inputBlocker } from "../src/daemon/coordinator/auto-end.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });

function fixture(provider: "claude" | "codex") {
  const path = `./fixtures/${provider}/${provider === "claude" ? "transcripts" : "rollouts"}/permission-denial.jsonl`;
  const parse = provider === "claude" ? parseClaudeRecord : parseCodexLine;
  return readFileSync(new URL(path, import.meta.url), "utf8").trim().split("\n").flatMap((line, i) => parse(JSON.parse(line), `${provider}:worker`, `@${i}`).events);
}

function setup(provider: "claude" | "codex" = "claude") {
  const store = new Store("", ":memory:");
  cleanup.push(() => store.db.close());
  const registry = new Registry([], store, {} as any);
  const s = { ...blankSession(`${provider}:worker`, provider, "tui", "worker"), name: "worker", cwd: "/workspace/app", execution: "working" as const, meta: provider === "codex" ? { onDaemon: true } : {} };
  registry.sessions.set(s.id, s);
  const notifications: number[] = [];
  let autoQuestions = 0;
  const attention = new AttentionEngine(store, {} as any, { pushItem() {}, notify: (it) => notifications.push(it.id), setExecution() {}, questionRaised: () => autoQuestions++ }, undefined, Date.parse("2026-10-07T10:00:00Z"));
  registry.attention = attention;
  const events = fixture(provider);
  const ingest = (es = events) => registry.ingest(s.id, es);
  return { store, registry, s, attention, events, ingest, notifications, autoQuestions: () => autoQuestions };
}

for (const provider of ["claude", "codex"] as const) {
  test(`${provider} fixture: denial raises one actionable card with the matching call and reason`, () => {
    const h = setup(provider);
    h.ingest();
    const [card] = h.attention.open(h.s.id);
    expect(h.attention.open()).toHaveLength(1);
    expect(card.kind).toBe("approval");
    expect(card.text).toContain("rg -n 'permission|approval' src");
    expect(card.text).not.toContain("git status");
    expect(card.meta.denialReason).toContain(provider === "claude" ? "Sensitive-Source Provenance" : "explicit user authorization");
    expect(card.meta.deniedToolCall).toMatchObject({ toolUseId: "read-src", cwd: "/workspace/app" });
    expect(needsYou({ [card.id]: card }).prompts).toEqual([card]); // shared by both views
    expect(needsYouItems({ attention: h.attention.open(), sessions: { [h.s.id]: h.s }, tasks: [], coordinator: null }).map((i) => i.id)).toEqual([`attention:${card.id}`]);
    expect(inputBlocker(h.store, h.s.id)).toBe("waiting on a question or permission prompt");
    expect(h.autoQuestions()).toBe(0);
    expect(h.notifications).toEqual([card.id]);
    h.ingest();
    expect(h.attention.open()).toHaveLength(1);
    expect(h.notifications).toHaveLength(1);
  });

  for (const decision of ["accept", "decline"] as const) {
    test(`${provider} fixture over HTTP: ${decision} sends the exact call to the worker and settles both views`, async () => {
      const h = httpSetup(provider);
      h.ingest();
      const card = h.attention.open()[0];
      const reply = await h.post(card.id, decision);
      expect(reply.status).toBe(200);
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]).toContain(decision === "accept" ? "The user approved this exact tool call" : "Carry on without it; do not retry this call");
      expect(h.sent[0]).toContain("rg -n 'permission|approval' src");
      expect(h.sent[0]).toContain("read-src");
      expect(h.sent[0]).toContain("Working directory: /workspace/app");
      expect(h.sent[0]).toContain(provider === "claude" ? '"timeout": 10000' : '"max_output_tokens": 2000');
      if (provider === "claude") {
        expect(h.attention.open()[0].meta.replyState).toBe("sending");
        h.registry.ingest(h.s.id, [{ sessionId: h.s.id, sourceId: "reply-receipt", type: "user_msg", ts: Date.now(), data: { text: h.sent[0] } }]);
      }
      expect(h.store.getAttention(card.id)?.resolution).toBe("answered_ui");
      expect(h.attention.open()).toHaveLength(0);
      expect(h.attention.open(h.s.id)).toHaveLength(0);
      expect(needsYouItems({ attention: h.attention.open(), sessions: { [h.s.id]: h.s }, tasks: [], coordinator: null })).toEqual([]);
      expect(inputBlocker(h.store, h.s.id)).toBeNull();
      expect((await h.post(card.id, decision)).status).toBe(404);
      expect(h.sent).toHaveLength(1);
      h.ingest();
      expect(h.attention.open()).toHaveLength(0);
    });
  }
}

test("a denial survives the provider leaving waiting_approval and does not become an auto-continue question", () => {
  const h = setup();
  h.ingest(h.events.filter((e) => e.type !== "tool_result" && e.type !== "turn_ended" && e.type !== "assistant_msg"));
  h.s.execution = "waiting_approval" as any;
  h.s.executionConfidence = "confirmed";
  h.attention.onExecutionChange(h.s, "working");
  h.ingest(h.events.filter((e) => e.type === "tool_result" || e.type === "assistant_msg" || e.type === "turn_ended"));
  expect(h.attention.open()).toHaveLength(1);
  expect(h.attention.open()[0].meta.deniedToolCall).toBeDefined();
  expect(h.autoQuestions()).toBe(0);
  h.s.execution = "ended" as any;
  h.attention.onExecutionChange(h.s, "idle");
  expect(h.attention.open()).toHaveLength(0);
});

test("persisted calls match after attention restarts; missing calls never approve a guessed command", () => {
  const h = setup();
  h.ingest(h.events.filter((e) => e.type === "tool_call"));
  const restarted = new AttentionEngine(h.store, {} as any, { pushItem() {}, notify() {}, setExecution() {} });
  h.registry.attention = restarted;
  h.ingest(h.events.filter((e) => e.type === "tool_result"));
  expect(restarted.open()).toHaveLength(1);
  h.ingest([{ sessionId: h.s.id, sourceId: "orphan", type: "tool_result", ts: Date.now(), data: { toolUseId: "missing", denialReason: "Permission for this action was denied" } }]);
  expect(restarted.open()).toHaveLength(1);
});

test("ordinary errors, quoted denial text, successful results and our own hook's Deny are not prompts", () => {
  for (const text of ["rg: src: Permission denied", "Error: Permission denied", "Error: EACCES: permission denied, open '/src'", "Exit code 1\nPermission for this action was denied by the Claude Code auto mode classifier.", "String to replace not found in file.", "Denied from Switchboard by the user."]) expect(toolDenialReason(text)).toBeNull();
  const reason = "Permission for this action was denied by the Claude Code auto mode classifier.";
  const parsed = parseClaudeRecord({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: reason, is_error: false }] } }, "s", "x");
  expect(parsed.events[0].data.denialReason).toBeUndefined();
  expect(parseClaudeRecord({ type: "assistant", message: { content: [{ type: "text", text: reason }] } }, "s", "x").events[0].type).toBe("assistant_msg");
  for (const text of ["Tool permission request failed: cancelled", "Claude requested permissions to use Bash, but you haven't granted it yet.", "PreToolUse hook error: blocked by policy", "exec command rejected by user", "patch rejected by user", "Error: rejected by configuration", "Permission to use Read has been denied."]) expect(toolDenialReason(text)).toBe(text);
});

test("Codex custom tool output blocks and declined command/file items expose the reason", () => {
  const h = setup("codex");
  const rows = [
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "custom", input: 'await tools.exec_command({cmd:"rg needle src"})' } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "custom", output: [{ type: "input_text", text: "Error: automatic approval review denied the action\nReason: needs authorization" }] } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "native", status: "declined", command: ["bash", "-lc", "rg needle src"], cwd: "/workspace/app", aggregated_output: "blocked by a project permission rule" } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", id: "patch", status: "declined", changes: { "src/app.ts": { diff: "-a\n+b" } }, error: "file changes are denied" } } },
  ];
  h.ingest(rows.flatMap((r, i) => parseCodexLine(r, h.s.id, `custom-${i}`).events));
  expect(h.attention.open()).toHaveLength(3);
  expect(h.attention.open()[0].text).toContain('await tools.exec_command({cmd:"rg needle src"})');
  expect(h.attention.open()[1].meta.denialReason).toBe("blocked by a project permission rule");
});

test("long commands and reasons remain exact rather than using the clipped transcript preview", () => {
  const h = setup();
  const command = `rg '${"x".repeat(900)}' src`;
  const reason = `Permission for this action was denied. ${"details ".repeat(200)}End of reason.`;
  const records = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "long", name: "Bash", input: { command } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "long", is_error: true, content: reason }] } },
  ];
  h.ingest(records.flatMap((r, i) => parseClaudeRecord(r, h.s.id, `long-${i}`).events));
  const [card] = h.attention.open();
  expect(card.text).toContain(command);
  expect(card.meta.denialReason).toBe(reason);
});

function httpSetup(provider: "claude" | "codex" = "claude") {
  const h = setup(provider);
  const sent: string[] = [];
  let outcome: "accepted" | "failed" | "uncertain" = "accepted";
  const codex: any = { send: async (_id: string, text: string) => { sent.push(text); return { outcome, detail: "test transport", error: outcome === "accepted" ? undefined : outcome }; } };
  const messenger = new Messenger(h.store, h.registry, codex, {} as any, (message) => h.attention.onDelivery(message));
  h.registry.eventHooks.push((event) => messenger.onEvent(event));
  messenger.terminal = {
    canSend: () => true,
    send: async (_s, text) => { sent.push(text); return { ok: outcome === "accepted", wrote: outcome !== "failed", error: outcome === "accepted" ? undefined : outcome }; },
    interrupt: async () => ({ ok: true }),
  };
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const token = "d".repeat(64);
  const { server } = startHttp({ port, token, coordinatorToken: "c".repeat(64), registry: h.registry, store: h.store, attention: h.attention, messenger, webDist: "/nonexistent", system: () => null, perspectives: { list: () => [] } } as any);
  cleanup.push(() => server.stop(true));
  const post = (id: number, decision: string, bearer = token) => fetch(`http://127.0.0.1:${port}/api/attention/${id}/answer`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ decision }) });
  return { ...h, post, sent, messenger, setOutcome: (v: typeof outcome) => { outcome = v; } };
}

test("failed delivery keeps the card open and permits retry; uncertain delivery never sends twice or changes the decision", async () => {
  const h = httpSetup();
  h.ingest();
  const card = h.attention.open()[0];
  h.setOutcome("failed");
  expect((await h.post(card.id, "accept")).status).toBe(409);
  expect(h.attention.open()).toHaveLength(1);
  h.setOutcome("uncertain");
  expect((await h.post(card.id, "accept")).status).toBe(409);
  expect(h.sent).toHaveLength(2);
  expect((await h.post(card.id, "accept")).status).toBe(409);
  expect((await h.post(card.id, "decline")).status).toBe(409);
  expect(h.sent).toHaveLength(2);
  const pending = h.store.getAttention(card.id)!;
  h.messenger.resolve(pending.meta.replyOutboxId as number, "delivered");
  expect(h.attention.open()).toHaveLength(0);
  expect((await h.post(card.id, "accept")).status).toBe(404);
  expect(h.sent).toHaveLength(2);
});

test("only a human may answer; session-wide approvals and invalid decisions cannot broaden the grant", async () => {
  const h = httpSetup();
  h.ingest();
  const card = h.attention.open()[0];
  expect((await h.post(card.id, "accept", "c".repeat(64))).status).toBe(403);
  expect((await h.post(card.id, "acceptForSession")).status).toBe(400);
  expect((await h.post(card.id, "anything")).status).toBe(400);
  expect(h.sent).toHaveLength(0);
  expect(h.attention.open()).toHaveLength(1);
});

test("answering one denied call does not dismiss another call from the same turn", async () => {
  const h = httpSetup();
  h.ingest();
  const records = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "other-call", name: "Read", input: { file_path: "src/other.ts" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "other-call", is_error: true, content: "Permission to use Read has been denied." }] } },
  ];
  h.ingest(records.flatMap((r, i) => parseClaudeRecord(r, h.s.id, `other-${i}`).events));
  const [first, second] = h.attention.open();
  expect((await h.post(first.id, "accept")).status).toBe(200);
  h.ingest([{ sessionId: h.s.id, sourceId: "one-answer", type: "user_msg", ts: Date.now(), data: { text: h.sent[0] } }]);
  expect(h.attention.open().map((it) => it.id)).toEqual([second.id]);
});

test("Codex rejects an exec call in a CreateProcess wrapper without executing it", () => {
  const h = setup("codex");
  h.ingest(h.events.filter((e) => e.type === "tool_call"));
  const output = 'exec_command failed: CreateProcess { message: "Rejected(\\"automatic approval review denied the action: outside the authorized scope\\")" }';
  h.ingest(parseCodexLine({ type: "response_item", payload: { type: "function_call_output", call_id: "read-src", output } }, h.s.id, "wrapped").events);
  expect(h.attention.open()[0].meta.denialReason).toBe(output);
});
