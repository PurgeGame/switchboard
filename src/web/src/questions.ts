// Claude's AskUserQuestion, held for you by Switchboard: the card shows each question with one
// button per option plus a box for your own words, and sends back one answer per question. Pure
// functions, shared by the cards and tests.
import type { AttentionItem } from "../../shared/types.ts";

export interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

/** The questions of an open prompt you can answer here, or null when it's an ordinary permission prompt. */
export function questionsOf(item: AttentionItem): Question[] | null {
  if (item.kind !== "approval" || typeof item.meta.answerKey !== "string" || !Array.isArray(item.meta.questions)) return null;
  const qs = (item.meta.questions as any[]).filter((q) => q && typeof q.question === "string");
  if (!qs.length) return null;
  return qs.map((q) => ({
    question: q.question,
    ...(typeof q.header === "string" && q.header ? { header: q.header } : {}),
    options: (Array.isArray(q.options) ? q.options : []).filter((o: any) => o && typeof o.label === "string"),
    multiSelect: q.multiSelect === true,
  }));
}

/** One question with a single choice: tapping an option answers it at once. */
export const answersOnTap = (qs: Question[]) => qs.length === 1 && !qs[0].multiSelect;

/**
 * Your answers, keyed by question text, or null until every question has one. What you typed wins
 * over the options you picked; several picks are joined with ", " (as Claude's own dialog does).
 */
export function answersFrom(qs: Question[], picked: Record<string, string[]>, typed: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const q of qs) {
    const own = (typed[q.question] ?? "").trim();
    const picks = (picked[q.question] ?? []).filter((l) => q.options.some((o) => o.label === l));
    const answer = own || picks.join(", ");
    if (!answer) return null;
    out[q.question] = answer;
  }
  return out;
}

/** Tap an option: a single-choice question keeps one pick, a multi-select toggles it. */
export function pick(q: Question, current: string[], label: string): string[] {
  if (!q.multiSelect) return [label];
  return current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
}
