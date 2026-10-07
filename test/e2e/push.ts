#!/usr/bin/env bun
// Real Chromium service worker + notification API. Push transport/subscription is simulated;
// no messages leave this machine and no live daemon, provider or phone subscription is touched.
import { chromium } from "playwright-core";
import { join } from "node:path";
import webpush from "web-push";

const root = join(import.meta.dir, "../..");
let active = ["proposal:42", "review:task"];
let subscriptions = 0;
let unsubscriptions = 0;
let pushUI = (_value: unknown) => {};
const keys = webpush.generateVAPIDKeys();
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req, srv) {
    const p = new URL(req.url).pathname;
    if (p === "/api/ws" && srv.upgrade(req)) return;
    if (p === "/api/push/subscribe") { subscriptions++; return Response.json({ ok: true }); }
    if (p === "/api/push/unsubscribe") { unsubscriptions++; return Response.json({ ok: true }); }
    if (p.startsWith("/api/")) return Response.json(
      p === "/api/push/key" ? { publicKey: keys.publicKey } :
      p === "/api/needs-you" ? active :
      p === "/api/ws-ticket" ? { ticket: "test" } :
      p === "/api/coordination" ? { objectives: [], tasks: [], claims: [], conflicts: [] } :
      p === "/api/usage" ? { ts: Date.now(), claude: { available: false, windows: [] }, codex: { available: false, windows: [] } } :
      p === "/api/governor" ? { sessions: [], log: [] } : []);
    const file = Bun.file(join(root, "dist/web", p === "/" ? "index.html" : p));
    if (!await file.exists()) return new Response("Not found", { status: 404 });
    return new Response(file, { headers: { "cache-control": "no-store" } });
  },
  websocket: { open(ws) { pushUI = (value) => ws.send(JSON.stringify(value)); ws.send(JSON.stringify({ type: "hello", sessions: [], attention: [], groups: [], system: null, coordinatorAgent: "none" })); }, message() {} },
});
const base = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const eventually = async (predicate: () => Promise<boolean>, label = "notification state did not settle") => {
  for (let n = 0; n < 150; n++) { if (await predicate()) return; await Bun.sleep(20); }
  throw new Error(label);
};
const check = (name: string, ok: boolean) => { if (!ok) throw new Error(name); console.log(`PASS  ${name}`); };
try {
  const context = await browser.newContext({ permissions: ["notifications"], viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    // Only the push-service handshake is fake; registration, worker lifecycle, IndexedDB,
    // showNotification, getNotifications and background delivery are real browser APIs.
    const value = { endpoint: "https://fcm.googleapis.com/fcm/send/test", keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) } };
    let subscribed = false;
    const sub = { toJSON: () => value, endpoint: value.endpoint, unsubscribe: async () => { subscribed = false; return true; } };
    PushManager.prototype.getSubscription = async () => subscribed ? sub as unknown as PushSubscription : null;
    PushManager.prototype.subscribe = async () => { subscribed = true; return sub as unknown as PushSubscription; };
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await context.newCDPSession(page);
  let registration = "";
  cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
    for (const r of registrations) if (r.scopeURL === `${base}/`) registration = r.registrationId;
  });
  await cdp.send("ServiceWorker.enable");
  await page.goto(base);
  await page.getByRole("button", { name: /^Inbox,/ }).click();
  await page.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await page.getByText("Notifications on").waitFor();
  check("one enable button registers the service worker and saves the subscription", subscriptions === 1);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  for (let n = 0; n < 100 && !registration; n++) await Bun.sleep(20);
  check("service worker registered", !!registration);
  const deliver = (id: string, itemId = "proposal:42") => cdp.send("ServiceWorker.deliverPushMessage", { origin: base, registrationId: registration, data: JSON.stringify({ id, itemId, title: "Switchboard · Needs you", body: "Decide: test proposal", url: "/#/s/worker" }) });
  const count = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length);
  await deliver("proposal:42:1");
  await eventually(async () => await count() === 1);
  check("push displays a notification with an active page", await count() === 1);
  await page.evaluate(async () => { for (const n of await (await navigator.serviceWorker.ready).getNotifications()) n.close(); });
  await deliver("proposal:42:1");
  await Bun.sleep(300);
  check("duplicate delivery does not redisplay a dismissed notification", await count() === 0);
  await page.getByRole("button", { name: "Close inbox" }).click();
  const attention = { id: 42, sessionId: "coordinator", kind: "escalation", status: "open", title: "Check the result", text: "Check the result", meta: {}, createdAt: Date.now() };
  active.push("attention:42");
  pushUI({ type: "attention", item: attention });
  await page.getByRole("button", { name: "Inbox, 1 item needs you", exact: true }).waitFor();
  // Seed this notification directly: push delivery is covered above; this check isolates
  // the page-to-worker cleanup when an attention item resolves with the inbox unmounted.
  await page.evaluate(async () => (await navigator.serviceWorker.ready).showNotification("Check the result", { tag: "attention:42:1", data: { itemId: "attention:42" } }));
  await eventually(async () => await count() === 1, "closed-inbox notification did not appear");
  active = active.filter((id) => id !== "attention:42");
  pushUI({ type: "attention", item: { ...attention, status: "resolved", resolvedAt: Date.now() } });
  await eventually(async () => await count() === 0, "closed-inbox notification did not clear");
  check("resolved notifications close while the inbox remains closed", await page.getByRole("complementary", { name: "Attention inbox" }).count() === 0);
  // A second page can inspect notifications after the app itself has closed.
  const monitor = await context.newPage();
  monitor.on("pageerror", (e) => errors.push(e.message));
  await monitor.goto(`${base}/manifest.webmanifest`);
  await page.close();
  const monitorCdp = await context.newCDPSession(monitor);
  await monitorCdp.send("ServiceWorker.enable");
  await monitorCdp.send("ServiceWorker.deliverPushMessage", { origin: base, registrationId: registration, data: JSON.stringify({ id: "review:task:1", itemId: "review:task", title: "Switchboard · Needs you", body: "Review: completed task", url: "/" }) });
  await eventually(() => monitor.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length === 1));
  check("push displays after the app page closes", true);
  active = [];
  await monitor.evaluate(() => navigator.serviceWorker.controller?.postMessage({ type: "needs-you", ids: [] }));
  await eventually(() => monitor.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length === 0));
  check("resolved notifications close", true);
  await monitorCdp.send("ServiceWorker.deliverPushMessage", { origin: base, registrationId: registration, data: JSON.stringify({ id: "proposal:42:2", itemId: "proposal:42", title: "stale", body: "already resolved", url: "/" }) });
  await Bun.sleep(300);
  check("late push for a resolved item stays silent", await monitor.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length === 0));
  await monitor.goto(base);
  await monitor.getByRole("button", { name: /^Inbox,/ }).click();
  await monitor.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await monitor.getByText("Notifications on").waitFor();
  await monitor.getByRole("button", { name: "Disable phone notifications", exact: true }).click();
  await monitor.getByRole("button", { name: "Enable notifications", exact: true }).waitFor();
  check("disable removes the server subscription", unsubscriptions === 1);
  check("no browser runtime errors", errors.length === 0);
} finally {
  await browser.close();
  server.stop(true);
}
