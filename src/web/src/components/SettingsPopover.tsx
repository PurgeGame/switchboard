import { useEffect, useRef, useState } from "react";
import { primeAudio } from "../notify.ts";
import { setPrefs, useStore } from "../store.ts";
import { GameModeControl } from "./Governor.tsx";
import { GearIcon } from "./Icons.tsx";

function Toggle(props: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-[#5ea5ff]" />
      <span>
        <span className="block text-ink">{props.label}</span>
        <span className="block text-[11px] text-ink-3">{props.hint}</span>
      </span>
    </label>
  );
}

export function SettingsPopover() {
  const prefs = useStore((s) => s.prefs);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggleNotifications = async (on: boolean) => {
    setNote(null);
    if (!on) return setPrefs({ notifications: false });
    if (!("Notification" in window)) return setNote("This browser does not support notifications.");
    const result = await Notification.requestPermission();
    if (result === "granted") setPrefs({ notifications: true });
    else setNote("Permission was not granted. Allow notifications for this site in the browser, then try again.");
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
        <div role="dialog" aria-label="Settings" className="absolute right-0 top-9 z-40 w-72 space-y-3 rounded-lg border border-line-strong bg-raised p-3.5 text-[12px] shadow-2xl">
          <Toggle
            label="Browser notifications"
            hint="Only for things that need you (questions, approvals, failures), and only while this tab is in the background."
            checked={prefs.notifications}
            onChange={(v) => void toggleNotifications(v)}
          />
          <Toggle label="Sounds" hint="Two soft tones when something needs you. Finished work stays silent." checked={prefs.sound} onChange={toggleSound} />
          <div className="border-t border-line pt-2.5">
            <GameModeControl />
          </div>
          {note && <p className="text-amber">{note}</p>}
          <p className="border-t border-line pt-2.5 text-[11px] text-ink-3">
            Desktop notifications are off; Switchboard keeps everything here. Browser notifications (optional) only for things that need you.
          </p>
        </div>
      )}
    </div>
  );
}
