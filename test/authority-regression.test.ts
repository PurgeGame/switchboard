import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/daemon/db.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { CoordinatorAgent } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";

function fixture() {
  const store = new Store("", ":memory:");
  const coordination = new Coordination(store);
  const agent = new CoordinatorAgent({
    db: store.db,
    coordination,
    cfg: mergeCoordinatorConfig({}),
    sessions: () => new Map(),
    events: () => [],
    send: async () => {
      throw Error("No real transport in authority tests");
    },
    escalate: () => {},
    push: () => {},
    timers: false,
  });
  agent.setMode("active");
  return { store, coordination, agent };
}

test("authority regression: claudeSelfGrantViaMcp creates only a proposal", async () => {
  const { store, coordination, agent } = fixture();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sb-self-grant-")));
  try {
    const r: any = await agent.callTool("create_objective", {
      title: "Self-grant",
      reason: "agent says user asked",
      granted: true,
      root,
    });
    expect(coordination.snapshot().objectives).toHaveLength(0);
    expect(r.result.proposed).toBe(true);
    // A root the approval would refuse isn't even proposed.
    expect((await agent.callTool("create_objective", { title: "Self-grant", reason: "r", granted: true, root: "/arbitrary" })).ok).toBe(false);
    expect(coordination.snapshot().objectives).toHaveLength(0);
  } finally {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("authority regression: claudeVerifiedWithoutEvidence cannot set verified", () => {
  const { store, coordination } = fixture();
  try {
    const task = coordination.createTask({ title: "Standard task", acceptance: ["tests pass"] }, "human");
    expect(() => coordination.updateTask(task.id, { status: "verified" }, "human")).toThrow(/evidence/i);
    expect(coordination.task(task.id)?.status).not.toBe("verified");
  } finally {
    store.db.close();
  }
});

test("authority regression: claudeDependencyAfterUnverifiedFinish stays blocked", () => {
  const { store, coordination } = fixture();
  try {
    const a = coordination.createTask({ title: "First", acceptance: ["first done"] }, "human");
    const b = coordination.createTask({ title: "Second", acceptance: ["second done"], prerequisites: [a.id] }, "human");
    coordination.updateTask(a.id, { status: "finished_unverified" }, "human");
    expect(coordination.blockedBy(b)).toEqual([a.id]);
    expect(coordination.task(b.id)?.status).toBe("blocked");
  } finally {
    store.db.close();
  }
});
