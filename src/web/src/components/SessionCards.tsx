// The cards waiting on you about one session, in that session (they're in the coordinator's Needs
// you and the inbox too): its permission prompts and questions, the coordinator's proposals about
// it (held messages), and its task waiting for your "Looks good".
import type { Session } from "../../../shared/types.ts";
import { needsYou } from "../home.ts";
import { useStore } from "../store.ts";
import { DoneCard, ProposalCard } from "./CoordinatorPane.tsx";
import { AttentionCard, CardsHere, PermissionCard } from "./NeedsYouParts.tsx";

export function SessionCards({ session: s }: { session: Session }) {
  const attention = useStore((st) => st.attention);
  const coordinator = useStore((st) => st.coordinator);
  const tasks = useStore((st) => st.coordination.tasks);
  const sessions = useStore((st) => st.sessions);
  const { prompts, others } = needsYou(attention);
  const mine = { prompts: prompts.filter((i) => i.sessionId === s.id), others: others.filter((i) => i.sessionId === s.id) };
  const proposals = (coordinator?.proposals ?? []).filter((p) => p.state === "pending" && p.sessionId === s.id);
  const done = tasks.filter((t) => t.status === "finished_unverified" && t.owner === s.id);
  const count = mine.prompts.length + mine.others.length + proposals.length + done.length;
  if (!count) return null;
  // Only the built-in coordinator judges prompts (D29, D34); otherwise the note is Switchboard's own reason.
  const recLabel = coordinator?.agent === "external" ? null : "Coordinator";
  return (
    <section aria-label="Needs you here" className="max-h-[45vh] space-y-2 overflow-y-auto border-t border-line bg-panel px-3 py-2.5 sm:px-6">
      <h2 className="mx-auto max-w-3xl text-[12px] font-semibold uppercase tracking-wide text-amber">Needs you{count > 1 ? ` · ${count}` : ""}</h2>
      <CardsHere.Provider value={s.id}>
        <ul className="mx-auto max-w-3xl space-y-2">
          {mine.prompts.map((i) => (
            <PermissionCard key={i.id} item={i} sessions={sessions} recLabel={recLabel} />
          ))}
          {proposals.map((p) => (
            <ProposalCard key={p.id} p={p} sessions={sessions} />
          ))}
          {done.map((t) => (
            <DoneCard key={t.id} t={t} sessions={sessions} />
          ))}
          {mine.others.map((i) => (
            <AttentionCard key={i.id} item={i} sessions={sessions} />
          ))}
        </ul>
      </CardsHere.Provider>
    </section>
  );
}
