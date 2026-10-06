// ask_several: the coordinator's "get several perspectives" skill. Always a one-tap proposal;
// approving starts the group once (with auto-synthesis); get_group reads answers back.
import { expect, test } from "bun:test";
import { Coordination } from "../src/daemon/coordination.ts";
import { CoordinatorAgent } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { Store } from "../src/daemon/db.ts";

test("asking several agents is a proposal; approving starts it once; the result is readable", async () => {
  const store = new Store("", ":memory:");
  const started: any[] = [];
  const agent = new CoordinatorAgent({
    db: store.db,
    coordination: new Coordination(store),
    cfg: mergeCoordinatorConfig({}),
    sessions: () => new Map(),
    events: () => [],
    send: async () => ({ ok: true }),
    askSeveral: async (prompt, cwd, members) => (started.push({ prompt, cwd, members }), { id: "g1" }),
    group: (id) =>
      id === "g1"
        ? ({ id: "g1", prompt: "Which queue?", status: "answered", members: [{ label: "Claude", state: "answered", answer: "SQS" }], synthesis: { state: "done", text: "Both prefer SQS." } } as any)
        : null,
    escalate: () => {},
    push: () => {},
    timers: false,
  });
  agent.setMode("active");
  const r: any = await agent.callTool("ask_several", { prompt: "Which queue should we use?", cwd: "/home/u/app", reason: "user asked" });
  expect(r.result.proposed).toBe(true);
  expect(started).toHaveLength(0);
  await agent.approve(r.result.proposal.id);
  expect(started).toEqual([{ prompt: "Which queue should we use?", cwd: "/home/u/app", members: [{ provider: "claude" }, { provider: "codex" }] }]);
  await expect(agent.approve(r.result.proposal.id)).rejects.toThrow();
  expect(started).toHaveLength(1);
  const g: any = await agent.callTool("get_group", { groupId: "g1" });
  expect(g.result.synthesis.text).toBe("Both prefer SQS.");
  store.db.close();
});
