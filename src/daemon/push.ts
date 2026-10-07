import type { Database } from "bun:sqlite";
import webpush, { type PushSubscription } from "web-push";
import type { NeedsYouItem } from "../shared/needs-you.ts";

type Send = (subscription: PushSubscription, payload: string) => Promise<unknown>;
type SubscriptionRow = { endpoint: string; data: string };

/** Restrict outbound requests to browser push services, never arbitrary/local HTTP endpoints. */
export function validSubscription(value: unknown): value is PushSubscription {
  const s = value as PushSubscription | null;
  if (!s || typeof s.endpoint !== "string" || !s.keys) return false;
  try {
    const u = new URL(s.endpoint);
    const host = u.hostname;
    const allowed = host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" || host.endsWith(".push.services.mozilla.com") || host === "web.push.apple.com" || host.endsWith(".push.apple.com") || host.endsWith(".notify.windows.com");
    return allowed && u.protocol === "https:" && !u.port && !u.username && !u.password && !u.hash &&
      typeof s.keys.p256dh === "string" && /^[\w-]{87}$/.test(s.keys.p256dh) &&
      typeof s.keys.auth === "string" && /^[\w-]{22}$/.test(s.keys.auth);
  } catch { return false; }
}

/** Persistent per-device delivery ledger. One alert per occurrence, including across restarts. */
export class NeedsYouPush {
  readonly publicKey: string;
  private send: Send;
  private active = new Map<string, NeedsYouItem>();
  private running: Promise<void> | null = null;
  private dirty = false;

  /**
   * subject: the VAPID contact sent to push services (generic by default, never this machine's name).
   * details: put the item's own text (which can hold commands and paths) in the notification body,
   * which then passes through the browser vendor's push service and shows on a lock screen. Off by
   * default: the body only says how many items need you, and opening it shows the rest.
   */
  constructor(private db: Database, subject: string, send?: Send, private opts: { details?: boolean } = {}) {
    db.exec(`CREATE TABLE IF NOT EXISTS push_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, owner TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS needs_you_occurrences (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_deliveries (endpoint TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY(endpoint, item));`);
    const saved = db.query("SELECT value FROM push_settings WHERE key='vapid'").get() as { value: string } | null;
    const keys = saved ? JSON.parse(saved.value) : webpush.generateVAPIDKeys();
    if (!saved) db.query("INSERT INTO push_settings VALUES ('vapid', ?)").run(JSON.stringify(keys));
    this.publicKey = keys.publicKey;
    this.send = send ?? ((subscription, payload) => webpush.sendNotification(subscription, payload, {
      vapidDetails: { subject, ...keys }, TTL: 3600, urgency: "high", timeout: 10_000,
    }));
  }

  subscribe(subscription: PushSubscription, owner: string | null) {
    if (!validSubscription(subscription)) throw new Error("Invalid browser push subscription");
    this.db.query("INSERT INTO push_subscriptions VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET owner=excluded.owner, data=excluded.data")
      .run(subscription.endpoint, owner, JSON.stringify(subscription));
  }
  unsubscribe(endpoint: string) { this.db.query("DELETE FROM push_subscriptions WHERE endpoint=?").run(endpoint); }
  revoke(owner?: string) {
    if (owner) this.db.query("DELETE FROM push_subscriptions WHERE owner=?").run(owner);
    else this.db.exec("DELETE FROM push_subscriptions");
  }

  sync(items: NeedsYouItem[]) {
    // Expiration does not stop an opted-in phone's background alerts. Explicit logout,
    // revoke-all, and a root-token rotation do revoke the associated subscription.
    this.db.exec("DELETE FROM push_subscriptions WHERE owner IN (SELECT hash FROM auth_sessions WHERE revoked=1)");
    this.active = new Map(items.map((i) => [i.id, i]));
    this.db.transaction(() => {
      const rows = this.db.query("SELECT id FROM needs_you_occurrences WHERE active=1").all() as { id: string }[];
      for (const { id } of rows) if (!this.active.has(id)) this.db.query("UPDATE needs_you_occurrences SET active=0 WHERE id=?").run(id);
      for (const i of items) this.db.query(`INSERT INTO needs_you_occurrences VALUES (?, 1, 1)
        ON CONFLICT(id) DO UPDATE SET generation=generation+CASE WHEN active=0 THEN 1 ELSE 0 END, active=1`).run(i.id);
    })();
    return this.flush();
  }

  flush(): Promise<void> {
    this.dirty = true;
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  private async drain() {
    while (this.dirty) {
      this.dirty = false;
      const subscriptions = this.db.query("SELECT endpoint, data FROM push_subscriptions").all() as SubscriptionRow[];
      for (const sub of subscriptions) for (const item of this.active.values()) {
        if (!this.active.has(item.id) || !this.db.query("SELECT 1 FROM push_subscriptions WHERE endpoint=?").get(sub.endpoint)) continue;
        const row = this.db.query("SELECT generation FROM needs_you_occurrences WHERE id=? AND active=1").get(item.id) as { generation: number } | null;
        if (!row) continue;
        const key = `${item.id}:${row.generation}`;
        if (this.db.query("SELECT 1 FROM push_deliveries WHERE endpoint=? AND item=?").get(sub.endpoint, key)) continue;
        try {
          const n = this.active.size;
          const body = this.opts.details ? item.summary.slice(0, 220) : `${n} item${n === 1 ? " needs" : "s need"} you`;
          await this.send(JSON.parse(sub.data), JSON.stringify({ id: key, itemId: item.id, title: "Switchboard · Needs you", body, url: item.sessionId ? `/#/s/${encodeURIComponent(item.sessionId)}` : "/" }));
          this.db.query("INSERT OR IGNORE INTO push_deliveries VALUES (?, ?)").run(sub.endpoint, key);
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) this.unsubscribe(sub.endpoint);
          else console.error(`[push] delivery failed (${status ?? "network error"}); will retry`);
        }
      }
    }
  }
}
