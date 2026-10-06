import { useEffect } from "react";
import { isAckable } from "./attention.ts";
import { focusComposer } from "./send.ts";
import { acknowledge, getState, setReplyOpen, selectInboxItem, selectSession, selectTask, setContextOpen, setInboxOpen, setSearch, setView, showList, toggleInbox } from "./store.ts";
import { COORDINATOR_ID, openSession } from "./store.ts";

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** Global shortcuts: j/k move, Enter opens, / search, i inbox, a acknowledge, g w / g s switch view, Esc clears. */
export function useShortcuts(orderedIds: string[], inboxOrder: number[], searchRef: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    let gPending = 0;
    const move = (delta: number) => {
      if (getState().inboxOpen) {
        const { inboxSelectedId } = getState();
        const at = inboxSelectedId !== null ? inboxOrder.indexOf(inboxSelectedId) : -1;
        const next = inboxOrder[Math.min(inboxOrder.length - 1, Math.max(0, at + delta))];
        if (next !== undefined) {
          selectInboxItem(next);
          document.querySelector(`[data-inbox-id="${next}"]`)?.scrollIntoView({ block: "nearest" });
        }
        return;
      }
      const { selectedId } = getState();
      const at = selectedId ? orderedIds.indexOf(selectedId) : -1;
      const next = orderedIds[Math.min(orderedIds.length - 1, Math.max(0, at + delta))];
      if (next) selectSession(next);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isTyping(e.target)) (e.target as HTMLElement).blur();
        if (getState().selectedTaskId) selectTask(null);
        else if (getState().inboxOpen) setInboxOpen(false);
        else if (getState().contextOpen) setContextOpen(false);
        else if (getState().search) setSearch("");
        else showList();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (gPending && Date.now() - gPending < 1200) {
        gPending = 0;
        if (e.key === "h" || e.key === "c") openSession(COORDINATOR_ID);
        else if (e.key === "s") setView("workspace");
        return;
      }
      gPending = 0;
      switch (e.key) {
        case "g":
          gPending = Date.now();
          break;
        case "i":
          toggleInbox();
          break;
        case "r": {
          e.preventDefault(); // keep the keystroke out of the composer we are about to focus
          const { inboxOpen, inboxSelectedId, attention, sessions, selectedId, replyOpenId } = getState();
          const item = inboxOpen && inboxSelectedId !== null ? attention[inboxSelectedId] : undefined;
          if (inboxOpen) {
            if (item?.kind === "question" && (sessions[item.sessionId]?.sendMethods.length ?? 0) > 0) {
              if (replyOpenId === item.id) focusComposer(`reply:${item.id}`);
              else setReplyOpen(item.id);
            }
          } else if (selectedId) focusComposer(`sess:${selectedId}`);
          break;
        }
        case "a": {
          const { inboxOpen, inboxSelectedId, attention } = getState();
          const item = inboxSelectedId !== null ? attention[inboxSelectedId] : undefined;
          if (inboxOpen && item && isAckable(item.kind)) void acknowledge(item.id);
          break;
        }
        case "j":
          move(1);
          break;
        case "k":
          move(-1);
          break;
        case "Enter": {
          const { selectedId, view } = getState();
          if (view === "workspace" && selectedId && !(e.target as HTMLElement).closest("button")) selectSession(selectedId, true);
          break;
        }
        case "/":
          e.preventDefault();
          setView("workspace");
          searchRef.current?.focus();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [orderedIds, inboxOrder, searchRef]);
}
