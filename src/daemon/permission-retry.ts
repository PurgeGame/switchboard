import type { AttentionItem, Session } from "../shared/types.ts";
import type { AttentionEngine } from "./attention.ts";
import type { Store } from "./db.ts";
import type { Messenger } from "./messaging.ts";
import { deniedCallText, type DeniedToolCall } from "./adapters/tool-denial.ts";

/** Same exact-call transport as the human's card, honestly attributed to the Settings policy. */
export async function retrySafeDenial(store: Store, attention: AttentionEngine, messenger: Messenger, s: Session, item: AttentionItem) {
  const call = item.meta.deniedToolCall as DeniedToolCall;
  try {
    const message = await messenger.send({ sessionId: s.id, author: "auto", clientId: `tool-denial-auto:${item.id}`, text: `Switchboard's safe permission policy approved this exact call (${item.meta.autoRule}). Retry it once with the same arguments and working directory. This approval applies only to this call.\n\n${deniedCallText(call)}` });
    attention.annotate(item.id, { replyOutboxId: message.id });
    attention.onDelivery(store.outboxById(message.id) ?? message);
  } catch (e) { attention.retryFailed(item.id, String((e as Error).message ?? e)); }
}
