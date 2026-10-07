import { useEffect, useState } from "react";
import type { CoordinatorRuntimeSelection, CoordinatorRuntimeSettings as Settings } from "../../../shared/types.ts";
import { fetchCoordinatorRuntime, restartCoordinator, saveCoordinatorRuntime } from "../api.ts";
import { useStore } from "../store.ts";

/** Human Settings only. Changing a selection saves it; restarting replaces just the brain. */
export function CoordinatorRuntimeSettings() {
  const coordinator = useStore((s) => s.coordinator);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    void fetchCoordinatorRuntime().then((s) => { if (mounted) setSettings(s); }).catch((e) => { if (mounted) setError(e.message); });
    return () => { mounted = false; };
  }, [coordinator?.running, coordinator?.model]);
  const save = async (selection: CoordinatorRuntimeSelection, restart = false) => {
    setBusy(true); setError(null);
    try {
      const saved = await saveCoordinatorRuntime(selection);
      setSettings(saved);
      if (restart) setSettings(await restartCoordinator());
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const restart = async () => {
    setBusy(true); setError(null);
    try { setSettings(await restartCoordinator()); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const canRestart = coordinator?.mode !== "manual" && !coordinator?.budget.exhausted;
  const selected = settings?.selected;
  const current = coordinator?.running ? settings?.current : null;
  const pending = current && selected && JSON.stringify(current) !== JSON.stringify(selected);
  return (
    <fieldset disabled={busy} className="space-y-2 border-t border-line pt-2.5">
      <legend className="font-medium text-ink">Coordinator</legend>
      {settings && selected && <>
        <label className="flex items-center justify-between gap-2 text-ink">
          Runtime
          <select aria-label="Coordinator runtime" value={selected.provider}
            onChange={(e) => void save(settings.choices[e.target.value as "claude" | "codex"])}
            className="min-h-9 rounded border border-line bg-bg px-2">
            <option value="codex">Codex</option><option value="claude">Claude</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2 text-ink">
          Model
          <select aria-label="Coordinator model" value={selected.model}
            onChange={(e) => void save({ ...selected, model: e.target.value })}
            className="min-h-9 max-w-44 rounded border border-line bg-bg px-2">
            {settings.models[selected.provider].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <p className="text-[11px] text-ink-3" role="status">
          {current ? `Running ${current.provider === "codex" ? "Codex" : "Claude"} · ${current.model}. ` : "Coordinator is not running. "}
          {pending ? "Saved. Applies on next start." : "Selections apply on the next coordinator start."}
        </p>
        {coordinator?.runtimeError && !coordinator.running && <p role="alert" className="text-[11px] text-amber">Couldn't start: {coordinator.runtimeError}</p>}
        {canRestart && <div className="flex flex-wrap gap-2">
          {current?.provider === "claude" && <button onClick={() => void save(settings.choices.codex, true)}
            className="min-h-9 rounded border border-line px-2 text-ink hover:bg-hover">Use Codex now</button>}
          <button onClick={() => void restart()} className="min-h-9 rounded border border-line px-2 text-ink hover:bg-hover">Restart coordinator</button>
        </div>}
        <p className="text-[11px] text-ink-3">{coordinator?.mode === "manual" ? "Turn the coordinator on to use this selection. " : "Restart keeps your work and current mode. "}Workers keep running.</p>
      </>}
      {error && <p role="alert" className="text-amber">{error}</p>}
    </fieldset>
  );
}
