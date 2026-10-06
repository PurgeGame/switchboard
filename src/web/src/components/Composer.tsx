import { useEffect, useRef, useState } from "react";
import type { Session } from "../../../shared/types.ts";
import { ApiError, interruptSession, sendMessage, signalTyping } from "../api.ts";
import { loadDraft, registerComposer, saveDraft } from "../send.ts";
import { sessionTitle } from "../status.ts";
import { upsertOutbox } from "../store.ts";
import { useAttachments } from "./Attachments.tsx";
import { StatusIcon } from "./Icons.tsx";
import { MessageBox } from "./MessageBox.tsx";
const TYPING_THROTTLE_MS = 5000;

interface Props {
  session: Session;
  draftKey: string;
  /** Compact variant for the inbox. */
  compact?: boolean;
  autoFocus?: boolean;
  /** Suggested text used when there is no saved draft. */
  prefill?: string;
  onSent?: () => void;
}

export function Composer({ session, draftKey, compact, autoFocus, prefill, onSent }: Props) {
  const initial = useRef(loadDraft(draftKey));
  const [text, setText] = useState(initial.current.text || prefill || "");
  const files = useAttachments(initial.current.images);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interruptNote, setInterruptNote] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const clientId = useRef(crypto.randomUUID());
  const lastTyping = useRef(0);

  // Tells the daemon a human is typing so it cancels and holds off auto-continue. At most one call per 5s.
  const signal = (value: string) => {
    if (!value.trim() || Date.now() - lastTyping.current < TYPING_THROTTLE_MS) return;
    lastTyping.current = Date.now();
    signalTyping(session.id).catch(() => undefined);
  };

  // How the message gets there (terminal, Codex daemon, …) is the daemon's call, not yours.
  const { interrupt } = session.controls;
  const { uploading, paths: readyPaths } = files;
  const canSend = !busy && !uploading && (text.trim() !== "" || readyPaths.length > 0);

  useEffect(() => {
    saveDraft(draftKey, { text, images: readyPaths });
  }, [draftKey, text, readyPaths.join("\n")]);

  useEffect(() => {
    registerComposer(draftKey, area.current);
    if (autoFocus) area.current?.focus();
    return () => registerComposer(draftKey, null);
  }, [draftKey, autoFocus]);

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      const sent = await sendMessage(session.id, { text: text.trim(), images: readyPaths, clientId: clientId.current });
      upsertOutbox(sent);
      clientId.current = crypto.randomUUID();
      setText("");
      files.clear();
      onSent?.();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409 && /unresolved|driven via/.test(err.message)
          ? "An earlier message to this session wasn't confirmed. Check it above first."
          : err instanceof ApiError && err.status === 409
            ? "This session can't take messages from here right now."
            : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  const doInterrupt = async () => {
    setInterruptNote("Stopping…");
    try {
      const r = await interruptSession(session.id);
      setInterruptNote(r.outcome === "accepted" ? "Stopped." : "Couldn't stop it from here.");
    } catch {
      setInterruptNote("Couldn't stop it from here.");
    }
    setTimeout(() => setInterruptNote(null), 6000);
  };

  // Escape leaves the box; Enter sends (handled by MessageBox).
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      area.current?.blur();
    }
  };

  const stop =
    interrupt && session.execution === "working" ? (
      <button onClick={() => void doInterrupt()} className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-[12px] text-ink-2 hover:bg-hover hover:text-ink">
        <StatusIcon name="stop" width={12} height={12} />
        Stop
      </button>
    ) : null;

  return (
    <div className="space-y-1.5">
      <MessageBox
        value={text}
        onChange={(v) => {
          setText(v);
          signal(v);
        }}
        onSend={() => void submit()}
        canSend={canSend}
        busy={busy}
        label={`Message to ${sessionTitle(session)}`}
        placeholder={compact ? "Reply…" : `Message ${sessionTitle(session)}…`}
        attachments={files}
        extra={stop}
        compact={compact}
        textareaRef={area}
        onKeyDown={onKeyDown}
      />
      {interruptNote && (
        <p role="status" className="px-1 text-[11px] text-ink-2">
          {interruptNote}
        </p>
      )}
      {error && (
        <p role="alert" className="px-1 text-[12px] text-red">
          {error}
        </p>
      )}
    </div>
  );
}
