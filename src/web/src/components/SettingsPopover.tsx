import { useEffect, useRef, useState } from "react";
import { disablePhoneNotifications } from "../push.ts";
import { fetchPermissionSettings, setPermissionSettings } from "../api.ts";
import { primeAudio } from "../notify.ts";
import { setPrefs, useStore } from "../store.ts";
import { GameModeControl } from "./Governor.tsx";
import { GearIcon } from "./Icons.tsx";
import { setAutoEndSettings } from "../api.ts";
import { CoordinatorRuntimeSettings } from "./CoordinatorRuntimeSettings.tsx";
import { UsageRecommendationSettings } from "./UsageRecommendationSettings.tsx";
import { CoordinatorMemory } from "./CoordinatorMemory.tsx";

function Toggle(props: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" disabled={props.disabled} checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-[#5ea5ff]" />
      <span>
        <span className="block text-ink">{props.label}</span>
        <span className="block text-[11px] text-ink-3">{props.hint}</span>
      </span>
    </label>
  );
}

export function SettingsPopover() {
  const prefs = useStore((s) => s.prefs);
  const autoEnd = useStore((s) => s.coordinator?.autoEnd);
  const builtinCoordinator = useStore((s) => s.coordinator?.agent === "builtin");
  const [saving, setSaving] = useState(false);
  const [autoEndEnabled, setAutoEndEnabled] = useState(true);
  const [idleMinutes, setIdleMinutes] = useState("10");
  const coordinatorAgent = useStore((s) => s.coordinatorAgent);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [autoApproveSafe, setAutoApproveSafe] = useState<boolean | null>(null);
  const [policyScope, setPolicyScope] = useState<"workers" | "all">("workers");
  const [savingPolicy, setSavingPolicy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const savedIdleMinutes = useRef(10);
  useEffect(() => {
    if (autoEnd) {
      savedIdleMinutes.current = autoEnd.idleMinutes;
      setIdleMinutes(String(autoEnd.idleMinutes));
    }
  }, [autoEnd?.idleMinutes]);
  useEffect(() => {
    if (autoEnd) setAutoEndEnabled(autoEnd.enabled);
  }, [autoEnd?.enabled]);
  const saveAutoEnd = async (enabled: boolean, minutes = Number(idleMinutes)) => {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      setNote("Choose a whole number from 1 to 1440 minutes.");
      return;
    }
    const previous = autoEndEnabled;
    setAutoEndEnabled(enabled);
    setSaving(true);
    setNote(null);
    try {
      const next = await setAutoEndSettings({ enabled, idleMinutes: minutes });
      setAutoEndEnabled(next.autoEnd.enabled);
      setIdleMinutes(String(next.autoEnd.idleMinutes));
      savedIdleMinutes.current = next.autoEnd.idleMinutes;
    } catch (e) {
      setAutoEndEnabled(previous);
      setNote((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    let current = true;
    setAutoApproveSafe(null);
    void fetchPermissionSettings().then((s) => { if (current) { setAutoApproveSafe(s.autoApproveSafe); setPolicyScope(s.scope === "all" ? "all" : "workers"); } }).catch((e) => { if (current) setNote(e.message); });
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      current = false;
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const togglePolicy = async (enabled: boolean) => {
    const previous = autoApproveSafe;
    setAutoApproveSafe(enabled);
    setSavingPolicy(true);
    setNote(null);
    try { setAutoApproveSafe((await setPermissionSettings(enabled)).autoApproveSafe); }
    catch (e) { setAutoApproveSafe(previous); setNote((e as Error).message); }
    finally { setSavingPolicy(false); }
  };

  const toggleSound = (on: boolean) => {
    if (on) primeAudio();
    setPrefs({ sound: on });
  };

  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Settings"
        aria-expanded={open}
        className="rounded-md p-1.5 text-ink-3 hover:bg-hover hover:text-ink"
      >
        <GearIcon width={16} height={16} />
      </button>
      {open && (
        <div role="dialog" aria-label="Settings" className="fixed right-2 top-12 z-40 max-h-[calc(100dvh-4rem)] w-[min(24rem,calc(100vw-1rem))] space-y-3 overflow-y-auto overscroll-contain rounded-lg border border-line-strong bg-raised p-3.5 text-[12px] shadow-2xl">
          {prefs.notifications ? <button className="min-h-11 text-ink-2" onClick={() => void disablePhoneNotifications().catch((e) => setNote(e.message))}>Disable phone notifications</button> : <p className="text-ink-3">Open the inbox to enable phone alerts.</p>}
          <Toggle
            label="Auto-approve safe permissions"
            hint={policyScope === "all" ? "Allow reviewed reads, and test, typecheck, build and lint commands (which run project code), in every session not excluded from coordination. Applies to all devices." : "Allow reviewed reads in any session not excluded from coordination. Test, typecheck, build and lint commands run project code: only coordinator workers in their own worktree get those. Applies to all devices."}
            checked={autoApproveSafe === true}
            disabled={autoApproveSafe === null || savingPolicy}
            onChange={(v) => void togglePolicy(v)}
          />
          <Toggle label="Sounds" hint="Two soft tones when something needs you. Finished work stays silent." checked={prefs.sound} onChange={toggleSound} />
          {builtinCoordinator && <CoordinatorRuntimeSettings />}
          {autoEnd && (
            <fieldset disabled={saving} className="space-y-2 border-t border-line pt-2.5">
              <Toggle label="End finished background workers" hint="After they stay idle. Workers with open work, recent user input, running children or uncommitted changes stay open. Pausing the coordinator also pauses cleanup." checked={autoEndEnabled} onChange={(v) => void saveAutoEnd(v, savedIdleMinutes.current)} />
              <label className="flex items-center justify-between gap-2 text-ink">
                Idle grace (minutes)
                <input aria-label="Idle grace (minutes)" type="number" min="1" max="1440" step="1" value={idleMinutes} onChange={(e) => setIdleMinutes(e.target.value)} className="w-16 rounded border border-line bg-bg px-2 py-1" />
              </label>
              <button onClick={() => void saveAutoEnd(autoEndEnabled)} className="rounded border border-line px-2 py-1 text-ink hover:bg-hover">Save grace period</button>
            </fieldset>
          )}
          <div className="border-t border-line pt-2.5">
            <GameModeControl />
          </div>
          {note && <p className="text-amber">{note}</p>}
          <p className="border-t border-line pt-2.5 text-[11px] text-ink-3">
            Phone notifications include every new Needs you item, even when Switchboard is closed.
          </p>
          {coordinatorAgent !== "none" && <UsageRecommendationSettings />}
          {coordinatorAgent !== "none" && <CoordinatorMemory />}
        </div>
      )}
    </div>
  );
}
