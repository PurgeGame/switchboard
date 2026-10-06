import type { AttentionItem } from "../../shared/types.ts";
import { groupIdOf, subjectName } from "./attention.ts";
import { clip } from "./format.ts";
import { getState, onNewAttention, openGroup, openSession } from "./store.ts";

const NOTIFIED_KEY = "switchboard.notified";
const NOTIFIED_CAP = 500;

function alreadyNotified(id: number): boolean {
  try {
    return (JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "[]") as number[]).includes(id);
  } catch {
    return false;
  }
}

function rememberNotified(id: number) {
  try {
    const ids = (JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "[]") as number[]).concat(id).slice(-NOTIFIED_CAP);
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(ids));
  } catch {
    // Without storage, dedupe only holds until reload.
  }
}

let audio: AudioContext | null = null;

/** Must be called from a click handler the first time, so the browser allows audio. */
export function primeAudio() {
  audio ??= new AudioContext();
  void audio.resume();
}

function tone(freq: number, at: number) {
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  const t = audio.currentTime + at;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.06, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + 0.2);
}

/** Only these interrupt the user outside the page. Finished, conflict and stalled stay in the web UI. */
const URGENT_KINDS = new Set<AttentionItem["kind"]>(["question", "approval", "failed", "escalation"]);

function playSound() {
  tone(660, 0);
  tone(880, 0.17);
}

function showNotification(item: AttentionItem) {
  if (!document.hidden || Notification.permission !== "granted" || alreadyNotified(item.id)) return;
  const { sessions, groups } = getState();
  const n = new Notification(`${subjectName(item, sessions, groups)}: ${item.title}`, {
    body: item.text ? clip(item.text, 200) : undefined,
    tag: `switchboard-${item.id}`,
  });
  n.onclick = () => {
    window.focus();
    const gid = groupIdOf(item);
    if (gid) openGroup(gid);
    else openSession(item.sessionId);
    n.close();
  };
  rememberNotified(item.id);
}

export function startNotifications() {
  onNewAttention((item) => {
    if (!URGENT_KINDS.has(item.kind)) return;
    const { prefs } = getState();
    if (prefs.sound) playSound();
    if (prefs.notifications && "Notification" in window) showNotification(item);
  });
}
