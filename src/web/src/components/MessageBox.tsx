// The one message box used by every chat (coordinator and sessions): a rounded box holding the
// text area and attached images, with a toolbar underneath: attach, a short hint, optional extra
// actions (Stop), and Send.
import { useEffect, useRef, useState } from "react";
import type { Attachment } from "./Attachments.tsx";
import { AttachmentStrip, imageDropProps } from "./Attachments.tsx";
import { PaperclipIcon } from "./Icons.tsx";
import { insertedAtOnce } from "../send.ts";

const MAX_HEIGHT = 240;

export interface MessageBoxProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  canSend: boolean;
  busy?: boolean;
  placeholder: string;
  label: string;
  attachments: { items: Attachment[]; attach: (files: File[]) => void; remove: (id: string) => void };
  /** Extra controls shown in the toolbar, before Send (e.g. Stop). */
  extra?: React.ReactNode;
  autoFocus?: boolean;
  compact?: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Text was pasted into the box (keyboard, menu, right-click, or a large insert that wasn't typed). */
  onPasteText?: () => void;
}

/** Paste the clipboard into the box at the cursor; images become attachments. */
async function pasteFromClipboard(el: HTMLTextAreaElement, value: string, onChange: (v: string) => void, attach: (files: File[]) => void, onText?: () => void) {
  const files: File[] = [];
  let text = "";
  try {
    for (const item of await navigator.clipboard.read()) {
      const img = item.types.find((t) => t.startsWith("image/"));
      if (img) files.push(new File([await item.getType(img)], `pasted.${img.split("/")[1] ?? "png"}`, { type: img }));
      else if (item.types.includes("text/plain")) text += await (await item.getType("text/plain")).text();
    }
  } catch {
    text = await navigator.clipboard.readText().catch(() => "");
  }
  if (files.length) attach(files);
  if (!text) return;
  onText?.();
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  onChange(value.slice(0, start) + text + value.slice(end));
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(start + text.length, start + text.length);
  });
}

export function MessageBox(p: MessageBoxProps) {
  const own = useRef<HTMLTextAreaElement>(null);
  const area = p.textareaRef ?? own;
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [p.value]);

  useEffect(() => {
    if (p.autoFocus) area.current?.focus();
  }, [p.autoFocus]);

  return (
    <div
      className={`rounded-xl border bg-bg transition-colors focus-within:border-focus ${dragging ? "border-focus ring-2 ring-focus/40" : "border-line-strong"}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        p.attachments.attach([...e.dataTransfer.files]);
      }}
    >
      {p.attachments.items.length > 0 && (
        <div className="px-3 pt-3">
          <AttachmentStrip items={p.attachments.items} onRemove={p.attachments.remove} />
        </div>
      )}
      {/* Text takes the whole width; attach, Stop and Send sit together on the right. */}
      <div className="flex items-end gap-1.5 py-1.5 pl-1 pr-1.5">
        <textarea
          ref={area}
          value={p.value}
          rows={1}
          onChange={(e) => {
            if (p.onPasteText && insertedAtOnce(p.value, e.target.value)) p.onPasteText();
            p.onChange(e.target.value);
          }}
          onPaste={(e) => {
            if (e.clipboardData.getData("text/plain")) p.onPasteText?.();
            imageDropProps(p.attachments.attach).onPaste(e);
          }}
          onContextMenu={(e) => {
            // Right-click pastes, like a terminal (Shift+right-click keeps the browser menu).
            if (e.shiftKey || !navigator.clipboard) return;
            e.preventDefault();
            void pasteFromClipboard(e.currentTarget, p.value, p.onChange, p.attachments.attach, p.onPasteText);
          }}
          onKeyDown={(e) => {
            p.onKeyDown?.(e);
            if (e.defaultPrevented) return;
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (p.canSend) p.onSend();
            }
          }}
          aria-label={p.label}
          placeholder={p.placeholder}
          className="block min-h-[2.25rem] min-w-0 flex-1 resize-none bg-transparent px-2.5 py-2 text-[13.5px] leading-relaxed outline-none ring-0 placeholder:text-ink-3 focus:outline-none focus-visible:outline-none focus-visible:ring-0"
        />
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            p.attachments.attach([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => picker.current?.click()}
          aria-label="Attach image"
          title="Attach an image (or paste one)"
          className="shrink-0 rounded-md p-2 text-ink-3 hover:bg-hover hover:text-ink"
        >
          <PaperclipIcon width={16} height={16} />
        </button>
        {p.extra}
        <button
          onClick={p.onSend}
          disabled={!p.canSend}
          className="shrink-0 rounded-lg bg-focus px-3.5 py-1.5 text-[13px] font-medium text-[#10141a] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
        >
          {p.busy ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
