// Copy on select: releasing the mouse over a text selection copies it to the clipboard, like a
// terminal. Not inside text fields (selecting your own draft to edit it shouldn't copy).
import { useEffect, useState } from "react";

const MIN_CHARS = 2;

export function useCopyOnSelect(): string | null {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("textarea, input, [contenteditable='true']")) return;
      // After the click settles, so a plain click (which clears the selection) copies nothing.
      setTimeout(() => {
        const text = window.getSelection()?.toString() ?? "";
        if (text.trim().length < MIN_CHARS || !navigator.clipboard) return;
        navigator.clipboard.writeText(text).then(
          () => {
            setNote("Copied");
            clearTimeout(timer);
            timer = setTimeout(() => setNote(null), 1200);
          },
          () => undefined, // clipboard blocked (not a local/secure origin): leave the selection as is
        );
      }, 0);
    };
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mouseup", onUp);
      clearTimeout(timer);
    };
  }, []);
  return note;
}
