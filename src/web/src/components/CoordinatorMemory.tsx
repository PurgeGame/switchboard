import { useEffect, useState } from "react";
import { LESSON_CATEGORIES, type CoordinatorLesson, type LessonInput, type MemorySnapshot } from "../../../shared/coordinator-memory.ts";

async function memoryRequest<T>(path = "", body?: unknown): Promise<T> {
  const response = await fetch(`/api/coordinator/memory${path}`, {
    credentials: "same-origin",
    ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Could not load coordinator memory");
  return data;
}

const empty = (): LessonInput => ({ text: "", category: "user preference", repoPath: "", source: "user: Settings", reason: "User edited Coordinator memory in Settings" });
const field = "w-full min-w-0 rounded border border-line-strong bg-base px-2 py-2 text-base text-ink";
const button = "min-h-11 rounded border border-line-strong px-3 text-ink hover:bg-hover disabled:opacity-50";

export function CoordinatorMemory() {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [draft, setDraft] = useState<LessonInput | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => setSnapshot(await memoryRequest<MemorySnapshot>());
  useEffect(() => { void refresh().catch((e) => setError(e.message)); }, []);
  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try { await action(); setDraft(null); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const edit = (lesson: CoordinatorLesson) => { setError(""); setDraft({ ...lesson }); };
  return (
    <section aria-label="Coordinator memory" className="space-y-3 border-t border-line pt-3">
      <h2 className="font-semibold text-ink">Coordinator memory</h2>
      <p className="text-ink-3">Short lessons that survive restarts. Guidance only; approvals and authority checks still apply.</p>
      {snapshot && <p className="text-ink-3">{snapshot.lessons.length} lessons · about {snapshot.estimatedTokens.toLocaleString()} / {snapshot.maxTokens.toLocaleString()} tokens</p>}
      {snapshot && snapshot.lessons.some((l) => l.pending) && <p className="text-amber">{snapshot.lessons.filter((l) => l.pending).length} preference{snapshot.lessons.filter((l) => l.pending).length === 1 ? "" : "s"} the coordinator recorded about you {snapshot.lessons.filter((l) => l.pending).length === 1 ? "waits" : "wait"} for Keep or Discard.</p>}
      {error && <p role="alert" className="break-words text-amber">{error}</p>}
      {draft ? (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void mutate(() => memoryRequest("", draft)); }}>
          <label className="block">Lesson
            <textarea aria-label="Lesson" autoFocus required rows={3} maxLength={400} className={field} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          </label>
          <label className="block">Category
            <select aria-label="Category" className={field} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as LessonInput["category"], repoPath: "" })}>
              {LESSON_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          {draft.category === "repo-specific" && <label className="block">Repository path (optional)
            <input className={field} maxLength={500} placeholder="/path/to/repo" value={draft.repoPath ?? ""} onChange={(e) => setDraft({ ...draft, repoPath: e.target.value })} />
          </label>}
          <label className="block">Source
            <input required className={field} maxLength={160} value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={busy} type="submit">{busy ? "Saving…" : "Save lesson"}</button>
            <button className={button} disabled={busy} type="button" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </form>
      ) : <button className={button} disabled={busy || !snapshot} onClick={() => { setError(""); setDraft(empty()); }}>Add lesson</button>}
      {snapshot?.lessons.length === 0 && <p className="text-ink-3">No lessons yet.</p>}
      <ul className="space-y-3">
        {snapshot?.lessons.map((lesson) => (
          <li key={lesson.id} className="space-y-2 rounded border border-line p-2.5 [overflow-wrap:anywhere]">
            {lesson.pending ? <p className="font-medium text-amber">New preference from the coordinator · not used until you keep it</p>
              : lesson.unseen ? <p className="font-medium text-amber">New from the coordinator</p> : null}
            <p className="whitespace-pre-line text-ink">{lesson.text}</p>
            <p className="text-ink-3">{lesson.category}{lesson.repoPath ? ` · ${lesson.repoPath}` : ""}</p>
            <p className="text-ink-3">Source: {lesson.source}</p>
            <p className="text-ink-3">Updated {new Date(lesson.updatedAt).toLocaleDateString()} · {lesson.hitCount} {lesson.hitCount === 1 ? "hit" : "hits"}</p>
            <div className="flex flex-wrap gap-2">
              {(lesson.pending || lesson.unseen) && <button className={button} disabled={busy || !!draft} aria-label={`${lesson.pending ? "Keep" : "Got it"}: ${lesson.text}`} onClick={() => void mutate(() => memoryRequest(`/${encodeURIComponent(lesson.id)}/keep`, { text: lesson.text, updatedAt: lesson.updatedAt }))}>{lesson.pending ? "Keep" : "Got it"}</button>}
              <button className={button} disabled={busy || !!draft} aria-label={`Edit lesson: ${lesson.text}`} onClick={() => edit(lesson)}>Edit</button>
              <button className={button} disabled={busy || !!draft} aria-label={`${lesson.pending ? "Discard" : "Delete"} lesson: ${lesson.text}`} onClick={() => void mutate(() => memoryRequest(`/${encodeURIComponent(lesson.id)}/delete`, {}))}>{lesson.pending ? "Discard" : "Delete"}</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
