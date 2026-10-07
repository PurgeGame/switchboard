import type { AttentionItem } from "../../shared/types.ts";
import { getState, onNewAttention } from "./store.ts";

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

export function startNotifications() {
  onNewAttention((item) => {
    if (!URGENT_KINDS.has(item.kind) || item.meta.autoApproved || item.meta.autoPending) return;
    const { prefs } = getState();
    if (prefs.sound) playSound();
    // Phone notifications come only from server push, including while this tab is visible.
  });
}
