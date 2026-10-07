// Provider protocol stand-ins for the isolated browser e2e. Never calls a model or tools.
import { createInterface } from "node:readline";
import { CODEX_MODELS, CODEX_VERSION } from "../../src/daemon/coordinator/codex-config.ts";

export async function coordinatorBrain(provider: "claude" | "codex") {
  if (provider === "codex" && process.argv.includes("--version")) { console.log(CODEX_VERSION); return; }
  if (provider === "codex" && process.argv.includes("models")) {
    console.log(JSON.stringify({ models: CODEX_MODELS.map((slug) => ({ slug })) })); return;
  }
  let turn = 0;
  const out = (m: unknown) => console.log(JSON.stringify(m));
  for await (const line of createInterface({ input: process.stdin })) {
    const m = JSON.parse(line);
    if (provider === "claude") {
      if (m.type === "user") { out({ type: "assistant", message: { content: [{ type: "text", text: "E2E coordinator ready." }] } }); out({ type: "result", total_cost_usd: ++turn * 0.001 }); }
      continue;
    }
    if (m.method === "initialize") out({ id: m.id, result: {} });
    else if (m.method === "thread/start") out({ id: m.id, result: { thread: { id: "e2e" }, model: m.params.model } });
    else if (m.method === "turn/start") {
      const id = String(++turn);
      out({ id: m.id, result: { turn: { id } } });
      out({ method: "turn/started", params: { threadId: "e2e", turn: { id } } });
      out({ method: "item/completed", params: { threadId: "e2e", turnId: id, item: { type: "agentMessage", text: "E2E coordinator ready." } } });
      const total = { inputTokens: turn, cachedInputTokens: 0, outputTokens: turn };
      out({ method: "thread/tokenUsage/updated", params: { threadId: "e2e", turnId: id, tokenUsage: { total, last: total } } });
      out({ method: "turn/completed", params: { threadId: "e2e", turn: { id, status: "completed" } } });
    }
  }
}
