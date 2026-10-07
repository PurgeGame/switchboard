import { useEffect, useState } from "react";
import type { UsageRecommendationSettings as Settings } from "../../../shared/types.ts";

const fields = [
  ["lowRemainingPct", "Low remaining (%)", 1, 100],
  ["stopRemainingPct", "Stop remaining (%)", 0, 99],
  ["resetSoonMinutes", "Reset soon (minutes)", 1, 10080],
  ["maxAgeMinutes", "Maximum reading age (minutes)", 1, 1440],
] as const;
const endpoint = "/api/coordinator/usage-recommendations";
async function request(value?: Settings): Promise<Settings> {
  const r = await fetch(endpoint, { credentials: "same-origin", ...(value ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) } : {}) });
  const body = await r.json();
  if (!r.ok) throw Error(body.error ?? `Usage settings: ${r.status}`);
  return body;
}

export function UsageRecommendationSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    let active = true;
    void request().then((s) => { if (active) setSettings(s); }).catch((e) => { if (active) setNote(e.message); });
    return () => { active = false; };
  }, []);
  const save = async () => {
    if (!settings) return;
    setBusy(true); setNote("");
    try { setSettings(await request(settings)); setNote("Saved. Applies to the next recommendation."); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  };
  return <fieldset disabled={busy} className="space-y-2 border-t border-line pt-2.5">
    <legend className="font-medium text-ink">Worker usage recommendations</legend>
    <p className="text-[11px] text-ink-3">Prefer capacity available before reset. Only fresh readings can reduce ordinary work by one tier. Deep work waits when low; selections and Settings rules stay in place.</p>
    {settings && <>
      <label className="flex min-h-11 items-center gap-2 text-ink">
        <input type="checkbox" checked={settings.enabled} onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })} />
        Use usage recommendations
      </label>
      {fields.map(([key, label, min, max]) => <label key={key} className="flex items-center justify-between gap-2 text-ink">
        {label}
        <input aria-label={label} className="min-h-11 w-20 rounded border border-line bg-bg px-2" type="number" min={min} max={max} step="1" value={Number.isNaN(settings[key]) ? "" : settings[key]} onChange={(e) => setSettings({ ...settings, [key]: e.target.value === "" ? NaN : Number(e.target.value) })} />
      </label>)}
      <button type="button" onClick={() => void save()} className="min-h-11 rounded border border-line px-2 text-ink hover:bg-hover">Save usage thresholds</button>
    </>}
    {note && <p role="status" className="text-ink-3">{note}</p>}
  </fieldset>;
}
