import { useMemo, useState } from "react";
import { launchSession } from "../api.ts";
import { useStore } from "../store.ts";

export function Launcher() {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessions = useStore((s) => s.sessions);
  const folders = useMemo(
    () => [...new Set(Object.values(sessions).flatMap((s) => [s.project, s.cwd]).filter((p): p is string => !!p))].sort(),
    [sessions],
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await launchSession({ provider, cwd: cwd.trim(), name: name.trim() || undefined, model: model.trim() || undefined });
      setOpen(false);
      setName("");
      setModel("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] placeholder:text-ink-3 focus-visible:border-focus";
  return (
    <div className="border-b border-line">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-[12px] font-medium text-ink-2 hover:bg-hover"
      >
        New session
        <span aria-hidden className="text-ink-3">
          {open ? "−" : "+"}
        </span>
      </button>
      {open && (
        <form onSubmit={(e) => void submit(e)} className="space-y-2 px-3 pb-3">
          <div role="group" aria-label="Provider" className="flex gap-1">
            {(["claude", "codex"] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={provider === p}
                onClick={() => setProvider(p)}
                className={`rounded px-2.5 py-1 text-[12px] ${provider === p ? "bg-raised text-ink ring-1 ring-line-strong" : "text-ink-3 hover:text-ink-2"}`}
              >
                {p === "claude" ? "Claude" : "Codex"}
              </button>
            ))}
          </div>
          <label className="block text-[11px] text-ink-3">
            Folder
            <input required list="launcher-folders" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/home/you/project" className={`${field} mt-0.5 font-mono`} />
            <datalist id="launcher-folders">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[11px] text-ink-3">
              Name (optional)
              <input value={name} onChange={(e) => setName(e.target.value)} className={`${field} mt-0.5`} />
            </label>
            <label className="block text-[11px] text-ink-3">
              Model (optional)
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" className={`${field} mt-0.5`} />
            </label>
          </div>
          <p className="text-[11px] text-ink-3">Opens a terminal in the VS Code window that owns this folder.</p>
          {error && (
            <p role="alert" className="text-[12px] text-red">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || cwd.trim() === ""}
            className="rounded-md bg-focus px-3 py-1.5 text-[12px] font-medium text-[#10141a] disabled:opacity-40"
          >
            {busy ? "Starting…" : "Start session"}
          </button>
        </form>
      )}
    </div>
  );
}
