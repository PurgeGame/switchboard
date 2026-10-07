import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/daemon/db.ts";
import { Coordination, overlaps } from "../src/daemon/coordination.ts";
import { CoordinatorAgent } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { blankSession } from "../src/daemon/state.ts";
import { startHttp } from "../src/daemon/http.ts";
import { canonical } from "../src/daemon/grants.ts";
import type { Session, SbEvent } from "../src/shared/types.ts";
import { withMessageLimits } from "./message-limits.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sb-p1-authority-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = new Store("", ":memory:");
  cleanup.push(() => db.db.close());
  const c = new Coordination(db),
    sessions = new Map<string, Session>();
  const add = (id: string, cwd = root) => {
    const s = { ...blankSession(id, "claude", "tui", id), cwd, execution: "idle" as const };
    sessions.set(id, s);
    return s;
  };
  const sends: string[] = [],
    launches: string[] = [],
    flags: string[] = [];
  const agent = new CoordinatorAgent({
    db: db.db,
    coordination: c,
    cfg: mergeCoordinatorConfig(withMessageLimits()),
    sessions: () => sessions,
    events: () => [],
    send: async (id) => {
      sends.push(id);
      return { ok: true };
    },
    launch: async (spec) => {
      const id = `worker${launches.length}`;
      launches.push(id);
      add(id, spec.cwd);
      return id;
    },
    createWorktree: async () => {
      const path = join(root, "isolated");
      mkdirSync(path, { recursive: true });
      return path;
    },
    escalate: (_, title) => flags.push(title),
    push: () => {},
    timers: false,
  });
  const o = c.createObjective("Human objective", "", undefined, "human");
  c.grantObjective(o.id, {
    root,
    resources: ["port:34567"],
    verification: [{ criterion: "answer", kind: "response_equals", expected: "YES" }],
  }, "human");
  agent.setMode("active");
  let sequence = 0;
  const task = (patch: any = {}) =>
    c.createTask({
      title: "Task",
      objectiveId: o.id,
      acceptance: ["answer"],
      scope: { paths: [join(root, `file${sequence++}`)], resources: [] },
      ...patch,
    }, "human");
  const own = (id = "owner", patch: any = {}) => {
    add(id);
    agent.setAutopilot(id, true);
    return task({ owner: id, ...patch });
  };
  const source = (owner: string, sourceId: string, text = "YES", ts = Date.now() + 1) =>
    db.insertEvent({ sessionId: owner, sourceId, type: "assistant_msg", ts, data: { text } });
  return { root, db, c, sessions, add, agent, o, task, own, source, sends, launches, flags };
}

test("MCP cannot manufacture a grant, edit acceptance, or forge completion evidence", async () => {
  const x = fixture(),
    t = x.own();
  expect((await x.agent.callTool("grant_objective", { objectiveId: x.o.id, root: "/" })).ok).toBe(false);
  expect((await x.agent.callTool("update_task", { taskId: t.id, acceptance: ["always passes"], reason: "change" })).ok).toBe(false);
  expect((await x.agent.callTool("update_task", { taskId: t.id, status: "verified", reason: "claimed done" })).ok).toBe(false);
  expect(
    (
      await x.agent.callTool("record_evidence", {
        taskId: t.id,
        criterion: "answer",
        text: "claimed",
        verifiedBy: "deep-model",
        sourceId: "missing",
        reason: "claim",
      })
    ).ok,
  ).toBe(false);
  expect(x.c.task(t.id)?.evidence).toEqual([]);
});

test("grant roots, symlinks, recipients, branch and resource scope are enforced", async () => {
  const x = fixture(),
    external = mkdtempSync(join(tmpdir(), "sb-p1-external-"));
  cleanup.push(() => rmSync(external, { recursive: true, force: true }));
  symlinkSync(external, join(x.root, "escape"));
  for (const scope of [
    { paths: [join(x.root, "escape/new")], resources: [] },
    { paths: [], resources: ["port:8888"] },
    { paths: ["../outside"], resources: [] },
  ]) {
    const r = await x.agent.callTool("create_task", {
      title: "escape",
      objectiveId: x.o.id,
      scope,
      acceptance: ["answer"],
      reason: JSON.stringify(scope),
    });
    expect(r.ok).toBe(false);
  }
  const t = x.task();
  x.add("outside", external);
  x.agent.setAutopilot("outside", true);
  expect(() => x.c.updateTask(t.id, { owner: "outside" }, "human")).toThrow(/outside human grant/);
  expect(() => x.c.grantObjective(x.o.id, { root: x.root }, "coordinator")).toThrow(/human/);
  expect(canonical(join(x.root, "escape/missing"))).toBe(join(external, "missing"));
});

test("MCP launch outside grant, without grant, and with an unfinished prerequisite never calls launcher", async () => {
  const x = fixture(),
    t = x.task();
  expect((await x.agent.callTool("launch_session", { taskId: t.id, repo: "/", reason: "outside" })).ok).toBe(false);
  const dependent = x.task({ prerequisites: [t.id] });
  x.c.updateTask(t.id, { status: "finished_unverified" }, "human");
  expect((await x.agent.callTool("launch_session", { taskId: dependent.id, repo: x.root, reason: "unverified" })).ok).toBe(false);
  x.c.revokeObjective(x.o.id, "human");
  expect((await x.agent.callTool("launch_session", { taskId: t.id, repo: x.root, reason: "revoked" })).ok).toBe(false);
  expect(x.launches).toHaveLength(0);
  expect(x.c.reservations()).toHaveLength(0);
});

test("atomic resource acquisition blocks a second task before work starts", async () => {
  const x = fixture();
  const first = x.task({ scope: { paths: [join(x.root, "a")], resources: ["port:34567"] } });
  const second = x.task({ scope: { paths: [join(x.root, "b")], resources: ["port:34567"] } });
  x.c.reserveLaunch(first.id, x.root);
  const published: string[][] = [];
  x.c.onChange = () => published.push(x.c.claims().map((c) => c.taskId!));
  expect(() => x.c.reserveLaunch(second.id, x.root)).toThrow(/claim/);
  await Promise.resolve();
  expect(x.c.reservations()).toHaveLength(1);
  expect(x.c.claims().filter((c) => c.taskId === second.id)).toHaveLength(0);
  expect(published.flat()).not.toContain(second.id);
});

test("one concurrent launch per task, uncertain launch survives restart without releasing resources", async () => {
  const x = fixture(),
    t = x.task();
  let attempts = 0;
  (x.agent as any).d.launch = async () => {
    attempts++;
    throw Error("Lost acknowledgment after starting process");
  };
  const args = { taskId: t.id, repo: x.root, reason: "dispatch" };
  await Promise.all([x.agent.callTool("launch_session", args), x.agent.callTool("launch_session", { ...args, prompt: "second caller" })]);
  expect(attempts).toBe(1);
  const restored = new Coordination(x.db);
  expect(restored.reservation(t.id)?.state).toBe("uncertain");
  expect(() => restored.reserveLaunch(t.id, x.root)).toThrow(/reservation/);
  expect(restored.claims().every((c) => c.owner.startsWith("reservation:"))).toBe(true);
});

test("exclusive claims cannot be bypassed by reusing an owner or a shared claim", () => {
  const x = fixture();
  const scope = { paths: [], resources: ["port:34567"] };
  x.own("owner", { scope });
  expect(() => x.task({ owner: "owner", scope })).toThrow(/claim/);
  x.c.claim("a", "db:shared", { exclusive: false, taskId: "a" });
  x.c.claim("b", "db:shared", { exclusive: false, taskId: "b" });
  expect(x.c.claim("a", "db:shared", { exclusive: true, taskId: "a" }).granted).toBe(false);
});

// p1/fixes H3: nothing reached the provider, so the reservation and its claims are released.
test("revocation while preparing worktree blocks the launch; nothing started, so reservation and claims are released", async () => {
  const x = fixture(),
    t = x.task();
  (x.agent as any).d.createWorktree = async () => {
    x.c.revokeObjective(x.o.id, "human");
    return join(x.root, "worktree");
  };
  expect((await x.agent.callTool("launch_session", { taskId: t.id, repo: x.root, reason: "launch" })).ok).toBe(false);
  expect(x.launches).toHaveLength(0);
  expect(x.c.claims()).toHaveLength(0);
  expect(x.c.reservations()).toHaveLength(0);
});

test("a human task edit during provider launch wins without orphaning the worker or its claims", async () => {
  const x = fixture(),
    t = x.task();
  (x.agent as any).d.launch = async (spec: any) => {
    x.c.updateTask(t.id, { title: "Human changed priority and instructions", priority: "high" }, "human");
    x.add("already-started", spec.cwd);
    return "already-started";
  };
  expect((await x.agent.callTool("launch_session", { taskId: t.id, repo: x.root, reason: "launch" })).ok).toBe(false);
  expect(x.c.task(t.id)?.title).toBe("Human changed priority and instructions");
  expect(x.c.task(t.id)?.owner).toBeNull();
  expect(x.c.reservation(t.id)).toMatchObject({ state: "uncertain", sessionId: "already-started" });
  expect(x.c.claims()[0].owner).toBe("already-started");
  expect(x.agent.autonomous("already-started")).toBe(false);
  expect(x.flags).toEqual(["Launch needs inspection"]);
});

test("approval is consumed before sending, persists through restart and cannot bypass rate limits", async () => {
  const x = fixture(),
    t = x.own();
  const first: any = await x.agent.callTool("send_message", {
    sessionId: t.owner,
    taskId: t.id,
    text: "git reset --hard",
    reason: "held one",
  });
  const second: any = await x.agent.callTool("send_message", {
    sessionId: t.owner,
    taskId: t.id,
    text: "force-push branch",
    reason: "held two",
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  (x.agent as any).d.send = async (id: string) => {
    x.sends.push(id);
    await pending;
    return { ok: true };
  };
  const approving = x.agent.approve(first.result.proposal.id);
  const restarted = new CoordinatorAgent((x.agent as any).d);
  await expect(x.agent.approve(first.result.proposal.id)).rejects.toThrow(/approved/);
  await expect(restarted.approve(first.result.proposal.id)).rejects.toThrow(/approved/);
  const limited = await restarted.approve(second.result.proposal.id);
  expect(limited.state).toBe("failed");
  expect(limited.detail).toMatch(/cooldown/);
  expect(x.sends).toHaveLength(1);
  release();
  await approving;
});

test("concurrent direct messages reserve the cooldown before awaiting transport", async () => {
  const x = fixture(),
    t = x.own();
  await Promise.all([
    x.agent.callTool("send_message", { sessionId: t.owner, taskId: t.id, text: "First distinct instruction", reason: "one" }),
    x.agent.callTool("send_message", { sessionId: t.owner, taskId: t.id, text: "Second completely different request", reason: "two" }),
  ]);
  expect(x.sends).toHaveLength(1);
});

test("manual instruction, revoked grant and exclusion also gate proposal approvals", async () => {
  const x = fixture(),
    t = x.own();
  const r: any = await x.agent.callTool("send_message", { sessionId: t.owner, taskId: t.id, text: "git reset --hard", reason: "screen" });
  expect(r.result.held).toBe(true);
  x.c.revokeObjective(x.o.id, "human");
  await expect(x.agent.approve(r.result.proposal.id)).rejects.toThrow(/grant/);
  expect(x.sends).toHaveLength(0);
  x.agent.setExcluded(t.owner!, true);
  await expect(x.agent.approve(r.result.proposal.id)).rejects.toThrow(/excluded|cancelled/);
});

test("revoked grants invalidate autonomous sends without granting a replacement through proposals", async () => {
  const x = fixture(),
    t = x.own();
  x.c.revokeObjective(x.o.id, "human");
  await x.agent.callTool("send_message", { sessionId: t.owner, taskId: t.id, text: "do work", reason: "try" });
  expect(x.sends).toHaveLength(0);
  expect(() => x.agent.assertDispatch(t.owner!, t.id, true)).toThrow(/grant/);
});

test("source-bound declared predicates verify; a higher-tier assertion and unrelated/stale events do not", () => {
  const x = fixture(),
    t = x.own();
  x.source("other", "other-source");
  expect(() => x.c.recordEvidence(t.id, "coordinator", "claim", { criterion: "answer", sourceId: "other-source" })).toThrow(/source/);
  x.source(t.owner!, "stale", "YES", t.createdAt - 1);
  expect(() => x.c.recordEvidence(t.id, "coordinator", "claim", { criterion: "answer", sourceId: "stale" })).toThrow(/stale/);
  x.source(t.owner!, "wrong", "NO");
  expect(() => x.c.recordEvidence(t.id, "coordinator", "claim", { criterion: "answer", sourceId: "wrong" })).toThrow(/match/);
  x.source(t.owner!, "actual");
  x.c.recordEvidence(t.id, "coordinator", "Observed exact response", { criterion: "answer", sourceId: "actual" });
  expect(x.c.isVerified(x.c.task(t.id)!)).toBe(true);
});

test("an ended worker can supply observed completion evidence but cannot receive new dispatch", async () => {
  const x = fixture(),
    t = x.own();
  x.source(t.owner!, "final");
  (x.agent as any).d.events = (id: string) => x.db.events(id);
  const history: any = await x.agent.callTool("get_session", { sessionId: t.owner });
  expect(history.result.recent[0].sourceId).toBe("final");
  x.sessions.get(t.owner!)!.execution = "ended";
  expect(
    (
      await x.agent.callTool("record_evidence", {
        taskId: t.id,
        criterion: "answer",
        sourceId: "final",
        text: "Observed final answer",
        reason: "check",
      })
    ).ok,
  ).toBe(true);
  expect(x.c.isVerified(x.c.task(t.id)!)).toBe(true);
  expect(() => x.agent.assertDispatch(t.owner!, t.id)).toThrow(/ended/);
});

test("a human task edit holds stale scheduling, and a rejected task cannot be reopened by MCP", async () => {
  const x = fixture(),
    t = x.own();
  const edited = x.c.updateTask(t.id, { priority: "high" }, "human");
  x.agent.onHumanTaskEdit(edited, t.owner);
  expect((await x.agent.callTool("update_task", { taskId: t.id, status: "in_progress", reason: "stale scheduling" })).ok).toBe(false);
  expect(() => x.agent.assertDispatch(t.owner!, t.id)).toThrow(/hold/);
  const other = x.task();
  x.c.updateTask(other.id, { status: "rejected" }, "human");
  expect((await x.agent.callTool("update_task", { taskId: other.id, status: "in_progress", reason: "reopen" })).ok).toBe(false);
});

test("human evidence is required for general criteria and every criterion must pass", () => {
  const x = fixture(),
    t = x.own("owner", { acceptance: ["answer", "code reviewed"] });
  x.source(t.owner!, "actual");
  x.c.recordEvidence(t.id, "coordinator", "Observed answer", { criterion: "answer", sourceId: "actual" });
  x.c.recordEvidence(t.id, "coordinator", "Model says code looks good", { criterion: "code reviewed", sourceId: "actual" });
  expect(x.c.task(t.id)?.status).not.toBe("verified");
  x.c.recordEvidence(t.id, "human", "Reviewed actual diff", { criterion: "code reviewed" });
  expect(x.c.task(t.id)?.status).toBe("verified");
  x.c.updateTask(t.id, { acceptance: ["new review"] }, "human");
  expect(x.c.task(t.id)?.status).toBe("finished_unverified");
});

test("file predicates inspect the owner tree, respect task scope and refuse symlink escape", () => {
  const x = fixture();
  x.c.grantObjective(x.o.id, {
    root: x.root,
    verification: [{ criterion: "file", kind: "file_contains", path: "file.txt", expected: "expected" }],
  }, "human");
  const t = x.own("owner", { acceptance: ["file"], scope: { paths: [join(x.root, "file.txt")], resources: [] } });
  x.source(t.owner!, "actual");
  writeFileSync(join(x.root, "file.txt"), "expected");
  expect(x.c.recordEvidence(t.id, "coordinator", "Inspected file", { criterion: "file", sourceId: "actual" }).status).toBe("verified");
  rmSync(join(x.root, "file.txt"));
  symlinkSync("/etc/hostname", join(x.root, "file.txt"));
  expect(() => x.c.recordEvidence(t.id, "coordinator", "symlink", { criterion: "file", sourceId: "actual" })).toThrow(/outside|escapes/);
});

test("missing prerequisites and dependency cycles cannot silently disappear", () => {
  const x = fixture(),
    a = x.task();
  expect(() => x.task({ prerequisites: ["missing"] })).toThrow(/prerequisite/);
  const b = x.task({ prerequisites: [a.id] });
  expect(() => x.c.updateTask(a.id, { prerequisites: [b.id] }, "human")).toThrow(/cyclic/);
  expect(() => x.c.updateTask(b.id, { prerequisites: [] }, "coordinator")).toThrow(/human/);
});

test("file checks use the granted repo root for unmanaged sessions in a subdirectory", () => {
  const x = fixture();
  x.c.grantObjective(x.o.id, {
    root: x.root,
    verification: [{ criterion: "file", kind: "file_contains", path: "file.txt", expected: "expected" }],
  }, "human");
  const subdir = join(x.root, "subdir");
  mkdirSync(subdir);
  x.add("nested", subdir);
  const t = x.task({ owner: "nested", acceptance: ["file"], scope: { paths: [join(x.root, "file.txt")], resources: [] } });
  x.source("nested", "actual");
  writeFileSync(join(subdir, "file.txt"), "expected");
  writeFileSync(join(x.root, "file.txt"), "wrong");
  expect(() => x.c.recordEvidence(t.id, "coordinator", "wrong tree", { criterion: "file", sourceId: "actual" })).toThrow(/expected/);
  writeFileSync(join(x.root, "file.txt"), "expected");
  expect(x.c.recordEvidence(t.id, "coordinator", "granted tree", { criterion: "file", sourceId: "actual" }).status).toBe("verified");
});

test("a recorded managed worktree outside the root gets translated scope and file verification", async () => {
  const x = fixture(),
    worktree = mkdtempSync(join(tmpdir(), "sb-authority-worktree-"));
  cleanup.push(() => rmSync(worktree, { recursive: true, force: true }));
  x.c.grantObjective(x.o.id, {
    root: x.root,
    verification: [{ criterion: "file", kind: "file_contains", path: "file.txt", expected: "expected" }],
  }, "human");
  const t = x.task({ acceptance: ["file"], scope: { paths: [], resources: ["path:" + join(x.root, "file.txt")] } });
  (x.agent as any).d.createWorktree = async () => worktree;
  const launch = (x.agent as any).d.launch;
  (x.agent as any).d.launch = async (spec: any) => {
    expect(spec.prompt).toContain(join(worktree, "file.txt"));
    expect(spec.prompt).not.toContain(join(x.root, "file.txt"));
    return launch(spec);
  };
  expect(
    (
      await x.agent.callTool("launch_session", {
        taskId: t.id,
        repo: x.root,
        tier: "deep",
        tierReason: "deep review",
        reason: "isolated worker",
      })
    ).ok,
  ).toBe(true);
  expect(x.c.task(t.id)?.humanRevision).toBeUndefined();
  expect(x.db.db.query("SELECT actor FROM authority_audit WHERE action='task_updated' ORDER BY id DESC LIMIT 1").get()).toEqual({
    actor: "coordinator",
  });
  const owner = x.c.task(t.id)!.owner!;
  expect(x.agent.autonomous(owner)).toBe(true);
  x.source(owner, "final");
  writeFileSync(join(worktree, "file.txt"), "expected");
  expect(x.c.recordEvidence(t.id, "coordinator", "checked managed tree", { criterion: "file", sourceId: "final" }).status).toBe("verified");
});

test("root claims overlap descendants, and granted state/revocation survives restart", () => {
  const x = fixture(),
    t = x.own();
  expect(overlaps("path:/", `path:${x.root}/file`)).toBe(true);
  expect(overlaps(`path:${x.root}`, `path:${x.root}-other`)).toBe(false);
  x.c.revokeObjective(x.o.id, "human");
  const restored = new Coordination(x.db);
  restored.session = (id) => x.sessions.get(id);
  expect(() => restored.checkDispatch(t.id, t.owner!)).toThrow(/grant/);
  expect(restored.claims()[0].owner).toBe(t.owner!);
});

test("flag_user remains usable while paused or exhausted, with a bounded rate", async () => {
  const x = fixture();
  x.agent.setMode("paused");
  x.agent.budget.record(999);
  for (let i = 0; i < 6; i++) expect((await x.agent.callTool("flag_user", { title: `blocker${i}`, text: "context" })).ok).toBe(true);
  for (let i = 0; i < 110; i++) x.agent.log("note", "info", "Activity must not displace the durable escalation cap");
  expect((await x.agent.callTool("flag_user", { title: "too many", text: "context" })).ok).toBe(false);
  expect(x.flags).toHaveLength(6);
});

test("migration marks old objectives ungranted and verified claims historical, preserving owners", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-p1-migration-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const x = fixture(),
    o = x.o,
    t = x.task();
  const { claim } = x.c.claim("still-running", "port:34567");
  const old = new Database(join(root, "switchboard.db"));
  old.exec(readFileSync(join(import.meta.dir, "fixtures/phase1-schema-v13.sql"), "utf8"));
  old.query("INSERT INTO objectives VALUES(?,?)").run(o.id, JSON.stringify({ ...o, grant: { issuedBy: "human", root: "/" } }));
  old.query("INSERT INTO tasks VALUES(?,?)").run(t.id, JSON.stringify({ ...t, status: "verified" }));
  old.query("INSERT INTO claims VALUES(?,?,?,?,?)").run(claim.id, claim.resource, claim.owner, claim.state, JSON.stringify(claim));
  old.close();
  const next = new Store(root);
  cleanup.push(() => next.db.close());
  const migrated = new Coordination(next);
  expect(migrated.objective(o.id)?.grant).toBeNull();
  expect(migrated.task(t.id)?.historicalVerified).toBeDefined();
  expect(migrated.task(t.id)?.status).toBe("finished_unverified");
  expect(migrated.claims()[0].owner).toBe("still-running");
});

test("HTTP human routes and HTTP MCP tool routes reject forged authority and unsupported verified status", async () => {
  const x = fixture(),
    token = "a".repeat(64);
  // Reserve an ephemeral port; no production daemon/data, scans or provider objects are used.
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const registry: any = { sessions: x.sessions, onPush: () => {}, all: () => [...x.sessions.values()] };
  const { server } = startHttp({
    port,
    token,
    registry,
    store: x.db,
    coordination: x.c,
    coordinator: x.agent,
    webDist: x.root,
    system: () => null,
  } as any);
  cleanup.push(() => server.stop(true));
  async function post(path: string, body: any, authenticated = true) {
    return fetch(`http://127.0.0.1:${port}/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }
  expect((await post(`objectives/${x.o.id}/grant`, { root: "/" }, false)).status).toBe(401);
  expect((await post("objectives", { title: "Self", grant: { root: "/", issuedBy: "human" } })).status).toBe(409);
  const before = x.c.snapshot().objectives.length;
  const proposed = await post("coordinator/tool/create_objective", { title: "Self", reason: "spoof", actor: "human", granted: true });
  expect(proposed.status).toBe(200);
  expect(x.c.snapshot().objectives).toHaveLength(before);
  const t = x.task();
  expect((await post(`tasks/${t.id}`, { status: "verified", verifiedEvidence: [{ verifiedBy: "human" }] })).status).toBe(409);
  expect((await post(`tasks/${t.id}`, { status: "verified" })).status).toBe(409);
  const launch: any = await (await post("coordinator/tool/launch_session", { taskId: t.id, repo: "/", reason: "bypass" })).json();
  expect(launch.ok).toBe(false);
  expect(x.launches).toHaveLength(0);
  expect((await post(`objectives/${x.o.id}/revoke`, {})).status).toBe(200);
  expect(x.c.objective(x.o.id)?.grant?.revokedAt).toBeTruthy();
});
