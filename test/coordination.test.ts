import { describe, expect, test } from "bun:test";
import { Coordination, overlaps } from "../src/daemon/coordination.ts";
import { Store } from "../src/daemon/db.ts";
import { blankSession } from "../src/daemon/state.ts";

const fresh = () => new Coordination(new Store("", ":memory:"));
const live = (...ids: string[]) => new Map(ids.map((id) => [id, Object.assign(blankSession(id, "claude", "tui", id), { execution: "working" as const }) as ReturnType<typeof blankSession>]));

describe("claims", () => {
  test("overlap rules", () => {
    expect(overlaps("path:/r/src/**", "path:/r/src/a.ts")).toBe(true);
    expect(overlaps("path:/r/src", "path:/r/srcx/a.ts")).toBe(false);
    expect(overlaps("port:3000", "port:3000")).toBe(true);
    expect(overlaps("port:3000", "path:/3000")).toBe(false);
  });

  test("two tasks requesting an exclusive resource cannot both acquire it; release grants the waiter", () => {
    const c = fresh();
    const a = c.claim("s1", "db:staging");
    const b = c.claim("s2", "db:staging");
    expect(a.granted).toBe(true);
    expect(b.granted).toBe(false);
    expect(b.blockedBy?.id).toBe(a.claim.id);
    expect(c.claims(["active"]).map((x) => x.owner)).toEqual(["s1"]);
    expect(() => c.release(a.claim.id, "s2")).toThrow(); // not the owner
    const granted = c.release(a.claim.id, "s1");
    expect(granted.map((x) => x.owner)).toEqual(["s2"]);
  });

  test("stale owner becomes suspect but keeps the claim; ended owner is flagged, not dispossessed", () => {
    const c = fresh();
    const { claim } = c.claim("s1", "path:/r/src/**");
    const sessions = live("s1");
    sessions.get("s1")!.execution = "idle";
    const r = c.sweep(sessions, claim.heartbeatAt + 16 * 60_000);
    expect(r.suspect.map((x) => x.id)).toEqual([claim.id]);
    expect(c.claims(["suspect"]).length).toBe(1);
    expect(c.claim("s2", "path:/r/src/x.ts").granted).toBe(false); // still protected
    const r2 = c.sweep(new Map(), Date.now());
    expect(r2.orphaned.length).toBe(1);
    expect(c.claims(["suspect"])[0].note).toContain("inspect");
  });
});

describe("conflicts", () => {
  test("same file by two sessions; claimed area; perspective group flagged but marked", () => {
    const c = fresh();
    const raised: string[] = [];
    c.onConflict = (x) => raised.push(`${x.kind}:${x.sameGroup}`);
    const s = live("a", "b", "g1", "g2");
    c.groupOf = (id) => (id.startsWith("g") ? "grp" : null);
    c.recordEdit("a", "/r/x.ts", 1000, s);
    c.recordEdit("b", "/r/x.ts", 2000, s);
    c.recordEdit("g1", "/r/y.ts", 1000, s);
    c.recordEdit("g2", "/r/y.ts", 2000, s);
    c.claim("a", "path:/r/core/**");
    c.recordEdit("b", "/r/core/z.ts", 3000, s);
    expect(raised).toEqual(["same_file:false", "same_file:true", "claimed_area:false"]);
    expect(c.lookup("/r/core/z.ts", "b").claimedBy?.owner).toBe("a");
    expect(c.lookup("/r/x.ts", "a", 3000).recentEditors.map((e) => e.session)).toEqual(["b"]);
  });

  test("dependencies block and unblock", () => {
    const c = fresh();
    const a = c.createTask({ title: "schema", acceptance: ["schema checked"] }, "human");
    const b = c.createTask({ title: "api", prerequisites: [a.id], acceptance: ["api checked"] }, "human");
    expect(b.status).toBe("blocked");
    c.updateTask(a.id, { status: "finished_unverified" }, "human");
    expect(c.task(b.id)!.status).toBe("blocked");
    c.recordEvidence(a.id, "human", "Schema reviewed", { criterion: "schema checked" });
    expect(c.task(b.id)!.status).toBe("unassigned");
  });
});
