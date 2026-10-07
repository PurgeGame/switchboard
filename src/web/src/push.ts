import { setPrefs } from "./store.ts";

async function request(path: string, body?: unknown) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(r.status === 401 ? "Sign in again with sb open, then enable notifications." : `Notifications: ${r.status}`);
  return r.json();
}
export async function enablePhoneNotifications() {
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    throw new Error("Open Switchboard over HTTPS. On iPhone, add it to your Home Screen and open it there first.");
  }
  // Ask directly in the click handler, before any network work (Safari's user gesture requirement).
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Allow notifications for Switchboard in your browser settings, then try again.");
  await navigator.serviceWorker.register("/sw.js");
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await request("/api/push/key");
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await request("/api/push/subscribe", subscription.toJSON());
  setPrefs({ notifications: true });
}
export async function disablePhoneNotifications() {
  const registration = await navigator.serviceWorker?.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await request("/api/push/unsubscribe", { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  }
  setPrefs({ notifications: false });
}

/** Restore an existing subscription on reconnect, without ever requesting permission on load. */
export async function restorePhoneNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription && Notification.permission === "granted") {
      await request("/api/push/subscribe", subscription.toJSON());
      setPrefs({ notifications: true });
    } else setPrefs({ notifications: false });
  } catch { /* The enable button and connection status allow retry after sign-in. */ }
}
