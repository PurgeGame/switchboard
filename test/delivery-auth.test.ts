// Phase 1 (p1/delivery-auth): delivery guarantees and credential boundaries.
// Several cases are Codex's cross-build comparison probes (switchboard-codex
// docs/evidence/comparison-repros.ts), turned from "print the bad outcome" into assertions of the
// agreed contract. In-memory or temp-dir stores and fake transports only: no real session is touched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/shared/types.ts";
import { DeliveryError, sendPeerMessage } from "../src/daemon/adapters/claude-peer.ts";
import { Auth, coordinatorAllowed, SESSION_TTL_MS } from "../src/daemon/auth.ts";
import { Store } from "../src/daemon/db.ts";
import { startHttp } from "../src/daemon/http.ts";
import { Messenger, SendError, type TerminalResult, type TerminalSender } from "../src/daemon/messaging.ts";
import { blankSession } from "../src/daemon/state.ts";

class FakeTerminal implements TerminalSender {
  sent: string[] = [];
  interrupts = 0;
  result: TerminalResult = { ok: true };
  canSend() {
    return true;
  }
  async send(_s: Session, text: string) {
    this.sent.push(text);
    return this.result;
  }
  async interrupt() {
    this.interrupts++;
    return { ok: true };
  }
}

function rig(store = new Store("", ":memory:")) {
  const a = blankSession("claude:probe-a", "claude", "tui", "probe-a");
  const b = blankSession("claude:probe-b", "claude", "tui", "probe-b");
  const cx = blankSession("codex:thread-1", "codex", "tui", "thread-1");
  cx.meta.onDaemon = true;
  const registry: any = { sessions: new Map([a, b, cx].map((s) => [s.id, s])) };
  const codexCalls: string[] = [];
  const codex: any = {
    onReceipt: null,
    send: async (_t: string, _x: string, _i: string[], clientId: string) => (codexCalls.push(clientId), { outcome: "accepted", detail: "turn/start" }),
    interrupt: async () => (codexCalls.push("interrupt"), { outcome: "accepted", detail: "turn/interrupt" }),
  };
  const term = new FakeTerminal();
  const make = () => {
    const m = new Messenger(store, registry, codex, { owns: () => false } as any, () => {});
    m.terminal = term;
    return m;
  };
  return { store, a, b, cx, registry, codex, codexCalls, term, make, messenger: make() };
}

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof SendError ? e.status : -1;
  }
};

describe("outbox: idempotency identity", () => {
  test("probe claudeIdempotencyCollision: a key reused for a different session/text is rejected, not a misleading success", async () => {
    const r = rig();
    await r.messenger.send({ sessionId: r.a.id, text: "first payload", clientId: "shared-key" });
    expect(await status(r.messenger.send({ sessionId: r.b.id, text: "different payload", clientId: "shared-key" }))).toBe(409);
    expect(await status(r.messenger.send({ sessionId: r.a.id, text: "changed text", clientId: "shared-key" }))).toBe(409);
    expect(r.term.sent).toEqual(["first payload"]);
  });

  test("the same key with the same request returns the original and never re-sends", async () => {
    const r = rig();
    const m1 = await r.messenger.send({ sessionId: r.a.id, text: "hello", clientId: "k1" });
    const m2 = await r.messenger.send({ sessionId: r.a.id, text: "  hello  ", clientId: "k1" });
    expect(m2.id).toBe(m1.id);
    expect(r.term.sent).toHaveLength(1);
  });
});

describe("outbox: control-path locks", () => {
  test("probe claudeControlPinAfterRestart: the pin survives a new Messenger over the same database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-p1-"));
    try {
      const r1 = rig(new Store(dir));
      await r1.messenger.send({ sessionId: r1.a.id, text: "x", clientId: "c1" });
      expect(r1.messenger.pinnedMethod(r1.a.id)).toBe("terminal");
      r1.store.db.close();
      const r2 = rig(new Store(dir));
      expect(r2.messenger.pinnedMethod(r2.a.id)).toBe("terminal");
      r2.store.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("switching paths is refused while a delivery is unresolved, even with explicit confirmation", async () => {
    const r = rig();
    r.term.result = { ok: false, error: "bridge timeout" };
    const m = await r.messenger.send({ sessionId: r.cx.id, text: "hi", method: "terminal", clientId: "u1" });
    expect(m.state).toBe("uncertain");
    expect(await status(r.messenger.send({ sessionId: r.cx.id, text: "again", method: "codex-daemon", switchMethod: true }))).toBe(409);
    expect(r.codexCalls).toHaveLength(0);
    // The human checks the session and settles it; then an explicit switch is allowed.
    r.messenger.resolve(m.id, "not_delivered");
    await r.messenger.send({ sessionId: r.cx.id, text: "again", method: "codex-daemon", switchMethod: true });
    expect(r.codexCalls).toHaveLength(1);
  });

  test("interrupt follows the pinned path instead of choosing its own", async () => {
    const r = rig();
    await r.messenger.send({ sessionId: r.cx.id, text: "hi", method: "terminal" });
    await r.messenger.interrupt(r.cx.id);
    expect(r.term.interrupts).toBe(1);
    expect(r.codexCalls).not.toContain("interrupt");
  });

  test("approvals take the daemon lock: refused when the session is driven through its terminal", async () => {
    const r = rig();
    await r.messenger.send({ sessionId: r.cx.id, text: "hi", method: "terminal" });
    expect(() => r.messenger.acquire(r.cx.id, "codex-daemon")).toThrow(SendError);
  });
});

describe("outbox: uncertain vs failed", () => {
  test("probe claudeAmbiguousTerminalTimeout: a failure after a possible write is uncertain, not failed", async () => {
    const r = rig();
    r.term.result = { ok: false, error: "bridge timeout after a possible write" };
    expect((await r.messenger.send({ sessionId: r.b.id, text: "ambiguous", clientId: "timeout" })).state).toBe("uncertain");
    // The pin is kept: the message may be in the session.
    expect(r.messenger.pinnedMethod(r.b.id)).toBe("terminal");
  });

  test("a refusal before any write is a definite failure and frees the pin", async () => {
    const r = rig();
    r.term.result = { ok: false, error: "refused: the agent is not the terminal's foreground process", wrote: false };
    expect((await r.messenger.send({ sessionId: r.b.id, text: "x" })).state).toBe("failed");
    expect(r.messenger.pinnedMethod(r.b.id)).toBeNull();
  });

  test("peer: a missing socket provably wrote nothing", async () => {
    const err = await sendPeerMessage("/nonexistent/claude.sock", "x", "id").catch((e) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err.wrote).toBe(false);
  });

  test("restart: in-flight sends become uncertain, are never resent, and a later receipt confirms them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-p1-"));
    try {
      const r1 = rig(new Store(dir));
      const m = await r1.messenger.send({ sessionId: r1.a.id, text: "in flight", clientId: "f1" });
      expect(m.state).toBe("sending");
      r1.store.db.close();
      const r2 = rig(new Store(dir));
      expect(r2.store.outboxByClientId("f1")!.state).toBe("uncertain");
      expect(r2.term.sent).toHaveLength(0);
      r2.messenger.onEvent({ id: 1, sessionId: r2.a.id, sourceId: "t1", type: "user_msg", ts: Date.now(), data: { text: "in flight" } } as any);
      expect(r2.store.outboxByClientId("f1")!.state).toBe("accepted");
      r2.store.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("outbox: receipts are one-to-one", () => {
  test("probe codexOneTranscriptAcknowledgesTwoSends: one transcript record can't confirm two identical sends", async () => {
    const r = rig();
    const m1 = await r.messenger.send({ sessionId: r.a.id, text: "continue", clientId: "first" });
    const m2 = await r.messenger.send({ sessionId: r.a.id, text: "continue", clientId: "second" });
    r.messenger.onEvent({ id: 1, sessionId: r.a.id, sourceId: "one", type: "user_msg", ts: Date.now() + 1, data: { text: "continue" } } as any);
    expect(r.store.outboxByClientId("first")!.receipt).toBe(false);
    expect(r.store.outboxByClientId("second")!.receipt).toBe(false);
    expect([m1.state, m2.state]).toEqual(["sending", "sending"]);
  });

  test("a prefix of the sent text is not a receipt", async () => {
    const r = rig();
    const long = "please refactor the outbox ".repeat(10);
    await r.messenger.send({ sessionId: r.a.id, text: long, clientId: "long" });
    r.messenger.onEvent({ id: 1, sessionId: r.a.id, sourceId: "p", type: "user_msg", ts: Date.now(), data: { text: long.slice(0, 130) } } as any);
    expect(r.store.outboxByClientId("long")!.receipt).toBe(false);
  });

  test("a native receipt naming another thread is ignored", async () => {
    const r = rig();
    await r.messenger.send({ sessionId: r.cx.id, text: "hi", clientId: "cx1" });
    r.store.updateOutbox({ ...r.store.outboxByClientId("cx1")!, state: "sending" });
    r.codex.onReceipt("some-other-thread", "cx1");
    expect(r.store.outboxByClientId("cx1")!.receipt).toBe(false);
    r.codex.onReceipt("thread-1", "cx1");
    expect(r.store.outboxByClientId("cx1")!.receipt).toBe(true);
  });
});

describe("auth: browser sessions", () => {
  test("login codes are single-use; the cookie secret is stored only as a hash", () => {
    const store = new Store("", ":memory:");
    const auth = new Auth(store, "root-token", "coord-token");
    const code = auth.loginCodes.issue(true);
    const secret = auth.login(code)!;
    expect(secret).toBeTruthy();
    expect(auth.login(code)).toBeNull();
    const rows = store.db.query("SELECT hash FROM auth_sessions").all() as { hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).not.toContain(secret);
    const req = new Request("http://127.0.0.1/", { headers: { cookie: `sb_session=${secret}` } });
    expect(auth.principal(req)).toBe("browser");
  });

  test("sessions expire, log out, and revoke everywhere", () => {
    const store = new Store("", ":memory:");
    const auth = new Auth(store, "root-token", "coord-token");
    const s1 = auth.login(auth.loginCodes.issue(true))!;
    const s2 = auth.login(auth.loginCodes.issue(true))!;
    const as = (s: string) => auth.principal(new Request("http://127.0.0.1/", { headers: { cookie: `sb_session=${s}` } }));
    auth.logout(s1);
    expect(as(s1)).toBeNull();
    expect(as(s2)).toBe("browser");
    expect(auth.revokeAll()).toBe(1);
    expect(as(s2)).toBeNull();
    const s3 = auth.login(auth.loginCodes.issue(true))!;
    store.db.query("UPDATE auth_sessions SET expires_at = ?").run(Date.now() - 1);
    expect(as(s3)).toBeNull();
    expect(SESSION_TTL_MS).toBe(12 * 3600_000);
  });

  test("the old raw-token cookie no longer authenticates; a wrong bearer never falls back to the cookie", () => {
    const store = new Store("", ":memory:");
    const auth = new Auth(store, "root-token", "coord-token");
    expect(auth.principal(new Request("http://127.0.0.1/", { headers: { cookie: "sb_token=root-token" } }))).toBeNull();
    const s = auth.login(auth.loginCodes.issue(true))!;
    expect(auth.principal(new Request("http://127.0.0.1/", { headers: { authorization: "Bearer nope", cookie: `sb_session=${s}` } }))).toBeNull();
  });

  test("a rotated root token revokes every older browser session at startup, including ones minted after the rotation", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-rot-"));
    try {
      let store = new Store(dir);
      const before = new Auth(store, "old-root", "c");
      const early = before.login(before.loginCodes.issue(true))!;
      // `sb rotate-token` happened; the old daemon still honors the old token and mints one more.
      const late = before.login(before.loginCodes.issue(true))!;
      store.db.close();
      store = new Store(dir);
      const after = new Auth(store, "new-root", "c");
      const as = (s: string) => after.principal(new Request("http://127.0.0.1/", { headers: { cookie: `sb_session=${s}` } }));
      expect(as(early)).toBeNull();
      expect(as(late)).toBeNull();
      // Same token on a normal restart: sessions survive.
      const fresh = after.login(after.loginCodes.issue(true))!;
      store.db.close();
      store = new Store(dir);
      const again = new Auth(store, "new-root", "c");
      expect(again.principal(new Request("http://127.0.0.1/", { headers: { cookie: `sb_session=${fresh}` } }))).toBe("browser");
      store.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the coordinator credential reaches only its tool endpoints", () => {
    expect(coordinatorAllowed("GET", ["api", "coordinator", "tools"])).toBe(true);
    expect(coordinatorAllowed("POST", ["api", "coordinator", "tool", "list_sessions"])).toBe(true);
    for (const [m, p] of [
      ["GET", ["api", "sessions"]],
      ["POST", ["api", "sessions", "x", "messages"]],
      ["POST", ["api", "coordinator", "mode"]],
      ["POST", ["api", "coordinator", "proposals", "1", "approve"]],
      ["POST", ["api", "objectives"]],
      // p1/authority's human-only routes (merge TODO #2)
      ["POST", ["api", "objectives", "o1", "grant"]],
      ["POST", ["api", "objectives", "o1", "revoke"]],
      ["POST", ["api", "tasks", "t1"]],
      ["POST", ["api", "tasks", "t1", "evidence"]],
      ["POST", ["api", "claims"]],
      ["POST", ["api", "claims", "1", "release"]],
      ["POST", ["api", "conflicts", "c1", "resolve"]],
      ["POST", ["api", "coordinator", "autopilot"]],
      ["POST", ["api", "coordinator", "exclude"]],
      ["POST", ["api", "launch"]],
      ["POST", ["api", "outbox", "1", "resolve"]],
      ["POST", ["api", "login-code"]],
    ] as const)
      expect(coordinatorAllowed(m, [...p])).toBe(false);
  });
});

describe("auth: HTTP boundary (isolated server, stub dependencies)", () => {
  const port = 17_000 + Math.floor(Math.random() * 20_000);
  const base = `http://127.0.0.1:${port}`;
  const store = new Store("", ":memory:");
  let server: { stop: (force?: boolean) => void } | null = null;
  const root = { authorization: "Bearer root-token" };
  const coord = { authorization: "Bearer coord-token" };

  beforeAll(() => {
    const registry: any = { onPush() {}, list: () => [], sessions: new Map() };
    const d: any = { port, token: "root-token", coordinatorToken: "coord-token", registry, store, webDist: "/nonexistent", system: () => null, attention: { open: () => [] }, perspectives: { list: () => [] } };
    server = startHttp(d).server as any;
  });
  // Force-stop without awaiting: Bun waits on server-closed sockets, which only matters for teardown.
  afterAll(() => {
    void server?.stop(true);
  });

  test("the coordinator token is refused on human-control routes", async () => {
    expect((await fetch(`${base}/api/sessions`, { headers: coord })).status).toBe(403);
    expect((await fetch(`${base}/api/sessions/x/messages`, { method: "POST", headers: coord, body: "{}" })).status).toBe(403);
    expect((await fetch(`${base}/api/login-code`, { method: "POST", headers: coord })).status).toBe(403);
    // Human-only authority routes from p1/authority, over real HTTP.
    expect((await fetch(`${base}/api/objectives/o1/grant`, { method: "POST", headers: coord, body: JSON.stringify({ root: "/" }) })).status).toBe(403);
    expect((await fetch(`${base}/api/tasks/t1/evidence`, { method: "POST", headers: coord, body: "{}" })).status).toBe(403);
  });

  test("only the root token mints login links; a browser session can't", async () => {
    const { url } = (await (await fetch(`${base}/api/login-code`, { method: "POST", headers: root })).json()) as { url: string };
    const res = await fetch(url.replace(`127.0.0.1:${port}`, `127.0.0.1:${port}`), { redirect: "manual" });
    // A page, not a 302: a phone opening the link from its camera is a cross-site navigation, and a
    // SameSite=Strict cookie isn't sent on its redirect. The page's own navigation to / is same-site.
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const page = await res.text();
    expect(page).toContain(`location.replace("/" + location.hash)`);
    const nonce = /<script nonce="([^"]+)">/.exec(page)?.[1];
    expect(res.headers.get("content-security-policy")).toContain(`'nonce-${nonce}'`);
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    expect(cookie).not.toContain("root-token");
    expect((await fetch(`${base}/api/login-code`, { method: "POST", headers: { cookie } })).status).toBe(403);
    // The same link can't be used twice.
    expect((await fetch(url, { redirect: "manual" })).status).toBe(401);
  });

  test("a login link opened from another app (cross-site navigation) works; other cross-site requests don't", async () => {
    const mint = async () => ((await (await fetch(`${base}/api/login-code`, { method: "POST", headers: root })).json()) as { url: string }).url;
    const xsite = { "sec-fetch-site": "cross-site" };
    expect((await fetch(await mint(), { redirect: "manual", headers: { ...xsite, "sec-fetch-mode": "navigate" } })).status).toBe(200);
    expect((await fetch(await mint(), { redirect: "manual", headers: { ...xsite, "sec-fetch-mode": "cors" } })).status).toBe(403);
    expect((await fetch(await mint(), { method: "POST", redirect: "manual", headers: { ...xsite, "sec-fetch-mode": "navigate" } })).status).toBe(403);
    expect((await fetch(`${base}/`, { headers: { ...xsite, "sec-fetch-mode": "navigate" } })).status).toBe(403);
  });

  test("WebSockets need a single-use ticket; a cookie alone is refused", async () => {
    const { url } = (await (await fetch(`${base}/api/login-code`, { method: "POST", headers: root })).json()) as { url: string };
    const cookie = (await fetch(url, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
    expect((await fetch(`${base}/api/ws`, { headers: { cookie, upgrade: "websocket", connection: "upgrade" } })).status).toBe(401);
    const { ticket } = (await (await fetch(`${base}/api/ws-ticket`, { method: "POST", headers: { cookie } })).json()) as { ticket: string };
    const open = await new Promise<boolean>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?ticket=${ticket}`);
      ws.onopen = () => (ws.close(), res(true));
      ws.onerror = () => res(false);
    });
    expect(open).toBe(true);
    // Reused ticket.
    expect((await fetch(`${base}/api/ws?ticket=${ticket}`, { headers: { upgrade: "websocket", connection: "upgrade" } })).status).toBe(401);
  });

  test("signing out closes that browser's open sockets; a ticket from a revoked session is refused", async () => {
    const login = async () => {
      const { url } = (await (await fetch(`${base}/api/login-code`, { method: "POST", headers: root })).json()) as { url: string };
      return (await fetch(url, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
    };
    const ticketFor = async (cookie: string) => ((await (await fetch(`${base}/api/ws-ticket`, { method: "POST", headers: { cookie } })).json()) as { ticket: string }).ticket;
    const openWs = (ticket: string) =>
      new Promise<{ ws: WebSocket; closed: Promise<number> }>((res, rej) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?ticket=${ticket}`);
        const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)));
        ws.onopen = () => res({ ws, closed });
        ws.onerror = () => rej(new Error("ws refused"));
      });
    const a = await login();
    const b = await login();
    const sa = await openWs(await ticketFor(a));
    const sb = await openWs(await ticketFor(b));
    await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie: a } });
    expect(await sa.closed).toBe(4401);
    expect(sb.ws.readyState).toBe(WebSocket.OPEN); // other browsers stay signed in
    // A ticket issued just before revocation can't open a socket afterwards.
    const late = await ticketFor(b);
    await fetch(`${base}/api/auth/revoke-all`, { method: "POST", headers: root });
    expect(await sb.closed).toBe(4401);
    expect((await fetch(`${base}/api/ws?ticket=${late}`, { headers: { upgrade: "websocket", connection: "upgrade" } })).status).toBe(401);
  });

  test("signing out revokes the session even when it has no socket open", async () => {
    const { url } = (await (await fetch(`${base}/api/login-code`, { method: "POST", headers: root })).json()) as { url: string };
    const cookie = (await fetch(url, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
    expect((await fetch(`${base}/api/sessions`, { headers: { cookie } })).status).not.toBe(401);
    await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie } });
    expect((await fetch(`${base}/api/sessions`, { headers: { cookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/ws-ticket`, { method: "POST", headers: { cookie } })).status).toBe(401);
  });

  test("oversized JSON bodies and cross-site requests are refused", async () => {
    const big = "x".repeat((1 << 20) + 10);
    expect((await fetch(`${base}/api/sessions/x/messages`, { method: "POST", headers: { ...root, "content-type": "application/json" }, body: big })).status).toBe(413);
    expect((await fetch(`${base}/api/sessions`, { headers: { ...root, "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });
});

test("a message to a working session waits as 'queued', and isn't called uncertain while it works", async () => {
  const r = rig();
  r.a.execution = "working";
  const m = await r.messenger.send({ sessionId: r.a.id, text: "next step", clientId: "q1" });
  r.messenger.sweep(Date.now() + 10 * 60_000);
  expect(r.store.outboxByClientId("q1")).toMatchObject({ state: "sending", detail: "queued" });
  // It finished working and went quiet without the message appearing: now it's in doubt.
  r.a.execution = "idle";
  r.a.lastActivityAt = Date.now();
  r.messenger.sweep(Date.now() + 10 * 60_000);
  expect(r.store.outboxByClientId("q1")!.state).toBe("uncertain");
  expect(m.id).toBeTruthy();
});
