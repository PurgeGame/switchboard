// The coordinator's chat: replies to the user's messages show; its thoughts on background events
// don't; its own routing isn't mistaken for the user typing; pasted images reach the model.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/shared/types.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { CoordinatorAgent } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { ClaudeRuntime } from "../src/daemon/coordinator/runtime.ts";
import { Store } from "../src/daemon/db.ts";
import { blankSession } from "../src/daemon/state.ts";

function rig() {
  const store = new Store("", ":memory:");
  const s: Session = { ...blankSession("web", "claude", "tui", "web"), execution: "idle", name: "web" };
  const sent: { text: string; images: string[] }[] = [];
  const agent = new CoordinatorAgent({
    db: store.db,
    coordination: new Coordination(store),
    cfg: mergeCoordinatorConfig({}),
    sessions: () => new Map([[s.id, s]]),
    events: () => [],
    send: async () => ({ ok: true }),
    route: async () => ({ ok: true }),
    escalate: () => {},
    push: () => {},
    timers: false,
  });
  const rt: any = { busy: false, running: true, send: (text: string, images: string[] = []) => (sent.push({ text, images }), true), stop() {}, onText: () => {}, onResult: () => {}, onExit: () => {} };
  agent.setRuntime(rt);
  agent.setMode("active");
  return { agent, rt, sent, store };
}

test("replies to the user's message show in chat; replies to background events don't", () => {
  const x = rig();
  x.agent.userChat("what's the auth session doing?");
  x.rt.onText("It's adding rate limiting.");
  x.rt.onResult({ total_cost_usd: 0, usage: {} });
  (x.agent as any).deliver("EVENTS: session web ended", "wake");
  x.rt.onText("Nothing needs doing.");
  const chat = x.agent.chat().map((e) => [e.role, e.text]);
  expect(chat).toContainEqual(["coordinator", "It's adding rate limiting."]);
  expect(chat.some(([, t]) => t === "Nothing needs doing." || String(t).startsWith("EVENTS"))).toBe(false);
});

test("its own routed message arriving in a session isn't 'the user typed there'", async () => {
  const x = rig();
  const r = x.agent.userChat("tell web to fix the header");
  await x.agent.callTool("route_to_session", { chatId: r.id, sessionId: "web", reason: "website" });
  (x.agent as any).startedAt = 0;
  x.agent.onEvent({ id: 1, sessionId: "web", sourceId: "u", type: "user_msg", ts: Date.now(), data: { text: "tell web to fix the header" } } as any);
  expect((x.agent as any).humanHold.has("web")).toBe(false);
});

test("pasted images go to the model as image blocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-img-"));
  try {
    const png = join(dir, "shot.png");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const rt = new ClaudeRuntime(() => "opus", [], 0);
    let written = "";
    (rt as any).proc = { stdin: { write: (l: string) => (written = l), flush() {} } };
    expect(rt.send("any keys in here?", [png])).toBe(true);
    const msg = JSON.parse(written).message;
    expect(msg.content[1]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generic defaults: Claude Opus xhigh, $10 a day, 3 workers, 1 message per 10 min and 6 an hour per session", () => {
  const cfg = mergeCoordinatorConfig({});
  expect(cfg.provider).toBe("claude");
  expect(cfg.model).toBe("opus");
  expect(cfg.effort).toBe("xhigh");
  expect(cfg.codex).toEqual({ model: "gpt-6.1-sol", effort: "high" });
  expect(cfg.limits).toMatchObject({ dailyBudgetUsd: 10, maxLaunched: 3, perSessionCooldownMs: 10 * 60_000, perSessionPerHour: 6 });
  expect(cfg.tiers.deep).toEqual({ claude: { model: "opus", effort: "xhigh" }, codex: { model: "gpt-6-astra", effort: "xhigh" } });
  expect(cfg.tiers.standard).toEqual({ claude: { model: "sonnet", effort: null }, codex: { model: "gpt-6.1-sol", effort: null } });
  expect(cfg.tiers.light).toEqual({ claude: { model: "haiku", effort: null }, codex: { model: "gpt-6-luna", effort: null } });
  expect(mergeCoordinatorConfig({ codex: { effort: "xhigh" } }).codex).toEqual({ model: "gpt-6.1-sol", effort: "xhigh" });
});

test("owner settings in config.json reproduce any previous behavior, including no per-time limits", () => {
  const cfg = mergeCoordinatorConfig({
    provider: "codex", model: "opus", effort: "medium", codex: { model: "gpt-6-astra", effort: "xhigh" },
    limits: { perSessionCooldownMs: 0, perSessionPerHour: 0, maxLaunched: 10, dailyBudgetUsd: 50 },
    tiers: { deep: { codex: { model: "gpt-6-astra", effort: "ultra" } }, light: { claude: { model: "sonnet" } } },
  });
  expect(cfg).toMatchObject({ provider: "codex", effort: "medium", codex: { model: "gpt-6-astra", effort: "xhigh" } });
  expect(cfg.limits).toMatchObject({ perSessionCooldownMs: 0, perSessionPerHour: 0, maxLaunched: 10, dailyBudgetUsd: 50 });
  expect(cfg.tiers.deep.codex).toEqual({ model: "gpt-6-astra", effort: "ultra" });
  expect(cfg.tiers.light.claude).toEqual({ model: "sonnet", effort: null });
});

test("only an explicit 0 removes a message limit: missing, null, negative or non-numeric values keep the default", () => {
  for (const bad of [null, "0", -1, Number.NaN, true, {}])
    expect(mergeCoordinatorConfig({ limits: { perSessionPerHour: bad, perSessionCooldownMs: bad } }).limits).toMatchObject({ perSessionPerHour: 6, perSessionCooldownMs: 10 * 60_000 });
  expect(mergeCoordinatorConfig({ limits: {} }).limits.perSessionPerHour).toBe(6);
  expect(mergeCoordinatorConfig({ limits: { perSessionPerHour: 0 } }).limits.perSessionPerHour).toBe(0);
});

test("its replies keep their paragraphs and list lines (no wall of text)", async () => {
  const x = rig();
  x.agent.userChat("go over the limits");
  const reply = "Here's what I see.\n\n**Coordinator**\n- Model: opus\n- Budget: $50 a day   \n\n\n\nThat's all.";
  x.rt.onText(reply);
  await x.agent.callTool("tell_user", { text: "Done.\n\n- one\n- two", reason: "r" });
  const texts = x.agent.chat().filter((e) => e.role === "coordinator").map((e) => e.text);
  expect(texts).toContain("Here's what I see.\n\n**Coordinator**\n- Model: opus\n- Budget: $50 a day\n\nThat's all.");
  expect(texts).toContain("Done.\n\n- one\n- two");
});

test("get_state carries every setting that applies to it, and says only the user changes them", async () => {
  const x = rig();
  const r = await x.agent.callTool("get_state", {});
  const s = (r as any).result.settings;
  expect(s.limits.maxLaunched).toBeNumber();
  expect(s.tiers.standard.claude.model).toBeString();
  expect(s.coordinator.model).toBeString();
  expect(s.whoChanges).toContain("Only the user");
});
