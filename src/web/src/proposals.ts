// What a coordinator proposal card shows, for every kind the daemon queues: send_message,
// launch_session and each action (plan, new objective, ask_several, refresh_context, route, and a
// plain propose_action). A card must show what approving it does, with its main button named for
// it. Pure, shared by the card and tests; the plan's details render in PlanSummary.
import type { CoordinatorProposal } from "../../shared/types.ts";

export interface ProposalView {
  heading: string;
  /** Short facts: where it runs, who does it. `mono` is a path or id, shown as code. */
  facts: { text: string; mono?: string }[];
  /** The exact text approving it sends or uses (message, brief, prompt, focus), if any. */
  body: string | null;
  /** What the body is, when the heading doesn't already say. */
  bodyLabel: string | null;
  /** The approve button. */
  approve: string;
  /** A delegation plan: its card renders every task, and approving sends the digest it showed. */
  plan: boolean;
}

export const unprefix = (t: string) => t.replace(/^\[coordinator\]\s*/, "");
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

export function proposalView(p: CoordinatorProposal, nameOf: (sessionId: string | null) => string): ProposalView {
  const pl = (p.payload ?? {}) as Record<string, unknown>;
  const facts: ProposalView["facts"] = [];
  if (p.heldBecause === "destructive_screen") facts.push({ text: "Held because it sounded destructive: read it before you say yes." });
  const view = (v: Partial<ProposalView> & Pick<ProposalView, "heading" | "approve">): ProposalView => ({ facts, body: null, bodyLabel: null, plan: false, ...v });
  if (p.kind === "send_message") return view({ heading: `Send this to ${nameOf(p.sessionId)}?`, body: unprefix(p.text), approve: "Send" });
  if (p.kind === "launch_session") {
    if (str(pl.repo)) facts.push({ text: "Works in ", mono: String(pl.repo) });
    facts.push({ text: `${pl.provider === "codex" ? "Codex" : "Claude"}, ${pl.worktree === false ? "in that folder itself (no worktree of its own)" : "in a new worktree of its own"}` });
    return view({ heading: `${p.title}?`, body: str(p.text), bodyLabel: "Its brief", approve: "Start" });
  }
  switch (pl.action) {
    case "plan":
      return view({ heading: `Plan: ${p.title}`, approve: "Go ahead", plan: true });
    case "new_objective": {
      // The folder comes from the request itself, not the coordinator's wording.
      if (str(pl.root)) facts.push({ text: "Works in ", mono: String(pl.root) });
      const resources = Array.isArray(pl.resources) ? (pl.resources as string[]) : [];
      if (resources.length) facts.push({ text: `Also uses ${resources.join(", ")}` });
      return view({ heading: `${p.title}?`, body: str(p.text), bodyLabel: "About it", approve: "Go ahead" });
    }
    case "ask_several": {
      if (str(pl.cwd)) facts.push({ text: "They work in ", mono: String(pl.cwd) });
      return view({ heading: `${p.title}?`, body: str(pl.prompt) ?? str(p.text), bodyLabel: "The question", approve: "Ask them" });
    }
    case "refresh_context": {
      const fresh = pl.how === "fresh";
      return fresh
        ? view({ heading: `${p.title}?`, body: str(pl.brief) ?? str(p.text), bodyLabel: "Its context is cleared, then it gets this", approve: "Start fresh" })
        : view({ heading: `${p.title}?`, body: str(pl.focus) ?? str(p.text), bodyLabel: "What to keep", approve: "Compact" });
    }
    case "route":
      return view({ heading: `${p.title}?`, body: str(p.text), approve: "Send" });
    default:
      return view({ heading: `${p.title}?`, body: str(p.text), approve: "Go ahead" });
  }
}
