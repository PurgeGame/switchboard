// End session: stop the turn if working, then type the provider's own exit command through the
// guarded terminal path. Fake terminal and store; no real process is touched.
import { expect, test } from "bun:test";
import type { Session } from "../src/shared/types.ts";
import { coordinatorAllowed } from "../src/daemon/auth.ts";
import { Store } from "../src/daemon/db.ts";
import { Messenger, type TerminalSender } from "../src/daemon/messaging.ts";
import { blankSession } from "../src/daemon/state.ts";

function rig(provider: "claude" | "codex", execution: Session["execution"]) {
  const s: Session = { ...blankSession(`${provider}:x`, provider, "tui", "x"), execution };
  const typed: string[] = [];
  let interrupts = 0;
  const terminal: TerminalSender = {
    canSend: () => true,
    send: async (_s, text) => (typed.push(text), { ok: true }),
    interrupt: async () => (interrupts++, { ok: true }),
  };
  const m = new Messenger(new Store("", ":memory:"), { sessions: new Map([[s.id, s]]) } as any, { onReceipt: null } as any, { owns: () => false } as any, () => {});
  m.terminal = terminal;
  return { m, s, typed, interrupts: () => interrupts };
}

test("an idle Claude session gets /exit typed; Codex gets /quit", async () => {
  const c = rig("claude", "idle");
  expect((await c.m.end(c.s.id)).ok).toBe(true);
  expect(c.typed).toEqual(["/exit"]);
  const x = rig("codex", "idle");
  await x.m.end(x.s.id);
  expect(x.typed).toEqual(["/quit"]);
});

test("a working session is stopped first", async () => {
  const c = rig("claude", "working");
  await c.m.end(c.s.id);
  expect(c.interrupts()).toBe(1);
  expect(c.typed).toEqual(["/exit"]);
});

test("the coordinator's credential can't end sessions", () => {
  expect(coordinatorAllowed("POST", ["api", "sessions", "x", "end"])).toBe(false);
});
