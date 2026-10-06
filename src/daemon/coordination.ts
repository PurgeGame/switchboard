// Coordination state: objectives, tasks, claims, conflicts. Everything durable lives here so
// nothing depends on the coordinator agent's memory.
// - claims are acquired atomically (BEGIN IMMEDIATE); overlapping exclusive claims queue
// - an expired heartbeat makes the owner *suspect*; resources are never reassigned while the
//   owner might still be writing (only after its session ended, or on explicit approval)
// - conflicts are deterministic: same file edited by two sessions within 60 min, an edit
//   inside another session's claim, two live sessions writing in one worktree+branch
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Claim, Conflict, Objective, SbEvent, Session, Task, HumanGrant, LaunchReservation } from "../shared/types.ts";
import type { Store } from "./db.ts";
import { canonical, dirIdentity, pathScope, resourceKey, requireGrant, requireTaskScope, verifyDir, within } from "./grants.ts";
import { validateChecks, verifyDeclaredCheck, evidenceRevision, launchRevision } from "./verification.ts";

/** Who is acting. Required everywhere: no path silently assumes human authority. */
export type Actor = "human" | "coordinator";
const ACTIVE_TASK = ["unassigned", "assigned", "in_progress"];

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);
export const SAME_FILE_WINDOW_MS = 60 * 60_000;
export const HEARTBEAT_STALE_MS = 15 * 60_000;

/** Does an exclusive claim on `a` overlap one on `b`? Paths: equal, or one is inside the other's dir/glob. */
export function overlaps(a: string, b: string): boolean {
  const [ka, va] = splitRes(a);
  const [kb, vb] = splitRes(b);
  if (ka !== kb) return false;
  if (ka !== "path") return va === vb;
  const base = (p: string) =>
    p
      .replace(/\/\*\*$/, "")
      .replace(/\/\*$/, "")
      .replace(/\/+$/, "") || "/";
  // Never throws (it runs inside claims, the PreToolUse soft-lock and event hooks). A relative
  // path (a legacy claim, a transcript edit) can't be placed: it matches nothing here, and
  // Coordination resolves those against the owning session's cwd before comparing.
  const x = absPath(base(va)),
    y = absPath(base(vb));
  if (x === null || y === null) return false;
  return within(x, y) || within(y, x);
}

function absPath(p: string): string | null {
  if (!isAbsolute(p)) return null;
  try {
    return canonical(p);
  } catch {
    return resolve(p); // EACCES/ELOOP etc.: compare lexically
  }
}

const splitRes = (r: string): [string, string] => {
  const i = r.indexOf(":");
  return i < 0 ? ["other", r] : [r.slice(0, i), r.slice(i + 1)];
};

/** Is file `path` inside claimed resource `res`? */
export const pathInClaim = (path: string, res: string) => overlaps(`path:${path}`, res);

export class Coordination {
  private objectives = new Map<string, Objective>();
  private tasks = new Map<string, Task>();
  /** Recent edits: path -> [{session, at}] */
  private edits = new Map<string, { session: string; at: number }[]>();
  private conflicts = new Map<string, Conflict>();
  /** Session -> perspective group id (members are expected to overlap). */
  groupOf: (sessionId: string) => string | null = () => null;
  onChange: () => void = () => {};
  onConflict: (c: Conflict) => void = () => {};
  private changeQueued = false;
  private changed() {
    if (!this.store.db.inTransaction) return this.onChange();
    if (this.changeQueued) return;
    this.changeQueued = true;
    // Publish committed reality, never a partially acquired set of claims that may roll back.
    queueMicrotask(() => {
      this.changeQueued = false;
      this.onChange();
    });
  }

  session: (id: string) => Session | undefined = (id) => this.store.loadSessions().find((s) => s.id === id);
  constructor(private store: Store) {
    for (const r of store.db.query("SELECT data FROM objectives").all() as { data: string }[]) {
      const o = JSON.parse(r.data) as Objective;
      this.objectives.set(o.id, o);
    }
    // p1/fixes4: grants issued before root identities were recorded get the identity of the
    // directory their (still canonical) root names now; from then on that directory is the grant.
    for (const o of this.objectives.values()) {
      const g = o.grant;
      if (!g || g.rootId || g.revokedAt) continue;
      try {
        if (canonical(g.root) !== g.root) continue; // stays refused by requireGrant
        this.saveObjective({ ...o, grant: { ...g, rootId: dirIdentity(g.root) } });
        this.audit("daemon", "grant_root_identity_recorded", { objectiveId: o.id, root: g.root });
      } catch {
        /* missing root: requireGrant refuses it */
      }
    }
    for (const r of store.db.query("SELECT data FROM tasks").all() as { data: string }[]) {
      const t = JSON.parse(r.data) as Task;
      this.tasks.set(t.id, t);
    }
  }

  snapshot() {
    return {
      objectives: [...this.objectives.values()],
      tasks: [...this.tasks.values()],
      claims: this.claims(["active", "suspect", "waiting"]),
      conflicts: [...this.conflicts.values()].sort((a, b) => b.at - a.at),
    };
  }

  // ---- objectives, human grants, verification and dispatch (p1/authority)
  private audit(actor: string, action: string, data: unknown) {
    this.store.db
      .query("INSERT INTO authority_audit(at,actor,action,data) VALUES(?,?,?,?)")
      .run(Date.now(), actor, action, JSON.stringify(data));
  }
  objective(id: string) {
    return this.objectives.get(id);
  }
  createObjective(title: string, description: string, priority: Objective["priority"] | undefined, actor: Actor): Objective {
    if (actor !== "human") throw Error("Only the human may create objectives; propose new scope instead");
    priority ??= "normal";
    if (!title.trim() || !["high", "normal", "low"].includes(priority)) throw Error("Invalid objective");
    const o: Objective = {
      id: randomUUID(),
      title,
      description,
      status: "active",
      priority,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      grant: null,
    };
    this.saveObjective(o);
    this.audit(actor, "objective_created", { id: o.id });
    return o;
  }
  /** Validate a grant fully before anything is saved. Root: an existing directory, not / or $HOME. */
  private buildGrant(
    input: { root: string; resources?: string[]; verification?: unknown },
    provenance: string,
    exact = false,
  ): HumanGrant {
    if (typeof input?.root !== "string") throw Error("Grant needs an absolute root directory");
    const root = canonical(input.root);
    // An approved path is granted only as itself: this resolution is the one stored, so it is
    // checked here (a symlink swapped in after an earlier check would otherwise be followed).
    if (exact && root !== input.root) throw Error(`Proposed root ${input.root} now resolves to ${root}; nothing was granted`);
    let dir = false;
    try {
      dir = statSync(root).isDirectory();
    } catch {
      /* missing */
    }
    if (!dir) throw Error(`Grant root ${input.root} is not an existing directory`);
    // Pin the directory itself, then confirm the stored path still names it without a symlink.
    let rootId: string;
    try {
      rootId = dirIdentity(root);
      verifyDir(root, rootId, "Grant root");
    } catch {
      throw Error(`Grant root ${input.root} changed while it was being granted; nothing was granted`);
    }
    // `/`, $HOME, or any directory containing $HOME (e.g. /home) is too broad.
    if (root === "/" || within(canonical(homedir()), root))
      throw Error("Grant root is too broad (/, your home directory or a directory containing it); grant a repository");
    if (input.resources != null && !Array.isArray(input.resources)) throw Error("Grant resources must be a list");
    return {
      id: randomUUID(),
      root,
      rootId,
      resources: (input.resources ?? []).map(resourceKey),
      verification: validateChecks(input.verification),
      issuedBy: "human",
      issuedAt: Date.now(),
      revokedAt: null,
      provenance,
    };
  }
  grantObjective(
    id: string,
    input: { root: string; resources?: string[]; verification?: unknown },
    actor: Actor,
    provenance = "human grant route",
  ) {
    if (actor !== "human") throw Error("Only the human may issue a grant");
    const o = this.objective(id);
    if (!o) throw Error("Unknown objective");
    const stuck = this.snapshot().tasks.find(
      (t) => t.objectiveId === id && this.reservation(t.id) && this.reservation(t.id)!.state !== "launched",
    );
    if (stuck)
      throw Error(
        `Task ${stuck.id} has an unfinished launch reservation; inspect it and clear it (POST /api/tasks/${stuck.id}/reservation/clear) before changing the grant`,
      );
    const g = this.buildGrant(input, provenance);
    this.saveObjective({ ...o, grant: g, updatedAt: Date.now() });
    for (const t of this.tasks.values())
      if (t.objectiveId === id && t.status === "verified")
        this.saveTask({
          ...t,
          status: "finished_unverified",
          historicalVerified: { at: Date.now(), reason: "Grant changed; evidence requires review" },
        });
    this.audit(actor, "grant_issued", { objectiveId: id, grant: g });
    return this.objective(id)!;
  }
  /**
   * The grant a human approval of `root` would issue, built and checked but not stored. Used when
   * a proposal is made (fail early) and again on approval (the directory may have changed since).
   * The human approves the path as shown: it must name that directory itself, with no symlink
   * component (a worker can plant one, or swap it before approval) and no . or .. segments.
   */
  checkProposedGrant(p: { root: string; resources?: string[] }, provenance: string): HumanGrant {
    if (typeof p.root !== "string" || !isAbsolute(p.root)) throw Error("Grant needs an absolute root directory");
    const lexical = resolve(p.root);
    if (p.root.replace(/(.)\/+$/, "$1") !== lexical) throw Error(`Proposed root ${p.root} isn't a plain path (it has . or .. segments)`);
    const real = canonical(lexical);
    if (real !== lexical)
      throw Error(`Proposed root ${p.root} resolves through a symlink to ${real}; create the objective yourself with the real path if you want that`);
    return this.buildGrant({ root: real, resources: p.resources }, provenance, true);
  }
  /**
   * P1-A5: the human approved one exact coordinator proposal. The grant is validated before the
   * objective exists, so a bad root creates nothing.
   */
  createGrantedObjective(
    p: { title: string; description: string; priority?: Objective["priority"]; root: string; resources?: string[] },
    provenance: string,
    actor: Actor,
  ): Objective {
    if (actor !== "human") throw Error("Only the human may create and grant objectives");
    const g = this.checkProposedGrant(p, provenance);
    const o = this.createObjective(p.title, p.description, p.priority, actor);
    this.saveObjective({ ...o, grant: g, updatedAt: Date.now() });
    this.audit(actor, "grant_issued", { objectiveId: o.id, grant: g });
    return this.objective(o.id)!;
  }
  /** Is the objective's human grant usable right now? (No throw: for human bookkeeping paths.) */
  private grantActive(o: Objective | undefined) {
    try {
      requireGrant(o);
      return true;
    } catch {
      return false;
    }
  }
  revokeObjective(id: string, actor: Actor) {
    if (actor !== "human") throw Error("Only the human may revoke a grant");
    const o = this.objective(id);
    if (!o) throw Error("Unknown objective");
    this.saveObjective({ ...o, grant: o.grant ? { ...o.grant, revokedAt: Date.now() } : null, updatedAt: Date.now() });
    this.audit(actor, "grant_revoked", { objectiveId: id });
    return this.objective(id)!;
  }
  private saveObjective(o: Objective) {
    this.objectives.set(o.id, o);
    this.store.db
      .query("INSERT INTO objectives(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(o.id, JSON.stringify(o));
    this.changed();
  }
  private normalizeScope(scope: Task["scope"], o?: Objective): Task["scope"] {
    const root = o?.grant?.root ?? "/";
    if (!scope || !Array.isArray(scope.paths) || !Array.isArray(scope.resources)) throw Error("Invalid task scope");
    return { paths: [...new Set(scope.paths.map((p) => pathScope(p, root)))], resources: [...new Set(scope.resources.map(resourceKey))] };
  }
  private prerequisites(t: Task) {
    if (!Array.isArray(t.prerequisites)) throw Error("Invalid prerequisites");
    const visit = (id: string, seen = new Set<string>()): boolean => {
      if (id === t.id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (this.task(id)?.prerequisites ?? []).some((p) => visit(p, seen));
    };
    for (const id of t.prerequisites) {
      const p = this.task(id);
      if (!p || p.objectiveId !== t.objectiveId || visit(id)) throw Error("Unknown, cyclic or cross-objective prerequisite");
    }
  }
  createTask(p: Partial<Task> & { title: string }, actor: Actor): Task {
    if (
      Object.keys(p).some((k) =>
        ["id", "status", "evidence", "verifiedEvidence", "historicalVerified", "worktree", "createdAt", "createdBy"].includes(k),
      )
    )
      throw Error("Task completion/identity fields are not writable");
    if (
      !p.title?.trim() ||
      !Array.isArray(p.acceptance) ||
      !p.acceptance.length ||
      p.acceptance.some((a) => typeof a !== "string" || !a.trim())
    )
      throw Error("Task needs acceptance criteria");
    const o = p.objectiveId ? this.objective(p.objectiveId) : undefined;
    if (p.objectiveId && !o) throw Error("Unknown objective");
    const t: Task = {
      id: randomUUID(),
      title: p.title,
      description: p.description ?? "",
      objectiveId: p.objectiveId ?? null,
      owner: p.owner ?? null,
      scope: this.normalizeScope(p.scope ?? { paths: [], resources: [] }, o),
      priority: p.priority ?? "normal",
      tier: p.tier ?? "standard",
      tierReason: p.tierReason ?? null,
      prerequisites: [...new Set(p.prerequisites ?? [])],
      acceptance: [...new Set(p.acceptance)],
      status: "unassigned",
      result: null,
      evidence: [],
      verifiedEvidence: [],
      worktree: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: actor,
    };
    this.prerequisites(t);
    if (actor !== "human") requireTaskScope(t, o);
    if (this.blockedBy(t).length) t.status = "blocked";
    else if (t.owner) {
      // A human may record an owner on an ungranted (e.g. legacy) objective; dispatch stays
      // refused until it is granted, and claims are taken then.
      if (actor !== "human" || this.grantActive(o)) {
        this.assertTaskReady(t);
        this.assertRecipient(t, t.owner);
        this.claimTask(t, t.owner);
      }
      t.status = "assigned";
    }
    this.saveTask(t);
    this.audit(actor, "task_created", { id: t.id });
    return t;
  }
  updateTask(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>, actor: Actor): Task {
    const current = this.task(id);
    if (!current) throw Error("unknown task");
    const writable = [
      "title",
      "description",
      "owner",
      "scope",
      "priority",
      "tier",
      "tierReason",
      "prerequisites",
      "acceptance",
      "status",
      "result",
      "needsVerification",
    ];
    if (Object.keys(patch).some((k) => !writable.includes(k))) throw Error("Task identity/evidence fields are not writable");
    if (actor !== "human") {
      if (patch.acceptance !== undefined) throw Error("Only the human may change acceptance criteria");
      if (current.status === "rejected" && patch.status && patch.status !== "rejected") throw Error("Only the human may reopen a rejected task");
      if (patch.prerequisites && current.prerequisites.some((id) => !patch.prerequisites!.includes(id)))
        throw Error("Only the human may remove prerequisites");
      if (patch.needsVerification === false) throw Error("Verification cannot be waived by the coordinator");
      if (current.status === "verified" && patch.status !== undefined && patch.status !== "verified")
        throw Error("Only the human may change the status of a verified task; propose it instead");
      if (patch.status === "rejected" && current.status !== "rejected" && (current.createdBy ?? "human") === "human")
        throw Error("Only the human may reject a task the human created; propose it instead");
      if (patch.description !== undefined && patch.description !== current.description && current.status === "verified")
        throw Error("Only the human may rewrite a verified task's description");
    }
    return this.store.db
      .transaction(() => {
        const t: Task = structuredClone({ ...current, ...patch, updatedAt: Date.now() });
        if (actor === "human") t.humanRevision = (current.humanRevision ?? 0) + 1;
        if (!Array.isArray(t.acceptance) || !t.acceptance.length || t.acceptance.some((a) => typeof a !== "string" || !a.trim()))
          throw Error("Task needs acceptance criteria");
        if (!["unassigned", "assigned", "in_progress", "blocked", "finished_unverified", "verified", "rejected"].includes(t.status))
          throw Error("Invalid task status");
        const objective = t.objectiveId ? this.objective(t.objectiveId) : undefined;
        t.scope = this.normalizeScope(t.scope, objective);
        this.prerequisites(t);
        if (actor !== "human") requireTaskScope(t, objective);
        // A verified task's evidence is bound to its owner, scope, acceptance and prerequisites
        // (evidenceRevision). Changing any of them would silently downgrade a human or daemon
        // verification to finished_unverified, so only the human may do it.
        if (actor !== "human" && current.status === "verified" && evidenceRevision(t) !== evidenceRevision(current))
          throw Error("Only the human may change the owner, scope or prerequisites of a verified task; propose it instead");
        const ownerChanged = patch.owner !== undefined && patch.owner !== current.owner;
        // An explicit human reassignment is an instruction: the previous owner's claims for this
        // task are released (recorded in the audit), not silently kept or silently taken.
        if (actor === "human" && ownerChanged && current.owner) this.releaseTaskClaims(current, current.owner);
        if (patch.acceptance || patch.scope || patch.prerequisites || patch.owner !== undefined) {
          if (evidenceRevision(t) !== evidenceRevision(current)) {
            t.evidenceSince = Date.now();
            if (t.status === "verified") t.status = "finished_unverified";
          }
        }
        if (t.status === "verified" && !this.eligible(t))
          throw Error("Verified completion requires eligible evidence for every acceptance criterion");
        if (this.blockedBy(t).length) {
          // A verification stands on its own evidence: an unrelated edit (priority, title) must not
          // recompute a verified task as blocked because a prerequisite was unverified afterwards.
          if (t.status === "verified" && current.status !== "verified") throw Error("Prerequisites need verified evidence before completion");
          if (!["rejected", "finished_unverified", "verified"].includes(t.status)) t.status = "blocked";
        }
        if (["assigned", "in_progress"].includes(t.status) || (t.owner && ownerChanged && t.status !== "blocked")) {
          if (!t.owner) throw Error("Assigned task needs an owner");
          // Coordinator edits always pass the dispatch gate. Human edits only when they change who
          // or what would be dispatched, and only while the grant is usable: a human can still fix
          // a title after a revoke, or record an owner on an ungranted objective.
          const dispatchRelevant =
            ownerChanged || patch.scope !== undefined || patch.prerequisites !== undefined || (patch.status !== undefined && patch.status !== current.status);
          if (actor !== "human" || (dispatchRelevant && this.grantActive(objective))) {
            this.assertTaskReady(t);
            this.assertRecipient(t, t.owner);
            this.claimTask(t, t.owner);
          }
          if (t.status === "unassigned") t.status = "assigned";
        }
        // Whatever the route, a coordinator edit never ends a verified task's verified status.
        if (actor !== "human" && current.status === "verified" && t.status !== "verified")
          throw Error("Only the human may change the status of a verified task; propose it instead");
        this.saveTask(t);
        this.unblockDependents();
        this.audit(actor, "task_updated", { id, patch });
        return this.task(id)!;
      })
      .immediate();
  }
  /** Human reassignment: release what the previous owner holds for this task, and end its launch binding. */
  private releaseTaskClaims(t: Task, owner: string) {
    const released: number[] = [];
    for (const c of this.claims(["active", "suspect", "waiting"]))
      if (c.owner === owner && c.taskId === t.id) {
        this.release(c.id, "human");
        released.push(c.id);
      }
    const r = this.reservation(t.id);
    const endedBinding = r?.state === "launched" && r.sessionId === owner;
    if (endedBinding) this.store.db.query("DELETE FROM launch_reservations WHERE task_id=?").run(t.id);
    this.audit("human", "claims_released_on_reassign", { taskId: t.id, from: owner, claims: released, launchBindingEnded: endedBinding });
  }
  task(id: string) {
    return this.tasks.get(id);
  }
  tasksOf(sessionId: string) {
    return [...this.tasks.values()].filter((t) => t.owner === sessionId && !["verified", "rejected"].includes(t.status));
  }
  eligible(t: Task): boolean {
    const revision = evidenceRevision(t),
      grantId = t.objectiveId ? (this.objective(t.objectiveId)?.grant?.id ?? null) : null;
    return (
      t.acceptance.length > 0 &&
      t.acceptance.every((criterion) =>
        (t.verifiedEvidence ?? []).some(
          (e) =>
            e.criterion === criterion &&
            e.revision === revision &&
            e.grantId === grantId &&
            (e.verifiedBy === "human" || e.verifiedBy.startsWith("daemon: ")),
        ),
      )
    );
  }
  isVerified(t: Task) {
    return t.status === "verified" && this.eligible(t) && !t.historicalVerified;
  }
  recordEvidence(id: string, by: string, text: string, input: { criterion?: string; sourceId?: string } = {}) {
    const old = this.task(id);
    if (!old) throw Error("unknown task");
    const t = structuredClone(old),
      criterion = input.criterion ?? (t.acceptance.length === 1 ? t.acceptance[0] : "");
    if (!t.acceptance.includes(criterion) || !text.trim()) throw Error("Evidence must address an existing acceptance criterion");
    const actor = by === "human" ? "human" : "coordinator";
    let source: SbEvent | undefined,
      verifiedBy = "human";
    const objective = t.objectiveId ? this.objective(t.objectiveId) : undefined;
    if (actor !== "human") {
      const grant = requireTaskScope(t, objective);
      if (!t.owner || !input.sourceId) throw Error("Coordinator evidence requires a source event from the task owner");
      this.assertRecipient(t, t.owner, true);
      const row = this.store.db.query("SELECT * FROM events WHERE session_id=? AND source_id=?").get(t.owner, input.sourceId) as any;
      if (!row || row.ts < (t.evidenceSince ?? t.createdAt)) throw Error("Evidence source missing, stale or not from task owner");
      source = { sessionId: row.session_id, sourceId: row.source_id, ts: row.ts, type: row.type, data: JSON.parse(row.data) };
      const reservation = this.reservation(t.id);
      const tree =
        reservation && this.launchBinding(reservation, t.owner, grant) && reservation.cwd
          ? { cwd: reservation.cwd, root: reservation.root ?? grant.root, id: reservation.cwdId }
          : undefined;
      verifiedBy = verifyDeclaredCheck(grant, t, this.session(t.owner)!, source, criterion, tree) ?? "pending human verification";
    }
    const evidence = {
      criterion,
      text,
      by: actor,
      at: Date.now(),
      verifiedBy,
      revision: evidenceRevision(t),
      grantId: objective?.grant?.id ?? null,
      ...(source ? { sourceId: source.sourceId, sourceSessionId: source.sessionId, observedText: String(source.data.text ?? "") } : {}),
    } as const;
    // Human evidence for a criterion replaces everything for it. Coordinator evidence replaces only
    // earlier coordinator evidence: it can never overwrite or supersede a human verification.
    t.verifiedEvidence = [
      ...(t.verifiedEvidence ?? []).filter((e) => e.criterion !== criterion || (actor !== "human" && e.by === "human")),
      evidence,
    ];
    t.evidence.push({ at: evidence.at, by: `${actor} (${verifiedBy})`, text: `${criterion}: ${text}` });
    if (this.eligible(t) && this.blockedBy(t).length) throw Error("Prerequisites need verified evidence before completion");
    if (this.eligible(t)) {
      t.status = "verified";
      t.needsVerification = false;
      delete t.historicalVerified;
    } else if (t.status === "verified") t.status = "finished_unverified";
    t.updatedAt = Date.now();
    this.saveTask(t);
    this.audit(actor, "evidence_recorded", { taskId: id, evidence });
    this.unblockDependents();
    return t;
  }
  private saveTask(t: Task) {
    this.tasks.set(t.id, t);
    this.store.db
      .query("INSERT INTO tasks(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(t.id, JSON.stringify(t));
    this.changed();
  }
  blockedBy(t: Task): string[] {
    return t.prerequisites.filter((id) => !this.task(id) || !this.isVerified(this.task(id)!));
  }
  unblockDependents(): Task[] {
    const out: Task[] = [];
    for (const t of this.tasks.values())
      if (t.status === "blocked" && !this.blockedBy(t).length) {
        const next = { ...t, status: t.owner ? ("assigned" as const) : ("unassigned" as const), updatedAt: Date.now() };
        if (next.owner) {
          try {
            this.assertTaskReady(next);
            this.assertRecipient(next, next.owner);
            this.claimTask(next, next.owner);
          } catch {
            continue;
          }
        }
        this.saveTask(next);
        out.push(next);
      }
    return out;
  }
  assertTaskReady(t: Task) {
    const grant = requireTaskScope(t, t.objectiveId ? this.objective(t.objectiveId) : undefined);
    if (this.blockedBy(t).length) throw Error("Prerequisites need verified evidence before dispatch");
    if (t.status === "rejected") throw Error("Task was rejected");
    return grant;
  }
  assertRecipient(t: Task, owner: string, allowEnded = false) {
    const g = this.assertTaskReady(t),
      s = this.session(owner);
    if (!s?.cwd || (!allowEnded && s.execution === "ended")) throw Error("Task owner session is missing or ended");
    const r = this.reservation(t.id),
      cwd = canonical(s.cwd);
    const isolated = !!r && this.launchBinding(r, owner, g) && r.cwd === cwd;
    if (!isolated && !within(cwd, g.root)) throw Error("Recipient working directory is outside human grant");
  }
  /**
   * Does a recorded launch still bind this worker to the task under the current grant? A re-grant
   * with the same or a containing root keeps it (the worker's tree is still inside the grant); a
   * narrower or different root cuts it off.
   */
  private launchBinding(r: LaunchReservation, owner: string, g: HumanGrant) {
    if (r.state !== "launched" || r.sessionId !== owner) return false;
    if (!(r.root ? within(r.root, g.root) : r.grantId === g.id)) return false;
    // The binding is to the directory launched into, not its name: a worker can't move another
    // directory into place and keep the binding (or have the daemon read files from it).
    try {
      if (r.cwd) verifyDir(r.cwd, r.cwdId, "Worker directory");
      return !!r.cwd;
    } catch {
      return false;
    }
  }
  claimTask(t: Task, owner: string) {
    this.store.db
      .transaction(() => {
        for (const resource of [...t.scope.paths.map((p) => "path:" + p), ...t.scope.resources]) {
          const r = this.claim(owner, resource, { taskId: t.id });
          if (!r.granted) throw Error(`Dispatch blocked by claim ${r.blockedBy!.id} owned by ${r.blockedBy!.owner}`);
        }
      })
      .immediate();
  }
  /**
   * D32: a task of an approved plan is about to launch and every prerequisite is VERIFIED. Claims
   * are released only when all of these hold: the claim is tagged with one of `workers`' prerequisite
   * tasks, that prerequisite is verified (human or daemon evidence), the claim is held by exactly the
   * worker the plan launched for it, and the claimed resource lies wholly inside this task's scope.
   * A claim that is wider than the scope, or held by anyone else, stays (the task waits). Audited.
   */
  releaseVerifiedPrerequisiteClaims(t: Task, workers: Map<string, string>): number[] {
    if (this.blockedBy(t).length) return [];
    const scope = [...t.scope.paths.map((p) => "path:" + p), ...t.scope.resources].map(resourceKey);
    const inside = (claimed: string) =>
      scope.some((r) => (r.startsWith("path:") && claimed.startsWith("path:") ? within(claimed.slice(5), r.slice(5)) : r === claimed));
    const released: number[] = [];
    for (const c of this.claims(["active", "suspect"])) {
      if (!c.taskId || !t.prerequisites.includes(c.taskId) || workers.get(c.taskId) !== c.owner) continue;
      const pre = this.task(c.taskId);
      if (!pre || !this.isVerified(pre) || !inside(this.placed(c))) continue;
      this.release(c.id, c.owner);
      released.push(c.id);
    }
    if (released.length) this.audit("coordinator", "prerequisite_claims_released", { taskId: t.id, claims: released });
    return released;
  }
  /** Read-only: a held claim that would block claiming this task's scope right now, if any. */
  scopeBlocker(t: Task): Claim | null {
    const held = this.claims(["active", "suspect"]);
    for (const resource of [...t.scope.paths.map((p) => "path:" + p), ...t.scope.resources]) {
      const key = resourceKey(resource);
      const b = held.find((c) => c.taskId !== t.id && overlaps(this.placed(c), key));
      if (b) return b;
    }
    return null;
  }
  /** Shared pre-dispatch hook for messages, assignment and eventual perspective/auto entrypoints. */
  checkDispatch(taskId: string, owner: string) {
    const t = this.task(taskId);
    if (!t || t.owner !== owner) throw Error("Dispatch needs a task owned by the recipient");
    this.assertRecipient(t, owner);
    this.claimTask(t, owner);
    return t;
  }
  reservation(taskId: string): LaunchReservation | null {
    const r = this.store.db.query("SELECT data FROM launch_reservations WHERE task_id=?").get(taskId) as any;
    return r ? JSON.parse(r.data) : null;
  }
  reservations(): LaunchReservation[] {
    return (this.store.db.query("SELECT data FROM launch_reservations").all() as any[]).map((r) => JSON.parse(r.data));
  }
  /** Reserve a launch into the grant root. The caller must then use `r.root`, never its own `repo` string. */
  reserveLaunch(taskId: string, repo: string): LaunchReservation {
    return this.store.db
      .transaction(() => {
        const t = this.task(taskId);
        if (!t) throw Error("Unknown task");
        const g = this.assertTaskReady(t);
        if (canonical(repo) !== g.root) throw Error("Launch repository is outside human grant");
        if (t.owner || this.reservation(taskId)) throw Error("Task already has an owner or launch reservation; inspect before retrying");
        // Launching assigns an owner and sets in_progress, which would reopen a verified task.
        if (t.status === "verified") throw Error("Task is verified; only the human may reopen it");
        const r: LaunchReservation = {
          id: randomUUID(),
          taskId,
          grantId: g.id,
          state: "reserved",
          revision: launchRevision(t),
          at: Date.now(),
          root: g.root,
        };
        this.claimTask(t, `reservation:${r.id}`);
        this.store.db.query("INSERT INTO launch_reservations VALUES(?,?)").run(taskId, JSON.stringify(r));
        this.audit("coordinator", "launch_reserved", r);
        return r;
      })
      .immediate();
  }
  /**
   * The launch failed before the provider was invoked: provably no worker exists. Release the
   * reservation and every claim it acquired, atomically.
   */
  abandonReservation(r: LaunchReservation, reason: string) {
    this.store.db
      .transaction(() => {
        for (const c of this.claims(["active", "suspect", "waiting"])) if (c.owner === `reservation:${r.id}`) this.release(c.id, c.owner);
        if (this.reservation(r.taskId)?.id === r.id) this.store.db.query("DELETE FROM launch_reservations WHERE task_id=?").run(r.taskId);
        this.audit("coordinator", "launch_abandoned", { reservation: r, reason });
      })
      .immediate();
    this.changed();
  }
  /**
   * Human recovery for a stuck or finished reservation.
   * - not_launched: no worker is running for it (never started, or ended). Its claims (held by
   *   the reservation, or by its recorded worker for this task) are released and the row removed.
   * - launched: a worker is running. Its claims and the task go to that worker, as a normal launch.
   */
  clearReservation(taskId: string, input: { as: "not_launched" | "launched"; sessionId?: string | null }, actor: Actor) {
    if (actor !== "human") throw Error("Only the human may clear a launch reservation");
    if (input?.as !== "not_launched" && input?.as !== "launched") throw Error('as must be "not_launched" or "launched"');
    return this.store.db
      .transaction(() => {
        const r = this.reservation(taskId),
          t = this.task(taskId);
        if (!r) throw Error("This task has no launch reservation");
        const holder = `reservation:${r.id}`;
        if (input.as === "not_launched") {
          const released: number[] = [];
          for (const c of this.claims(["active", "suspect", "waiting"]))
            if (c.owner === holder || (r.sessionId && c.owner === r.sessionId && c.taskId === taskId)) {
              this.release(c.id, "human");
              released.push(c.id);
            }
          this.store.db.query("DELETE FROM launch_reservations WHERE task_id=?").run(taskId);
          if (t && r.sessionId && t.owner === r.sessionId)
            this.saveTask({
              ...t,
              owner: null,
              status: ACTIVE_TASK.includes(t.status) ? "unassigned" : t.status,
              humanRevision: (t.humanRevision ?? 0) + 1,
              updatedAt: Date.now(),
            });
          this.audit(actor, "reservation_cleared", { taskId, as: input.as, reservation: r, released });
          return { reservation: null, task: this.task(taskId) ?? null };
        }
        const sessionId = input.sessionId || r.sessionId;
        if (!sessionId) throw Error("Name the worker session that was launched (sessionId)");
        if (r.sessionId && sessionId !== r.sessionId) throw Error(`The reservation records worker ${r.sessionId}, not ${sessionId}`);
        if (!r.cwd) throw Error("No worker directory was recorded, so nothing reached the provider: clear it as not_launched");
        const s = this.session(sessionId);
        if (!s?.cwd) throw Error("Worker session unknown");
        if (canonical(s.cwd) !== r.cwd) throw Error(`Session ${sessionId} isn't working in the reserved directory ${r.cwd}`);
        for (const c of this.claims(["active", "suspect", "waiting"]))
          if (c.owner === holder) {
            c.owner = sessionId;
            if (c.state === "suspect") c.state = "active";
            c.heartbeatAt = Date.now();
            this.writeClaim(c);
          }
        const next: LaunchReservation = { ...r, state: "launched", sessionId, detail: "Human confirmed this launch" };
        this.updateReservation(next);
        if (t && !t.owner)
          this.saveTask({
            ...t,
            owner: sessionId,
            worktree: r.cwd,
            status: ACTIVE_TASK.includes(t.status) ? "in_progress" : t.status,
            evidenceSince: Date.now(),
            updatedAt: Date.now(),
          });
        this.audit(actor, "reservation_cleared", { taskId, as: input.as, reservation: next });
        return { reservation: next, task: this.task(taskId) ?? null };
      })
      .immediate();
  }
  updateReservation(r: LaunchReservation) {
    this.store.db.query("UPDATE launch_reservations SET data=? WHERE task_id=?").run(JSON.stringify(r), r.taskId);
  }
  checkReservation(r: LaunchReservation) {
    const stored = this.reservation(r.taskId),
      t = this.task(r.taskId);
    if (!stored || stored.id !== r.id || !t || stored.revision !== launchRevision(t) || this.assertTaskReady(t).id !== r.grantId)
      throw Error("Launch authority changed; reservation held for inspection");
    this.claimTask(t, `reservation:${r.id}`);
  }
  finishLaunch(r: LaunchReservation, sessionId: string, cwd: string) {
    return this.store.db
      .transaction(() => {
        const t = this.task(r.taskId);
        // Bind the worker to the directory recorded before the provider was invoked, not to a
        // fresh resolution of the path now (which a worker could have redirected meanwhile).
        const stored = this.reservation(r.taskId);
        cwd = stored?.id === r.id && stored.cwd ? stored.cwd : canonical(cwd);
        let valid = false;
        try {
          valid = !!t && !t.owner && launchRevision(t) === r.revision && this.assertTaskReady(t).id === r.grantId;
          // The directory launched into must still be the one recorded before the provider ran.
          if (valid && stored?.id === r.id && stored.cwdId) verifyDir(cwd, stored.cwdId, "Worker directory");
        } catch {
          /* Revoked authority stays revoked. */
        }
        this.updateReservation({
          ...r,
          state: valid ? "launched" : "uncertain",
          sessionId,
          cwd,
          ...(valid ? {} : { detail: "Task or grant changed during launch; worker exists, human assignment preserved" }),
        });
        for (const c of this.claims())
          if (c.owner === `reservation:${r.id}`) {
            c.owner = sessionId;
            c.state = "active";
            c.heartbeatAt = Date.now();
            this.writeClaim(c);
          }
        if (valid)
          this.saveTask({
            ...t!,
            owner: sessionId,
            worktree: cwd,
            status: "in_progress",
            evidenceSince: Date.now(),
            updatedAt: Date.now(),
          });
        this.audit("coordinator", valid ? "launch_completed" : "launch_requires_inspection", { taskId: r.taskId, sessionId });
        return valid;
      })
      .immediate();
  }

  // ---- claims
  claims(states: Claim["state"][] = ["active", "suspect"]): Claim[] {
    const q = `SELECT id, data FROM claims WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY id`;
    return (this.store.db.query(q).all(...states) as { id: number; data: string }[]).map((r) => ({ ...JSON.parse(r.data), id: r.id }));
  }

  private writeClaim(c: Claim) {
    this.store.db.query("UPDATE claims SET owner = ?, state = ?, data = ? WHERE id = ?").run(c.owner, c.state, JSON.stringify(c), c.id);
  }

  /**
   * Atomically claim a resource. Exclusive claims that overlap an active/suspect exclusive claim
   * held by someone else are queued ("waiting") and granted on release.
   */
  claim(
    owner: string,
    resource: string,
    opts: { exclusive?: boolean; taskId?: string | null; note?: string } = {},
  ): { granted: boolean; claim: Claim; blockedBy: Claim | null } {
    resource = resourceKey(resource);
    const exclusive = opts.exclusive ?? true;
    const tx = this.store.db.transaction(() => {
      const held = this.claims(["active", "suspect"]);
      const existing = held.find((c) => c.owner === owner && c.resource === resource && c.taskId === (opts.taskId ?? null));
      if (existing && (existing.exclusive || !exclusive)) return { granted: true, claim: existing, blockedBy: null };
      const blocker =
        held.find(
          (c) =>
            (c.owner !== owner || (!!c.taskId && !!opts.taskId && c.taskId !== opts.taskId)) &&
            (c.exclusive || exclusive) &&
            overlaps(this.placed(c), resource),
        ) ?? null;
      if (existing && !blocker) {
        existing.exclusive = exclusive;
        this.writeClaim(existing);
        return { granted: true, claim: existing, blockedBy: null };
      }
      const now = Date.now();
      const draft = {
        resource,
        owner,
        taskId: opts.taskId ?? null,
        exclusive,
        state: blocker ? "waiting" : "active",
        createdAt: now,
        heartbeatAt: now,
        note: opts.note ?? null,
      };
      const r = this.store.db
        .query("INSERT INTO claims (resource, owner, state, data) VALUES (?, ?, ?, ?)")
        .run(resource, owner, draft.state, "{}");
      const claim = { ...draft, id: Number(r.lastInsertRowid) } as Claim;
      this.writeClaim(claim);
      return { granted: !blocker, claim, blockedBy: blocker };
    });
    const result = tx.immediate();
    this.changed();
    return result;
  }

  release(claimId: number, by: string): Claim[] {
    const granted: Claim[] = [];
    this.store.db
      .transaction(() => {
        const c = this.claims(["active", "suspect", "waiting"]).find((x) => x.id === claimId);
        if (!c) throw new Error("no such claim");
        if (c.owner !== by && by !== "human") throw new Error("only the owner (or you) can release a claim");
        c.state = "released";
        this.writeClaim(c);
        // Grant waiters in order when nothing else blocks them.
        for (const w of this.claims(["waiting"])) {
          const held = this.claims(["active", "suspect"]);
          if (
            !held.some(
              (h) =>
                (h.owner !== w.owner || (!!h.taskId && !!w.taskId && h.taskId !== w.taskId)) &&
                (h.exclusive || w.exclusive) &&
                overlaps(this.placed(h), this.placed(w)),
            )
          ) {
            w.state = "active";
            w.heartbeatAt = Date.now();
            this.writeClaim(w);
            granted.push(w);
          }
        }
      })
      .immediate();
    this.changed();
    return granted;
  }

  /**
   * A claim's resource with a relative path (stored before paths were canonical, e.g. `path:src/**`)
   * resolved against its owner's cwd. Without a known cwd it stays relative and matches nothing.
   */
  private placed(c: Pick<Claim, "resource" | "owner">): string {
    if (!c.resource.startsWith("path:") || isAbsolute(c.resource.slice(5))) return c.resource;
    const cwd = this.session(c.owner)?.cwd;
    return cwd && isAbsolute(cwd) ? "path:" + resolve(cwd, c.resource.slice(5)) : c.resource;
  }

  heartbeat(owner: string, now = Date.now()) {
    for (const c of this.claims(["active", "suspect"]))
      if (c.owner === owner) {
        c.heartbeatAt = now;
        c.state = "active";
        this.writeClaim(c);
      }
  }

  /**
   * Recovery. Stale heartbeat -> suspect (kept!). Only an *ended* owner's claims are released,
   * and that is reported so the coordinator/user inspects the working tree first.
   */
  sweep(liveSessions: Map<string, Session>, now = Date.now()): { suspect: Claim[]; orphaned: Claim[] } {
    const suspect: Claim[] = [];
    const orphaned: Claim[] = [];
    for (const c of this.claims(["active", "suspect"])) {
      if (c.owner.startsWith("reservation:")) continue; // held by a launch in progress, not a session
      const s = liveSessions.get(c.owner);
      const ended = !s || s.execution === "ended";
      if (ended) {
        orphaned.push(c);
        const note = "owner session ended: inspect its working tree before reassigning";
        if (c.state !== "suspect" || c.note !== note) {
          c.state = "suspect";
          c.note = note;
          this.writeClaim(c);
        }
      } else if (c.state === "active" && now - c.heartbeatAt > HEARTBEAT_STALE_MS && s.execution !== "working") {
        c.state = "suspect";
        this.writeClaim(c);
        suspect.push(c);
      }
    }
    if (suspect.length || orphaned.length) this.changed();
    return { suspect, orphaned };
  }

  // ---- conflicts
  /** Track edits from transcript tool calls; raise deterministic conflicts. */
  onEvent(e: SbEvent, sessions: Map<string, Session>) {
    if (e.type !== "tool_call" || !EDIT_TOOLS.has(String(e.data.name))) return;
    const paths = Array.isArray(e.data.paths) ? (e.data.paths as string[]) : [];
    const s = sessions.get(e.sessionId);
    if (s) this.heartbeat(s.id, e.ts);
    for (const path of paths) this.recordEdit(e.sessionId, path, e.ts, sessions);
  }

  recordEdit(sessionId: string, path: string, at: number, sessions: Map<string, Session>) {
    const s = sessions.get(sessionId);
    if (!isAbsolute(path)) {
      // Relative transcript paths (e.g. Codex apply_patch keys) are relative to the session.
      if (!s?.cwd || !isAbsolute(s.cwd)) return;
      path = resolve(s.cwd, path);
    }
    if (s) {
      s.filesTouched = [{ path, at, source: "edit-tool" as const }, ...s.filesTouched.filter((f) => f.path !== path)].slice(0, 50);
    }
    const list = (this.edits.get(path) ?? []).filter((x) => at - x.at < SAME_FILE_WINDOW_MS);
    const others = [...new Set(list.filter((x) => x.session !== sessionId).map((x) => x.session))];
    list.push({ session: sessionId, at });
    this.edits.set(path, list);
    for (const other of others) {
      const ga = this.groupOf(sessionId),
        gb = this.groupOf(other);
      this.raise({
        kind: "same_file",
        sessions: [other, sessionId],
        path,
        detail: `both edited ${path} within 60 min`,
        at,
        sameGroup: !!ga && ga === gb,
      });
    }
    for (const c of this.claims(["active", "suspect"]))
      if (c.owner !== sessionId && c.exclusive && pathInClaim(path, this.placed(c)))
        this.raise({
          kind: "claimed_area",
          sessions: [c.owner, sessionId],
          path,
          detail: `edited ${path}, inside ${c.resource} claimed by another session`,
          at,
          sameGroup: false,
        });
  }

  /** Two live sessions writing in the same worktree + branch. */
  /**
   * Two live sessions recently editing files in the same git working tree. Keyed by the working
   * tree of the files actually touched, not by where a session started: sessions launched in one
   * folder that each work in their own worktree don't conflict.
   */
  checkSharedWorktrees(sessions: Map<string, Session>, now = Date.now()) {
    const by = new Map<string, Session[]>();
    for (const s of sessions.values()) {
      if (s.execution === "ended") continue;
      const trees = new Set<string>();
      for (const f of s.filesTouched) if (now - f.at < SAME_FILE_WINDOW_MS) {
        const tree = workTreeOf(f.path);
        if (tree) trees.add(tree);
      }
      for (const t of trees) by.set(t, [...(by.get(t) ?? []), s]);
    }
    for (const [tree, list] of by)
      if (list.length > 1) {
        const groups = new Set(list.map((s) => this.groupOf(s.id)));
        this.raise({
          kind: "shared_worktree",
          sessions: list.map((s) => s.id),
          path: tree,
          detail: `${list.length} sessions edited files in ${tree} in the last hour; consider separate worktrees`,
          at: now,
          sameGroup: groups.size === 1 && !groups.has(null),
        });
      }
  }

  private raise(c: Omit<Conflict, "id">) {
    const id = `${c.kind}:${[...c.sessions].sort().join("+")}:${c.path}`;
    const existing = this.conflicts.get(id);
    const conflict = { ...c, id };
    this.conflicts.set(id, conflict);
    if (!existing) this.onConflict(conflict);
    this.changed();
  }

  resolveConflict(id: string) {
    this.conflicts.delete(id);
    this.changed();
  }

  /** For the soft-lock hook: who else claimed or recently edited this file? */
  lookup(path: string, asking: string, now = Date.now()): { claimedBy: Claim | null; recentEditors: { session: string; at: number }[] } {
    if (!isAbsolute(path)) {
      const cwd = this.session(asking)?.cwd;
      if (!cwd || !isAbsolute(cwd)) return { claimedBy: null, recentEditors: [] };
      path = resolve(cwd, path);
    }
    const claimedBy =
      this.claims(["active", "suspect"]).find((c) => c.owner !== asking && c.exclusive && pathInClaim(path, this.placed(c))) ?? null;
    const recentEditors = (this.edits.get(path) ?? []).filter((x) => x.session !== asking && now - x.at < SAME_FILE_WINDOW_MS);
    return { claimedBy, recentEditors };
  }
}

const treeCache = new Map<string, string | null>();
/** The git working tree containing a file (the nearest ancestor with a .git entry), cached per directory. */
export function workTreeOf(file: string): string | null {
  if (!isAbsolute(file)) return null;
  let dir = dirname(file);
  const seen: string[] = [];
  while (true) {
    const hit = treeCache.get(dir);
    if (hit !== undefined) {
      for (const d of seen) treeCache.set(d, hit);
      return hit;
    }
    seen.push(dir);
    if (existsSync(join(dir, ".git"))) {
      for (const d of seen) treeCache.set(d, dir);
      return dir;
    }
    const up = dirname(dir);
    if (up === dir) {
      for (const d of seen) treeCache.set(d, null);
      return null;
    }
    dir = up;
  }
}
