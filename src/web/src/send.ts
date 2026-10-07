import type { SendMethod } from "../../shared/types.ts";

export const METHOD_LABEL: Record<SendMethod, string> = {
  "codex-daemon": "Codex · native",
  terminal: "via terminal",
  peer: "peer message: the agent is told it's not from you",
  stdin: "via stdin",
};

export const METHOD_SHORT: Record<SendMethod, string> = {
  "codex-daemon": "Codex · native",
  terminal: "via terminal",
  peer: "peer message",
  stdin: "via stdin",
};

/** These methods can only reference images by file path. */
export const sendsImagesAsPath = (m: SendMethod) => m === "peer" || m === "terminal";

interface Draft {
  text: string;
  images: string[];
}

const key = (k: string) => `switchboard.draft.${k}`;

export function loadDraft(k: string): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(key(k)) ?? "null") as Draft | null;
    return { text: d?.text ?? "", images: d?.images ?? [] };
  } catch {
    return { text: "", images: [] };
  }
}

export function saveDraft(k: string, d: Draft) {
  try {
    if (!d.text && d.images.length === 0) localStorage.removeItem(key(k));
    else localStorage.setItem(key(k), JSON.stringify(d));
  } catch {
    // Drafts then last for this page only.
  }
}

const composers = new Map<string, HTMLTextAreaElement>();

export function registerComposer(k: string, el: HTMLTextAreaElement | null) {
  if (el) composers.set(k, el);
  else composers.delete(k);
}

export const focusComposer = (k: string) => composers.get(k)?.focus();

/**
 * Same message text, tolerating the daemon clipping very long transcript text, the TUI's
 * "[Image #N]" attachment markers, paste wrappers and whitespace differences.
 */
const norm = (t: string) =>
  t
    .replace(/\[Image #\d+\]/g, "")
    .replace(/<\/?pasted_content[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
export function sameText(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  const n = Math.min(x.length, y.length);
  return n >= 200 && x.slice(0, 200) === y.slice(0, 200);
}

/**
 * Did this edit insert more text at once than typing does? Clipboard chips on phone keyboards,
 * dictation, autofill and drag-and-drop insert text without a paste event; counting them as pasted
 * is the safe side (the coordinator then puts the action to you as a card).
 */
export const PASTE_LIKE_CHARS = 24;
export const insertedAtOnce = (prev: string, next: string) => next.length - prev.length > PASTE_LIKE_CHARS;
