/* Push runs without a page or a WebSocket. Never cache authenticated UI or transcripts. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function once(id) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("switchboard-push", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("seen");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("seen", "readwrite");
      const store = tx.objectStore("seen");
      const get = store.get(id);
      let fresh = false;
      get.onsuccess = () => { fresh = !get.result; if (fresh) store.put(true, id); };
      tx.oncomplete = () => { db.close(); resolve(fresh); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

async function clearResolved(ids) {
  for (const n of await self.registration.getNotifications()) {
    if (n.data?.itemId && !ids.includes(n.data.itemId)) n.close();
  }
}
self.addEventListener("message", (event) => {
  if (event.data?.type === "needs-you") event.waitUntil((async () => {
    // The page may still be loading coordinator/tasks after reconnect. Reconcile against the
    // daemon, not a transient empty client snapshot, before dismissing phone notifications.
    try {
      const r = await fetch("/api/needs-you", { cache: "no-store" });
      if (r.ok) await clearResolved(await r.json());
    } catch {}
  })());
});
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const data = event.data?.json();
    if (!data?.id || !data.itemId) return;
    // A delivery can arrive after its action was answered on another device.
    try {
      const r = await fetch("/api/needs-you", { cache: "no-store" });
      if (r.ok) {
        const ids = await r.json();
        await clearResolved(ids);
        if (!ids.includes(data.itemId)) return;
      }
    } catch { /* Offline / expired login: the push payload still works. */ }
    if (!await once(data.id)) return;
    await self.registration.showNotification(data.title, { body: data.body, tag: data.id, icon: "/icon-192.png", data: { itemId: data.itemId, url: data.url } });
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(event.notification.data?.url || "/", self.location.origin);
    if (url.origin !== self.location.origin) return;
    for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
      if (new URL(client.url).origin === url.origin) {
        await client.navigate(url.href);
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(url.href);
  })());
});
