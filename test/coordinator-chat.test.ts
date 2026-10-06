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

test("the coordinator runs on a strong model and thinks hard by default", () => {
  const cfg = mergeCoordinatorConfig({});
  expect(cfg.model).toBe("opus");
  expect(cfg.effort).toBe("xhigh");
});
