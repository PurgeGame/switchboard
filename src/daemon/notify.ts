// Desktop notifications via notify-send (KDE/libnotify). At most one per attention item.
// Clicking "Open" opens the session in the browser.
import type { AttentionItem, Session } from "../shared/types.ts";

export interface NotifyConfig {
  desktop: boolean;
  /** Finished items notify at normal urgency; needs-action at critical. */
  finished: boolean;
  ignore: string[];
}

/** Only urgent items interrupt the user's desktop; everything else stays in the inbox. */
const URGENT = new Set(["question", "approval", "failed", "escalation"]);

export class Notifier {
  private sent = new Set<number>();

  constructor(
    private cfg: NotifyConfig,
    private uiUrl: (sessionId: string) => string,
  ) {}

  notify(item: AttentionItem, s: Session) {
    if (!this.cfg.desktop || this.sent.has(item.id) || item.historical || item.meta.autoApproved || item.meta.autoPending) return;
    if (s.cwd && this.cfg.ignore.some((p) => s.cwd!.includes(p))) return; // test/sandbox sessions
    if (!URGENT.has(item.kind) && !(item.kind === "finished" && this.cfg.finished)) return;
    this.sent.add(item.id);
    const name = s.name ?? s.goal ?? s.id;
    const urgent = URGENT.has(item.kind);
    const label =
      item.kind === "question" ? "Needs your answer" :
      item.kind === "approval" ? "Needs approval" :
      item.kind === "finished" ? `Finished${item.outcome && item.outcome !== "unclear" ? ` · reports ${item.outcome}` : ""}` :
      item.title;
    const body = (item.text ?? item.title).replace(/\s+/g, " ").slice(0, 240);
    try {
      const p = Bun.spawn(
        ["notify-send", "-a", "Switchboard", "-u", urgent ? "critical" : "normal", "-i", urgent ? "dialog-warning" : "dialog-information", "-A", "open=Open", "--wait", `${label} · ${name}`, body],
        { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
      );
      void new Response(p.stdout).text().then((out) => {
        if (out.trim() === "open") Bun.spawn(["xdg-open", this.uiUrl(s.id)], { stdout: "ignore", stderr: "ignore" });
      });
    } catch (e) {
      console.error("[notify] notify-send failed:", e);
    }
  }
}
