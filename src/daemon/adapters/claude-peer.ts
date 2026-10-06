// Claude Code native peer messaging (verified 2026-10-06 against a throwaway session):
// NDJSON frames over the session's messaging socket. The recipient sees a cross-session
// message labeled "not typed by your user" that cannot approve prompts, so the UI labels
// this method "peer message", never as the user's own turn. There is no ack on the
// connection; delivery is confirmed when the frame's msg_id shows up in the transcript.
import { realpathSync } from "node:fs";
import { userInfo } from "node:os";

const SOCK_DIR = `/run/user/${userInfo().uid}/cc-socks/`;

/** A send error that says whether any bytes may have reached the session. */
export class DeliveryError extends Error {
  constructor(
    message: string,
    /** false: provably nothing was written. true: something may have arrived. */
    readonly wrote: boolean,
  ) {
    super(message);
  }
}

export async function sendPeerMessage(socketPath: string, text: string, msgId: string): Promise<void> {
  // Only ever write to Claude's own socket directory.
  let real: string;
  try {
    real = realpathSync(socketPath);
  } catch (e) {
    throw new DeliveryError(`peer socket missing: ${(e as Error).message}`, false);
  }
  if (!real.startsWith(SOCK_DIR) || !real.endsWith(".sock")) throw new DeliveryError(`refusing non-Claude socket ${socketPath}`, false);
  const frame = JSON.stringify({ type: "user", message: { role: "user", content: text }, msg_id: msgId }) + "\n";
  let opened = false;
  await new Promise<void>((resolve, reject) => {
    const fail = (e: unknown) => {
      clearTimeout(timer);
      reject(e instanceof DeliveryError ? e : new DeliveryError(String((e as Error)?.message ?? e), opened));
    };
    // After the connection opened, a timeout can't prove the frame wasn't read.
    const timer = setTimeout(() => fail(new DeliveryError("peer socket timeout", opened)), 3000);
    Bun.connect({
      unix: real,
      socket: {
        open(s) {
          opened = true;
          s.write(frame);
          s.flush();
          s.end();
        },
        close() {
          clearTimeout(timer);
          resolve();
        },
        error(_s, e) {
          fail(e);
        },
        data() {},
      },
    }).catch(fail);
  });
}
