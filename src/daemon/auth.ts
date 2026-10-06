// Credentials and principals. Three kinds, each with its own reach:
// - root:        the bearer token in ~/.config/switchboard/token (CLI, hooks, scripts). Full API.
// - browser:     a random session secret in an HttpOnly cookie, minted from a one-time login code.
//                Only its SHA-256 is stored; it expires after 12h and can be revoked.
// - coordinator: a separate token for the coordinator's MCP proxy. It reaches only the
//                coordinator tool endpoints, never the human-control API.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./db.ts";

export type Principal = "root" | "browser" | "coordinator";

export const SESSION_COOKIE = "sb_session";
export const SESSION_TTL_MS = 12 * 3600_000;
const LOGIN_CODE_TTL_MS = 60_000;
const WS_TICKET_TTL_MS = 10_000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Single-use secrets with a short life (login codes, WebSocket tickets), each carrying a value
 * (a ticket carries the browser session it was issued to). Memory only, by design.
 */
class OneTime<V> {
  private items = new Map<string, { exp: number; value: V }>();
  constructor(private ttl: number) {}
  issue(value: V): string {
    const now = Date.now();
    for (const [k, it] of this.items) if (it.exp < now) this.items.delete(k);
    const v = randomBytes(24).toString("hex");
    this.items.set(v, { exp: now + this.ttl, value });
    return v;
  }
  /** Consumes the secret: a second use always fails. Returns undefined when invalid. */
  redeem(v: string): { value: V } | undefined {
    const it = this.items.get(v);
    this.items.delete(v);
    return it && it.exp >= Date.now() ? { value: it.value } : undefined;
  }
}

export class Auth {
  readonly loginCodes = new OneTime<true>(LOGIN_CODE_TTL_MS);
  /** Value: the hash of the browser session the ticket was issued to, or null for the root token. */
  readonly wsTickets = new OneTime<string | null>(WS_TICKET_TTL_MS);

  constructor(
    private store: Store,
    private rootToken: string,
    private coordinatorToken: string,
  ) {
    // A rotated root token retires every browser session from before. Sessions minted between
    // `sb rotate-token` and this restart (the old daemon still honored the old token) are included.
    const h = sha(rootToken);
    const prev = store.db.query("SELECT v FROM auth_meta WHERE k = 'root'").get() as { v: string } | null;
    if (prev?.v !== h) {
      store.db.query("UPDATE auth_sessions SET revoked = 1 WHERE revoked = 0").run();
      store.db.query("INSERT INTO auth_meta (k, v) VALUES ('root', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(h);
    }
  }

  /** Exchange a login code for a browser session. Returns the cookie secret, or null. */
  login(code: string): string | null {
    if (!code || !this.loginCodes.redeem(code)) return null;
    const secret = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.store.db.query("DELETE FROM auth_sessions WHERE expires_at < ? OR revoked = 1").run(now);
    this.store.db.query("INSERT INTO auth_sessions (hash, created_at, expires_at) VALUES (?, ?, ?)").run(sha(secret), now, now + SESSION_TTL_MS);
    return secret;
  }

  private sessionOk(secret: string): boolean {
    return this.sessionHashOk(sha(secret));
  }

  /** Is the browser session with this hash still valid (not revoked, not expired)? */
  sessionHashOk(hash: string): boolean {
    const r = this.store.db.query("SELECT expires_at, revoked FROM auth_sessions WHERE hash = ?").get(hash) as { expires_at: number; revoked: number } | null;
    return !!r && !r.revoked && r.expires_at > Date.now();
  }

  /** The hash of the caller's valid browser session, if any (what a WebSocket ticket is bound to). */
  sessionHash(req: Request): string | null {
    const secret = this.cookieSecret(req);
    return secret && this.sessionOk(secret) ? sha(secret) : null;
  }

  /** Revokes the session; returns its hash so its open sockets can be closed. */
  logout(secret: string): string {
    const hash = sha(secret);
    this.store.db.query("UPDATE auth_sessions SET revoked = 1 WHERE hash = ?").run(hash);
    return hash;
  }

  /** Sign every browser out. */
  revokeAll(): number {
    return Number(this.store.db.query("UPDATE auth_sessions SET revoked = 1 WHERE revoked = 0").run().changes);
  }

  cookieSecret(req: Request): string | null {
    const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9_-]+)`));
    return m?.[1] ?? null;
  }

  /** Who is calling. Bearer tokens win over cookies; a failed bearer never falls back. */
  principal(req: Request): Principal | null {
    const auth = req.headers.get("authorization");
    if (auth) {
      const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (safeEqual(given, this.rootToken)) return "root";
      if (safeEqual(given, this.coordinatorToken)) return "coordinator";
      return null;
    }
    const secret = this.cookieSecret(req);
    return secret && this.sessionOk(secret) ? "browser" : null;
  }
}

export const sessionCookie = (secret: string) => `${SESSION_COOKIE}=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
export const clearedCookie = () => `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

/** Routes the coordinator's credential may reach: its own tool surface, nothing else. */
export function coordinatorAllowed(method: string, parts: string[]): boolean {
  if (parts[1] !== "coordinator") return false;
  if (method === "GET") return parts.length === 3 && parts[2] === "tools";
  return method === "POST" && parts.length === 4 && parts[2] === "tool";
}
