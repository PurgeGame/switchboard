import { useState } from "react";
import type { OutboxMessage } from "../../../shared/types.ts";
import { resolveDelivery, sendMessage } from "../api.ts";
import { clock } from "../format.ts";
import { upsertOutbox } from "../store.ts";
import { Thumbnails } from "./Attachments.tsx";
import { StatusIcon } from "./Icons.tsx";

/** Quiet delivery state: nothing when it went through; plain words when it didn't. */
function Delivery({ m }: { m: OutboxMessage }) {
  switch (m.state) {
    case "queued":
    case "sending":
      if (m.detail === "queued")
        return (
          <span className="text-ink-3" role="status" title="The session is busy; typed messages go in at its next pause">
            Queued · goes in after its current step
          </span>
        );
      return (
        <span className="inline-flex items-center gap-1 text-ink-3" role="status">
          <StatusIcon name="active" width={11} height={11} />
          sending
        </span>
      );
    case "accepted":
      return null;
    case "failed":
      return <span className="text-red">Didn't send</span>;
    case "uncertain":
      return <span className="text-amber">Not confirmed</span>;
  }
}

function ResendControl({ m }: { m: OutboxMessage }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resend = async () => {
    setConfirming(false);
    setError(null);
    try {
      // A new clientId on purpose: the original may already have been delivered, and this is a deliberate second send.
      upsertOutbox(await sendMessage(m.sessionId, { text: m.text, images: m.images, clientId: crypto.randomUUID(), mode: m.mode, method: m.method }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const settle = async (as: "delivered" | "not_delivered") => {
    setError(null);
    try {
      upsertOutbox(await resolveDelivery(m.id, as));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-1.5">
      <p className="text-[12px] text-amber">
        This may or may not have reached the session. Check above, then:
      </p>
      <div className="flex items-center gap-2 text-[12px]">
        <button onClick={() => void settle("delivered")} className="rounded border border-line-strong px-2 py-0.5 text-ink-2 hover:bg-hover">
          It arrived
        </button>
        <button onClick={() => void settle("not_delivered")} className="rounded border border-line-strong px-2 py-0.5 text-ink-2 hover:bg-hover">
          It didn't arrive
        </button>
      </div>
      {confirming ? (
        <div className="flex items-center gap-2 text-[12px]">
          <span className="text-ink-2">Send this again as a new message?</span>
          <button onClick={() => void resend()} className="rounded border border-amber/60 px-2 py-0.5 text-amber hover:bg-amber/10">
            Send again
          </button>
          <button onClick={() => setConfirming(false)} className="rounded border border-line px-2 py-0.5 text-ink-2 hover:bg-hover">
            Cancel
          </button>
        </div>
      ) : (
        <button onClick={() => setConfirming(true)} className="rounded border border-amber/60 px-2 py-0.5 text-[12px] text-amber hover:bg-amber/10">
          Send again…
        </button>
      )}
      {error && <p className="text-[12px] text-red">{error}</p>}
    </div>
  );
}

export function OutboxBubble({ message: m }: { message: OutboxMessage }) {
  const tone = m.state === "failed" ? "border-red/50" : m.state === "uncertain" ? "border-amber/50" : "border-line-strong";
  const who = m.author === "coordinator" ? "Coordinator" : m.author === "auto" ? "auto" : "You";
  return (
    <div className={`rounded-lg border bg-raised px-3.5 py-2.5 ${tone} ${m.state === "queued" || m.state === "sending" ? "opacity-80" : ""}`}>
      <div className={`mb-1 flex items-baseline gap-2 text-[11px] font-medium ${m.author === "auto" ? "text-ink-2 italic" : "text-focus"}`}>
        {who}
        <time className="font-normal text-ink-3/80">{clock(m.createdAt)}</time>
        <span className="ml-auto font-normal">
          <Delivery m={m} />
        </span>
      </div>
      {m.text && <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{m.text}</div>}
      {m.images.length > 0 && (
        <div className="mt-2 space-y-1">
          <Thumbnails paths={m.images} />
        </div>
      )}
      {m.state === "uncertain" && (
        <div className="mt-2">
          <ResendControl m={m} />
        </div>
      )}
    </div>
  );
}
