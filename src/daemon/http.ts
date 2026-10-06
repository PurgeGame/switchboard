// HTTP + WebSocket API. Security (Codex runs danger-full-access, so anything that can
// message a session can run code on this machine):
// - binds 127.0.0.1 only
// - three principals (see auth.ts): root bearer (CLI/hooks), browser session (hashed, 12h, revocable,
//   minted from a single-use login code so no token ever lands in a URL), coordinator token (its tool
//   endpoints only). WebSockets need a single-use 10s ticket (or the root bearer).
// - body limit: 1 MB for JSON, 21 MB for image uploads; Sec-Fetch-Site must not be cross-site
// - Host and Origin are validated on every HTTP and WebSocket request (DNS rebinding, CSRF)
// - no CORS headers at all
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { Auth, clearedCookie, coordinatorAllowed, sessionCookie, type Principal } from "./auth.ts";
import type { CoordinatorAgentKind, ServerPush, SystemStats } from "../shared/types.ts";
import type { Store } from "./db.ts";
import type { Registry } from "./registry.ts";
import type { AttentionEngine } from "./attention.ts";
import { handleHook, preToolUse } from "./hooks.ts";
import type { PermissionBroker } from "./permissions.ts";
import { toolSummary } from "./adapters/parse-claude.ts";
import type { Coordination } from "./coordination.ts";
import type { Governor, Priority } from "./governor.ts";
import type { CoordinatorAgent } from "./coordinator/agent.ts";
import { SendError, type Messenger } from "./messaging.ts";
import type { CodexLive } from "./adapters/codex-live.ts";
import type { Uploads } from "./uploads.ts";
import { shq, type BridgeHub } from "./bridge.ts";
import type { AutoContinuer } from "./autocontinue.ts";
import type { Perspectives } from "./perspectives.ts";

/** Checkout commit at daemon start, so `sb doctor` can tell a stale daemon from the checkout. */
export const BUILD = {
  commit: (() => {
    const r = spawnSync("git", ["-C", join(import.meta.dir, "../.."), "rev-parse", "HEAD"], { encoding: "utf8", timeout: 2000 });
    return r.status === 0 ? r.stdout.trim() : null;
  })(),
  startedAt: Date.now(),
};

export interface HttpDeps {
  port: number;
  /** This machine's tailnet name, for phones and other devices via `tailscale serve` (null: loopback only). */
  remoteHost?: string | null;
  token: string;
  coordinatorToken: string;
  registry: Registry;
  store: Store;
  webDist: string;
  system: () => SystemStats | null;
  attention: AttentionEngine;
  messenger: Messenger;
  codexLive: CodexLive;
  uploads: Uploads;
  bridge: BridgeHub;
  auto: AutoContinuer;
  perspectives: Perspectives;
  coordination: Coordination;
  governor: Governor;
  /** Absent with coordinator.agent "none": every /api/coordinator* route is then a 404. */
  coordinator?: CoordinatorAgent;
  /** Which coordinator is configured (D34); tells the UI in the WS hello. Default "builtin". */
  coordinatorAgent?: CoordinatorAgentKind;
  permissions?: PermissionBroker;
}

const NO_COORDINATOR = { error: "no coordinator configured" };

const JSON_BODY_LIMIT = 1 << 20;
const UPLOAD_BODY_LIMIT = 21 << 20;

/** remote: this machine's own tailnet name, reached through `tailscale serve` (HTTPS on 443). */
export function allowedHost(host: string | null, port: number, remote?: string | null): boolean {
  if (remote && (host === remote || host === `${remote}:443`)) return true;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function allowedOrigin(origin: string | null, port: number, remote?: string | null): boolean {
  // Same-origin GETs from the browser may omit Origin; non-browser clients have none.
  if (remote && origin === `https://${remote}`) return true;
  return origin === null || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function startHttp(d: HttpDeps) {
  const sockets = new Set<any>();
  const auth = new Auth(d.store, d.token, d.coordinatorToken);
  /** Close UI sockets whose browser session matches (sid null = root-token socket). */
  const closeSockets = (match: (sid: string | null) => boolean) => {
    for (const ws of sockets)
      if (match(ws.data?.sid ?? null)) {
        sockets.delete(ws);
        ws.close(4401, "signed out");
      }
  };
  // Sessions also end by expiring: don't let an open socket outlive its session.
  const expirySweep = setInterval(() => closeSockets((sid) => sid !== null && !auth.sessionHashOk(sid)), 30_000);
  expirySweep.unref?.();
  d.registry.onPush((m) => {
    const s = JSON.stringify(m);
    for (const ws of sockets) ws.send(s);
  });

  const server = Bun.serve<{ sid: string | null }, never>({
    hostname: "127.0.0.1",
    port: d.port,
    maxRequestBodySize: UPLOAD_BODY_LIMIT,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (!allowedHost(req.headers.get("host"), d.port, d.remoteHost)) return new Response("bad host", { status: 421 });
      if (!allowedOrigin(req.headers.get("origin"), d.port, d.remoteHost)) return new Response("bad origin", { status: 403 });
      const site = req.headers.get("sec-fetch-site");
      // Except opening a login link: it comes from elsewhere by design (a phone's camera), and its single-use code is the credential.
      const loginNav = url.pathname === "/auth" && req.method === "GET" && req.headers.get("sec-fetch-mode") === "navigate";
      if ((site === "cross-site" || site === "same-site") && !loginNav) return new Response("cross-site request refused", { status: 403 });

      // Login: /auth?code=<single-use code from POST /api/login-code> starts a browser session.
      // The cookie holds a random secret (only its hash is stored), never the root token.
      if (url.pathname === "/auth") {
        const secret = auth.login(url.searchParams.get("code") ?? "");
        if (!secret) return new Response("Login link expired. Run `sb open` again.", { status: 401 });
        // A page that navigates itself rather than a 302: a link opened from another app (a phone's camera)
        // is a cross-site navigation, so a SameSite=Strict cookie isn't sent on its redirect. Keeps #/s/<id>.
        const nonce = randomBytes(16).toString("base64url");
        return new Response(
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Switchboard</title><script nonce="${nonce}">location.replace("/" + location.hash)</script><noscript><a href="/">Open Switchboard</a></noscript>`,
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
              "referrer-policy": "no-referrer",
              "set-cookie": sessionCookie(secret),
            },
          },
        );
      }
      if (url.pathname === "/api/health") return json({ ok: true, commit: BUILD.commit, startedAt: BUILD.startedAt });

      // WebSocket: a single-use ticket from POST /api/ws-ticket, or the root bearer. Cookies alone don't open one.
      if (url.pathname === "/api/ws") {
        // A socket remembers the browser session behind its ticket, so revoking or expiring that
        // session closes it (null = opened with the root token).
        const ticket = url.searchParams.get("ticket");
        const t = ticket ? auth.wsTickets.redeem(ticket) : auth.principal(req) === "root" ? { value: null } : undefined;
        if (!t || (t.value !== null && !auth.sessionHashOk(t.value))) return json({ error: "unauthorized" }, 401);
        if (srv.upgrade(req, { data: { sid: t.value } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }

      const who = auth.principal(req);
      if (url.pathname.startsWith("/api/")) {
        if (!who) return json({ error: "unauthorized" }, 401);
        const parts = url.pathname.split("/").filter(Boolean);
        if (who === "coordinator" && !coordinatorAllowed(req.method, parts)) return json({ error: "the coordinator credential can't use this endpoint" }, 403);
        const len = Number(req.headers.get("content-length") ?? 0);
        const isUpload = parts[1] === "uploads" && parts.length === 2;
        if (len > (isUpload ? UPLOAD_BODY_LIMIT : JSON_BODY_LIMIT)) return json({ error: "request body too large" }, 413);
        return api(req, url, srv, who) as any;
      }
      // Static UI is for people only. Unauthenticated visitors get a short page explaining how to log in.
      if (who !== "browser" && who !== "root") return new Response("Switchboard: run `sb open` to log in.", { status: 401, headers: { "content-type": "text/plain" } });
      return serveStatic(d.webDist, url.pathname);
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        const hello: ServerPush = {
          type: "hello",
          sessions: d.registry.list(),
          system: d.system(),
          attention: d.attention.open(),
          groups: d.perspectives.list(),
          coordinatorAgent: d.coordinator ? (d.coordinatorAgent ?? d.coordinator.kind) : "none",
        };
        ws.send(JSON.stringify(hello));
      },
      close(ws) {
        sockets.delete(ws);
      },
      message() {
        // UI sockets are server -> client only.
      },
    },
  });

  async function api(req: Request, url: URL, srv: any, who: Principal): Promise<Response | undefined> {
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    if (req.method === "POST") {
      // Only the root token (the CLI) mints login links; a browser session can't extend itself.
      if (parts[1] === "login-code") {
        if (who !== "root") return json({ error: "login links come from `sb open` / `sb login`" }, 403);
        const code = auth.loginCodes.issue(true);
        // Same single-use code; remoteUrl is for a phone or other device on the tailnet.
        return json({ code, url: `http://127.0.0.1:${d.port}/auth?code=${code}`, remoteUrl: d.remoteHost ? `https://${d.remoteHost}/auth?code=${code}` : null });
      }
      if (parts[1] === "ws-ticket") {
        if (who !== "browser" && who !== "root") return json({ error: "forbidden" }, 403);
        return json({ ticket: auth.wsTickets.issue(who === "browser" ? auth.sessionHash(req) : null) });
      }
      if (parts[1] === "auth" && parts[2] === "logout") {
        const secret = auth.cookieSecret(req);
        if (secret) {
          // Revoke first, unconditionally; then close any sockets that session still has open.
          const hash = auth.logout(secret);
          closeSockets((sid) => sid === hash);
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": clearedCookie() } });
      }
      if (parts[1] === "auth" && parts[2] === "revoke-all") {
        const revoked = auth.revokeAll();
        closeSockets((sid) => sid !== null);
        return json({ ok: true, revoked });
      }
      // Hook receiver: /api/hook/<provider>/<event>, body = the hook's stdin JSON.
      if (parts[1] === "hook" && parts.length === 4) {
        const payload = await req.json().catch(() => null);
        if (!payload || typeof payload !== "object") return json({ error: "bad payload" }, 400);
        if (parts[2] === "claude" && parts[3] === "PreToolUse") {
          const out = preToolUse(payload, d.registry, d.coordination, []);
          return out ? json(out) : new Response("", { status: 200 });
        }
        handleHook(parts[2], parts[3], payload, d.registry, d.attention);
        // The blocking variant (scripts/sb-permission.sh): decide, or hold for the human, then
        // answer the hook. An empty reply lets the session's own terminal dialog appear.
        if (parts[2] === "claude" && parts[3] === "PermissionRequest" && url.searchParams.get("wait") === "1" && d.permissions && typeof payload.session_id === "string") {
          // A session Switchboard doesn't know yet can't be shown to you: let its terminal ask.
          if (!d.registry.sessions.has(`claude:${payload.session_id}`)) return new Response("", { status: 200 });
          srv.timeout(req, 0); // held for minutes: no idle timeout on this request
          const tool = String(payload.tool_name ?? "tool");
          const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
          const desc = typeof input.description === "string" ? `${input.description}\n` : "";
          const out = await d.permissions.claudeHook(
            { sessionId: `claude:${payload.session_id}`, provider: "claude", tool, input, summary: `${desc}${toolSummary(tool, input).summary}`, cwd: typeof payload.cwd === "string" ? payload.cwd : null },
            req.signal,
          );
          return out ? json(out) : new Response("", { status: 200 });
        }
        return json({ ok: true });
      }
      if (parts[1] === "uploads" && parts.length === 2) {
        const bytes = new Uint8Array(await req.arrayBuffer());
        try {
          return json(d.uploads.save(bytes, req.headers.get("content-type") ?? ""));
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }
      if (parts[1] === "sessions" && parts.length === 4 && parts[3] === "end") {
        try {
          const r = await d.messenger.end(decodeURIComponent(parts[2]));
          return json(r, r.ok ? 200 : 409);
        } catch (e) {
          if (e instanceof SendError) return json({ error: e.message }, e.status);
          throw e;
        }
      }
      if (parts[1] === "sessions" && parts.length === 4 && (parts[3] === "messages" || parts[3] === "interrupt")) {
        const sessionId = decodeURIComponent(parts[2]);
        try {
          if (parts[3] === "interrupt") return json(await d.messenger.interrupt(sessionId));
          const body = (await req.json().catch(() => null)) as any;
          if (!body || typeof body.text !== "string") return json({ error: "text required" }, 400);
          const m = await d.messenger.send({
            sessionId,
            text: body.text,
            images: Array.isArray(body.images) ? body.images.filter((x: unknown) => typeof x === "string") : [],
            clientId: typeof body.clientId === "string" ? body.clientId.slice(0, 100) : undefined,
            mode: ["auto", "steer", "queue"].includes(body.mode) ? body.mode : "auto",
            method: typeof body.method === "string" ? body.method : undefined,
            switchMethod: body.switchMethod === true,
            author: "human",
          });
          return json(m);
        } catch (e) {
          if (e instanceof SendError) return json({ error: e.message, ...e.extra }, e.status);
          throw e;
        }
      }
      if (parts[1] === "sessions" && parts.length >= 4 && ["typing", "auto-cancel", "prefs"].includes(parts[3])) {
        const sid = decodeURIComponent(parts[2]);
        if (!d.registry.sessions.has(sid)) return json({ error: "not found" }, 404);
        if (parts[3] === "typing") {
          d.auto.noteTyping(sid);
          return json({ ok: true });
        }
        if (parts[3] === "auto-cancel") return json({ ok: d.auto.cancel(sid, "cancelled by you") });
        const body = (await req.json().catch(() => null)) as any;
        if (typeof body?.autoContinue === "boolean")
          d.registry.update(sid, (s) => {
            s.meta.autoContinueOff = !body.autoContinue;
          });
        return json({ ok: true });
      }
      if (parts[1] === "sessions" && parts.length === 4 && parts[3] === "show") {
        const s = d.registry.sessions.get(decodeURIComponent(parts[2]));
        if (!s) return json({ error: "not found" }, 404);
        // Bring that VS Code window to the front first (`code <folder>` focuses the window that has
        // it open), then reveal the terminal inside it. Without this, show() can happen in a window
        // that's behind the browser and look like nothing happened.
        const folder = (s.meta.terminal as { windowFolders?: string[] } | null)?.windowFolders?.[0];
        if (folder) spawnSync("code", [folder], { timeout: 5000, stdio: "ignore" });
        const r = await d.bridge.show(s);
        return json(r, r.ok ? 200 : 409);
      }
      if (parts[1] === "terminals" && parts.length === 4 && parts[3] === "raw") {
        const body = (await req.json().catch(() => null)) as any;
        if (typeof body?.text !== "string" || body.text.length > 200) return json({ error: "text (max 200 chars) required" }, 400);
        const r = await d.bridge.sendRaw(decodeURIComponent(parts[2]), body.text);
        return json(r, r.ok ? 200 : 409);
      }
      if (parts[1] === "perspectives") {
        const body = ((await req.json().catch(() => null)) ?? {}) as any;
        const images = Array.isArray(body.images) ? body.images.filter((p: unknown) => typeof p === "string" && d.uploads.owns(p)) : [];
        try {
          if (parts.length === 2) {
            if (typeof body.prompt !== "string" || !body.prompt.trim()) return json({ error: "prompt required" }, 400);
            if (typeof body.cwd !== "string" || !body.cwd.startsWith("/")) return json({ error: "absolute cwd required" }, 400);
            const members = (Array.isArray(body.members) ? body.members : []).filter(
              (m: any) => (m?.kind === "new" && ["claude", "codex"].includes(m.provider)) || (m?.kind === "existing" && d.registry.sessions.has(m.sessionId)),
            );
            if (members.length < 1) return json({ error: "at least one member" }, 400);
            return json(await d.perspectives.create(body.prompt.trim(), images, body.cwd, members));
          }
          const id = parts[2];
          switch (parts[3]) {
            case "synthesize":
              return json(await d.perspectives.synthesize(id, typeof body.model === "string" && /^[\w.:-]{1,40}$/.test(body.model) ? body.model : undefined));
            case "cross-review":
              return json(await d.perspectives.crossReview(id));
            case "follow-up":
              if (typeof body.text !== "string" || !body.text.trim()) return json({ error: "text required" }, 400);
              return json(await d.perspectives.followUp(id, body.text.trim(), images));
            case "confirm":
              return json(d.perspectives.confirm(id));
            case "dismiss":
              d.perspectives.dismiss(id);
              return json({ ok: true });
          }
        } catch (e) {
          return json({ error: (e as Error).message }, 409);
        }
        return json({ error: "not found" }, 404);
      }
      if (parts[1] === "coordinator") {
        if (!d.coordinator) return json(NO_COORDINATOR, 404);
        const co = d.coordinator;
        // An external agent waiting for the next event (get_updates waitSeconds, at most 50 s).
        if (parts[2] === "tool" && parts[3] === "get_updates") srv.timeout(req, 0);
        const body = ((await req.json().catch(() => null)) ?? {}) as any;
        try {
          if (parts[2] === "mode") return co.setMode(body.mode), json(co.state());
          if (parts[2] === "chat") {
            const images = Array.isArray(body.images) ? body.images.filter((p: unknown): p is string => typeof p === "string" && d.uploads.owns(p)) : [];
            const r = co.userChat(String(body.text ?? ""), images);
            return json(r, r.ok ? 200 : 409);
          }
          // POST /api/coordinator/plans/:proposalId/tasks/:key/retry (you, not the coordinator's token)
          if (parts[2] === "plans" && parts[4] === "tasks" && parts[6] === "retry") {
            const r = co.retryPlanTask(Number(parts[3]), decodeURIComponent(parts[5]));
            return json(r, r.ok ? 200 : 409);
          }
          if (parts[2] === "exclude") return co.setExcluded(String(body.sessionId), !!body.excluded), json(co.state());
          if (parts[2] === "autopilot") return co.setAutopilot(String(body.sessionId), !!body.enabled), json(co.state());
          if (parts[2] === "proposals" && parts[4] === "approve") return json(await co.approve(Number(parts[3]), { digest: typeof body.digest === "string" ? body.digest : undefined }));
          if (parts[2] === "proposals" && parts[4] === "reject") return json(co.reject(Number(parts[3]), String(body.note ?? "")));
          if (parts[2] === "tool" && parts[3]) return json(await co.callTool(decodeURIComponent(parts[3]), body));
        } catch (e) {
          return json({ error: (e as Error).message }, 409);
        }
        return json({ error: "not found" }, 404);
      }
      // p1/authority — human routes; auth principal gate is owned by delivery/auth.
      if (["objectives", "tasks", "claims", "conflicts"].includes(parts[1])) {
        const body = ((await req.json().catch(() => null)) ?? {}) as any;
        const c = d.coordination;
        c.session = (id) => d.registry.sessions.get(id);
        try {
          if (parts[1] === "objectives" && parts.length === 2) {
            if (["grant", "granted", "root", "issuedBy"].some(k => k in body)) throw Error("Create an ungranted objective, then use the human grant route");
            return json(c.createObjective(String(body.title ?? "").slice(0, 200), String(body.description ?? ""), body.priority, "human"));
          }
          if (parts[1] === "objectives" && parts.length === 4 && ["grant", "revoke"].includes(parts[3])) {
            const o = parts[3] === "grant" ? c.grantObjective(parts[2], { root: body.root, resources: body.resources, verification: body.verification }, "human") : c.revokeObjective(parts[2], "human");
            d.coordinator?.onHumanGrantChange(o.id);
            return json(o);
          }
          if (parts[1] === "tasks" && parts.length === 2) {
            const t = c.createTask({ ...body, title: String(body.title ?? "").slice(0, 200) }, "human");
            d.coordinator?.enqueue({ kind: "user_edit", sessionId: t.owner, text: `The human created task ${t.id}. Read its grant, scope and prerequisites before acting.` });
            return json(t);
          }
          if (parts[1] === "tasks" && parts.length === 3) {
            const prevOwner = c.task(parts[2])?.owner ?? null;
            const t = c.updateTask(parts[2], body, "human");
            d.coordinator?.onHumanTaskEdit(t, prevOwner);
            return json(t);
          }
          // p1/fixes — human-only launch reservation inspection and recovery.
          if (parts[1] === "tasks" && parts[3] === "reservation" && parts[4] === "clear" && req.method === "POST") {
            const as = body.as,
              sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
            return json(d.coordinator ? d.coordinator.clearReservation(parts[2], as, sessionId) : c.clearReservation(parts[2], { as, sessionId }, "human"));
          }
          if (parts[1] === "tasks" && parts[3] === "evidence") return json(c.recordEvidence(parts[2], "human", String(body.text ?? ""), { criterion: body.criterion, sourceId: body.sourceId }));
          if (parts[1] === "claims" && parts.length === 2) {
            if (!d.registry.sessions.has(String(body.owner))) throw Error("Claim owner session missing");
            return json(c.claim(String(body.owner), String(body.resource), { taskId: body.taskId, exclusive: body.exclusive, note: body.note }));
          }
          if (parts[1] === "claims" && parts[3] === "release") return json(c.release(Number(parts[2]), "human"));
          if (parts[1] === "conflicts" && parts[3] === "resolve") return json((c.resolveConflict(decodeURIComponent(parts[2])), { ok: true }));
        } catch (e) { return json({ error: (e as Error).message }, 409); }
        return json({ error: "not found" }, 404);
      }
      // end p1/authority

      if (parts[1] === "governor") {
        const body = ((await req.json().catch(() => null)) ?? {}) as any;
        const g = d.governor;
        if (parts[2] === "game") g.setGameManual(body.on === null ? null : !!body.on);
        else if (parts[2] === "priority" && ["protected", "high", "normal", "low"].includes(body.priority)) g.setPriority(String(body.sessionId), body.priority as Priority);
        else if (parts[2] === "throttle") return json({ ok: g.throttle(String(body.sessionId), body.level === 2 ? 2 : 1, "by you") });
        else if (parts[2] === "restore") g.restore(String(body.sessionId), "by you");
        else return json({ error: "not found" }, 404);
        return json(g.snapshot());
      }
      if (parts[1] === "launch") {
        const body = (await req.json().catch(() => null)) as any;
        const provider = body?.provider;
        const cwd = typeof body?.cwd === "string" ? body.cwd : "";
        if (!["claude", "codex"].includes(provider) || !cwd.startsWith("/")) return json({ error: "provider (claude|codex) and an absolute cwd are required" }, 400);
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : `${provider}-${new Date().toTimeString().slice(0, 5)}`;
        const model = typeof body.model === "string" && /^[\w.:-]{1,60}$/.test(body.model) ? body.model : null;
        // Codex: never pass -c/--enable/--disable, which would force embedded mode (off the shared daemon).
        const command =
          provider === "claude" ? `claude -n ${shq(name)}${model ? ` --model ${shq(model)}` : ""}` : `codex${model ? ` -m ${shq(model)}` : ""}`;
        const r = await d.bridge.launch(cwd, name, command);
        return json(r, r.ok ? 200 : 409);
      }
      if (parts[1] === "attention" && parts[3] === "answer") {
        const item = d.store.getAttention(Number(parts[2]));
        const body = (await req.json().catch(() => null)) as any;
        const decision = body?.decision;
        if (!item || item.status !== "open") return json({ error: "not an open item" }, 404);
        if (item.kind !== "approval" || typeof item.meta.answerKey !== "string") return json({ error: "this approval can only be answered in its session" }, 409);
        if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return json({ error: "bad decision" }, 400);
        // A Claude prompt held by the PermissionRequest hook: the answer goes back through the hook.
        if (item.meta.answerKey.startsWith("claude-hook:")) {
          if (!d.permissions?.answer(item.meta.answerKey, decision)) return json({ error: "that prompt is no longer waiting here: answer it in the session" }, 409);
          d.attention.markAnsweredHere(item.id);
          return json({ ok: true });
        }
        try {
          // Approvals answered here go over the daemon: that must be the session's control path.
          if (item.sessionId) d.messenger.acquire(item.sessionId, "codex-daemon");
          d.codexLive.answer(item.meta.answerKey, decision);
          d.attention.markAnsweredHere(item.id);
          return json({ ok: true });
        } catch (e) {
          return json({ error: (e as Error).message }, 409);
        }
      }
      // The human settles an uncertain delivery: POST /api/outbox/:id/resolve {as: "delivered" | "not_delivered"}
      if (parts[1] === "outbox" && parts.length === 4 && parts[3] === "resolve") {
        const body = (await req.json().catch(() => null)) as any;
        if (body?.as !== "delivered" && body?.as !== "not_delivered") return json({ error: "as must be delivered or not_delivered" }, 400);
        try {
          return json(d.messenger.resolve(Number(parts[2]), body.as));
        } catch (e) {
          if (e instanceof SendError) return json({ error: e.message, ...e.extra }, e.status);
          throw e;
        }
      }
      if (parts[1] === "attention" && parts[3] === "ack") {
        const r = d.attention.acknowledge(Number(parts[2]));
        return json(r, r.ok ? 200 : r.error === "not found" ? 404 : 409);
      }
      return json({ error: "not found" }, 404);
    }
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    if (parts[1] === "attention") return json(url.searchParams.get("all") ? d.store.recentAttention(200) : d.attention.open());
    if (parts[1] === "sessions" && parts.length === 2) return json(d.registry.list());
    if (parts[1] === "uploads" && parts.length === 3) {
      const f = join(d.uploads.dir, parts[2]);
      if (!d.uploads.owns(f)) return json({ error: "not found" }, 404);
      return new Response(Bun.file(f), { headers: { "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" } });
    }
    if (parts[1] === "sessions" && parts.length >= 3) {
      const id = decodeURIComponent(parts[2]);
      const s = d.registry.sessions.get(id);
      if (!s) return json({ error: "not found" }, 404);
      if (parts[3] === "outbox") return json(d.store.outboxFor(id));
      if (parts[3] === "events") {
        const before = url.searchParams.get("before");
        const limit = url.searchParams.get("limit");
        return json(d.store.events(id, { beforeId: before ? +before : undefined, limit: limit ? +limit : undefined }));
      }
      return json(s);
    }
    if (parts[1] === "system") return json(d.system());
    if (parts[1] === "bridge") return json(d.bridge.status());
    if (parts[1] === "perspectives") return json(d.perspectives.list());
    if (parts[1] === "coordination") return json({ ...d.coordination.snapshot(), reservations: d.coordination.reservations() });
    // p1/fixes — human inspection of a task's launch reservation (clear it with POST …/reservation/clear).
    if (parts[1] === "tasks" && parts.length === 4 && parts[3] === "reservation") return json({ reservation: d.coordination.reservation(parts[2]) });
    if (parts[1] === "coordinator") {
      if (!d.coordinator) return json(NO_COORDINATOR, 404);
      if (parts[2] === "tools") return json(d.coordinator.tools());
      if (!parts[2]) return json(d.coordinator.state());
    }
    if (parts[1] === "governor") return json(d.governor.snapshot());
    return json({ error: "not found" }, 404);
  }

  return { server, broadcast: (m: ServerPush) => sockets.forEach((ws) => ws.send(JSON.stringify(m))) };
}

// Defense in depth for the UI: even if transcript HTML slipped past sanitization, no
// injected script could run or exfiltrate. Inline *styles* are allowed (React style props).
const UI_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

function serveStatic(root: string, pathname: string): Response {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let f = join(root, rel);
  if (!f.startsWith(root)) return new Response("forbidden", { status: 403 });
  if (!existsSync(f) || statSync(f).isDirectory()) f = join(root, "index.html"); // SPA fallback
  if (!existsSync(f)) return new Response("UI not built. Run `bun run build`.", { status: 503 });
  // index.html must never be cached (it names the current hashed bundles); bundles are immutable.
  const cache = f.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  return new Response(Bun.file(f), { headers: { ...UI_HEADERS, "cache-control": cache } });
}
