import { useId, useRef } from "react";
import type { Session } from "../../../shared/types.ts";
import { isBackground } from "../sessionList.ts";
import { sessionTitle } from "../status.ts";
import { toggleMainSession, useStore } from "../store.ts";

export const canPinSession = (s: Session) => s.execution !== "ended" && isBackground(s);

/** A browser preference only: the session itself stays exactly as it is. */
export function SessionPlacement({ session, menu = false }: { session: Session; menu?: boolean }) {
  const pinned = useStore((s) => s.mainSessionIds.includes(session.id));
  const id = useId();
  const popover = useRef<HTMLDivElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  if (!canPinSession(session)) return null;
  const label = pinned ? "Move to background" : "Pin to main";
  const toggle = () => {
    popover.current?.hidePopover();
    toggleMainSession(session.id);
    if (menu) requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-session-actions="${CSS.escape(session.id)}"]`)?.focus({ preventScroll: true });
    });
  };
  if (!menu) return (
    <button onClick={toggle} className="min-h-11 rounded-md border border-line px-3 text-[12px] text-ink-2 hover:bg-hover">
      {label}
    </button>
  );
  return (
    <>
      <button
        data-session-actions={session.id}
        aria-label={`Actions for ${sessionTitle(session)}`}
        aria-haspopup="menu"
        popoverTarget={id}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          if (popover.current) {
            popover.current.style.left = `${Math.max(8, Math.min(box.right - 224, window.innerWidth - 232))}px`;
            popover.current.style.top = `${box.bottom + 64 > window.innerHeight ? box.top - 56 : box.bottom + 4}px`;
          }
        }}
        className="absolute right-0 top-1 flex h-11 w-11 items-center justify-center rounded-md text-xl text-ink-3 hover:bg-hover hover:text-ink"
      >
        <span aria-hidden>⋯</span>
      </button>
      <div
        id={id}
        ref={popover}
        popover="auto"
        role="menu"
        aria-label={`Actions for ${sessionTitle(session)}`}
        onToggle={(e) => { if (e.newState === "open") action.current?.focus(); }}
        onKeyDown={(e) => e.stopPropagation()}
        className="fixed m-0 w-56 max-w-[calc(100vw-16px)] rounded-lg border border-line-strong bg-panel p-1 text-ink shadow-lg"
      >
        <button ref={action} role="menuitem" onClick={toggle} className="min-h-11 w-full rounded-md px-3 text-left text-[13px] hover:bg-hover">
          {label}
        </button>
      </div>
    </>
  );
}
