// What COORDINATOR.md tells the coordinator (built-in prompt file; an external agent gets the same
// text from get_instructions): the userChat rule, and proposing the daemon fix when a refusal
// blocks what the user asked for.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Coordination } from "../src/daemon/coordination.ts";
import { CoordinatorAgent } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { PROMPT_FILE } from "../src/daemon/coordinator/runtime.ts";
import { Store } from "../src/daemon/db.ts";

const RULE = /When the daemon refuses something the user asked for, propose the daemon fix in that same reply/;

test("COORDINATOR.md: chat instructions (userChat) and the refusal rule; an external agent gets both", async () => {
  const text = readFileSync(PROMPT_FILE, "utf8");
  expect(text).toMatch(RULE);
  expect(text).toMatch(/pass `userChat` \(that message's chat #\)/);
  expect(text).toMatch(/destructive steps \(still a card\)/);
  const store = new Store("", ":memory:");
  const agent = new CoordinatorAgent({
    db: store.db,
    coordination: new Coordination(store),
    cfg: mergeCoordinatorConfig({ agent: "external" }),
    sessions: () => new Map(),
    events: () => [],
    send: async () => ({ ok: true }),
    escalate: () => {},
    push: () => {},
    timers: false,
  });
  agent.setMode("active");
  const r: any = await agent.callTool("get_instructions", {});
  expect(r.result.text).toMatch(RULE);
  expect(r.result.text).toContain("userChat");
  expect(r.result.text).toContain("stall_suspected");
  expect(r.result.text).toContain("request_checkpoint");
  expect(r.result.text).toContain("report_stall");
  expect(r.result.text).toContain("Silence alone is not confirmation");
  store.db.close();
});
