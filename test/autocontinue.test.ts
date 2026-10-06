import { describe, expect, test } from "bun:test";
import type { AttentionItem, Session } from "../src/shared/types.ts";
import { AUTO_TEMPLATE, AutoContinuer, prefilter, verifyQuote, type Decision } from "../src/daemon/autocontinue.ts";
import { blankSession } from "../src/daemon/state.ts";

describe("auto-continue rules", () => {
  test("pre-filter: continuation asks only; real choices and destructive actions excluded", () => {
    expect(prefilter("ask", "Step 1 done. Shall I continue with step 2?", { continuationAsk: true }).ok).toBe(true);
    expect(prefilter("ask", "Tabs or spaces?", { continuationAsk: false, realChoice: true }).ok).toBe(false);
    expect(prefilter("ask", "Shall I proceed and force-push to main?", { continuationAsk: true }).ok).toBe(false);
    expect(prefilter("ask", "Want me to go ahead and deploy to production?", { continuationAsk: true }).ok).toBe(false);
    expect(prefilter("stopped", "Schema done. Next, I'll add the API layer.", {}).ok).toBe(true);
    expect(prefilter("stopped", "Schema done.", {}).ok).toBe(false);
  });

  test("quote must be the user's own words", () => {
    const user = ["Please create a.txt, b.txt and c.txt — I want all three."];
    expect(verifyQuote("create a.txt, b.txt and c.txt", user)).toBe(true);
    expect(verifyQuote("CREATE  A.TXT, b.txt AND c.txt", user)).toBe(true);
    expect(verifyQuote("delete everything", user)).toBe(false);
    expect(verifyQuote("ok", user)).toBe(false); // too short to mean anything
    expect(verifyQuote(null, user)).toBe(false);
  });
});

function harness(decision: Decision | null, opts: { methods?: Session["sendMethods"] } = {}) {
  const s = blankSession("claude:1", "claude", "tui", "1");
  s.sendMethods = opts.methods ?? ["terminal"];
  s.execution = "waiting_answer";
  const sent: string[] = [];
  const states: string[] = [];
  const resolved: number[] = [];
  const items = new Map<number, AttentionItem>();
  const auto = new AutoContinuer({
    cfg: { enabled: true, graceMs: 5, maxConsecutive: 2, typingHoldMs: 60_000 },
    session: () => s,
    userTexts: () => ["Create a.txt, b.txt and c.txt. I want all three files."],
    openItem: (id) => items.get(id) ?? null,
    send: async (_id, text) => (sent.push(text), { ok: true }),
    resolveItem: (id) => {
      resolved.push(id);
      items.get(id)!.status = "resolved";
    },
    annotateItem: () => {},
    push: (st) => states.push(st.state),
    decide: async () => decision,
    disabled: () => false,
  });
  let nextId = 1;
  const ask = (text: string, meta: Record<string, unknown> = { continuationAsk: true }) => {
    const item = { id: nextId++, sessionId: s.id, kind: "question", text, meta, status: "open", historical: false } as AttentionItem;
    items.set(item.id, item);
    return auto.onQuestion(item).then((r) => ({ r, item }));
  };
  return { auto, s, sent, states, resolved, ask };
}

const ok: Decision = { verdict: "continue", reason: "user asked for all three", quote: "I want all three files" };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AutoContinuer", () => {
  test("happy path: grace period, fixed template, item resolved", async () => {
    const h = harness(ok);
    const { r } = await h.ask("Created a.txt. Shall I continue with b.txt and c.txt?");
    expect(r).toBe("pending");
    await wait(20);
    expect(h.sent).toEqual([AUTO_TEMPLATE]);
    expect(h.resolved).toEqual([1]);
    expect(h.states).toEqual(["pending", "sent"]);
  });

  test("model says needs_me, or quotes something the user never said: declined", async () => {
    expect((await harness({ verdict: "needs_me", reason: "new scope", quote: null }).ask("Shall I continue?")).r).toBe("declined");
    const h = harness({ verdict: "continue", reason: "x", quote: "you told me to delete prod" });
    expect((await h.ask("Shall I continue?")).r).toBe("declined");
    expect(h.sent).toEqual([]);
  });

  test("no send method, or classifier down: never sends", async () => {
    expect((await harness(ok, { methods: [] }).ask("Shall I continue?")).r).toBe("skipped");
    expect((await harness(null).ask("Shall I continue?")).r).toBe("declined");
  });

  test("consecutive cap and loop detection", async () => {
    const h = harness(ok);
    await h.ask("Done with a. Shall I continue with b?");
    await wait(20);
    expect((await h.ask("Done with a. Shall I continue with b?")).r).toBe("declined"); // same ask, no work between: loop
    h.auto.onEvent({ sessionId: "claude:1", sourceId: "t", type: "tool_call", ts: Date.now(), data: {} });
    const again = await h.ask("Done with a. Shall I continue with b?"); // same words, but it did work: not a loop
    expect(again.r).toBe("pending");
    h.auto.cancel("claude:1");
    await h.ask("Done with b. Shall I continue with c?");
    await wait(20);
    expect(h.sent).toHaveLength(2);
    expect((await h.ask("Done with c. Shall I continue with d?")).r).toBe("declined"); // cap of 2 reached
    h.auto.onEvent({ sessionId: "claude:1", sourceId: "x", type: "user_msg", ts: Date.now(), data: { text: "thanks, keep going" } });
    expect((await h.ask("Done with d. Shall I continue with e?")).r).toBe("pending"); // human message reset the cap
  });

  test("a destructive task is never auto-continued, even when the ask itself looks harmless", async () => {
    const h = harness(ok);
    (h as any).auto.d.userTexts = () => ["Delete a.txt, b.txt and c.txt. I want all three files deleted."];
    expect((await h.ask("Deleted a.txt. Shall I continue with the rest?")).r).toBe("declined");
  });

  test("cancel during grace; typing holds it off", async () => {
    const h = harness(ok);
    await h.ask("Shall I continue with b?");
    expect(h.auto.cancel("claude:1")).toBe(true);
    await wait(20);
    expect(h.sent).toEqual([]);
    h.auto.noteTyping("claude:1");
    expect((await h.ask("Shall I continue with c?")).r).toBe("declined");
  });
});
