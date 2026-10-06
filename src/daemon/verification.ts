// Ported from switchboard-codex 6a88fc9; C types and event data adapted.
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, readlinkSync, realpathSync } from "node:fs";
import { resolve, isAbsolute, join, relative } from "node:path";
import type { AcceptanceCheck, HumanGrant, SbEvent, Task, Session } from "../shared/types.ts";
import { pathScope, verifyDir, within } from "./grants.ts";

export function validateChecks(value: unknown): AcceptanceCheck[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30) throw Error("Invalid acceptance checks");
  const seen = new Set<string>();
  return value.map((v) => {
    if (
      !v ||
      typeof v.criterion !== "string" ||
      !v.criterion.trim() ||
      !["response_equals", "file_contains", "file_sha256"].includes(v.kind) ||
      typeof v.expected !== "string" ||
      !v.expected.length
    )
      throw Error("Acceptance checks need a criterion, supported kind and expected value");
    if (seen.has(v.criterion)) throw Error("Duplicate acceptance check");
    seen.add(v.criterion);
    if (
      v.kind !== "response_equals" &&
      (typeof v.path !== "string" || !v.path.trim() || isAbsolute(v.path) || v.path.split(/[\\/]/).includes(".."))
    )
      throw Error("Check paths must be relative to the objective, without parent traversal");
    return { criterion: v.criterion, kind: v.kind, expected: v.expected, ...(v.path ? { path: v.path } : {}) };
  });
}
/**
 * `tree` maps the worker's working tree onto the repository: `tree.cwd` holds the same files as
 * `tree.root` (a path inside the grant). An unmanaged session reads the granted repo itself; a
 * managed worker reads its recorded worktree, mapped at the subdirectory it was launched for.
 */
export function verifyDeclaredCheck(
  grant: HumanGrant,
  task: Task,
  owner: Session,
  event: SbEvent | undefined,
  criterion: string,
  tree: { cwd: string; root: string; id?: string } = { cwd: grant.root, root: grant.root, id: grant.rootId },
): string | undefined {
  const check = grant.verification.find((c) => c.criterion === criterion);
  if (!check) return undefined;
  if (check.kind === "response_equals") {
    if (event?.type !== "assistant_msg" || String(event.data.text ?? "").trim() !== check.expected.trim())
      throw Error("Observed response does not match the human-declared acceptance check");
    return "daemon: response_equals";
  }
  const original = pathScope(check.path!, grant.root);
  const paths = [...task.scope.paths, ...task.scope.resources.filter((r) => r.startsWith("path:")).map((r) => r.slice(5))].map((scope) =>
    pathScope(scope, grant.root),
  );
  if (!paths.some((scope) => within(original, scope))) throw Error("Verification file is outside assigned scope");
  if (!owner.cwd) throw Error("Owner working directory unknown");
  if (!within(original, tree.root)) throw Error("Verification file is outside the worker's tree");
  // The tree must still be the recorded directory: canonical (no symlink) and the same inode.
  verifyDir(tree.cwd, tree.id, "Worker directory");
  const root = tree.cwd,
    target = realpathSync(resolve(root, relative(tree.root, original)));
  if (!within(target, root) || target === root) throw Error("Verification file escapes owner working directory");
  const mappedTarget = pathScope(relative(root, target), tree.root);
  if (!paths.some((scope) => within(mappedTarget, scope))) throw Error("Verification file is outside assigned scope");
  const rel = relative(root, target);
  // A worker controls this tree. Pin the root directory with a descriptor and check it is the
  // recorded directory; then open the file relative to that descriptor (Linux: through
  // /proc/self/fd/<root>, the equivalent of openat) with O_NOFOLLOW on the last component, and
  // confirm the opened file sits at exactly <root>/<rel>. A directory or symlink swapped anywhere
  // in the chain is refused. Devices/FIFOs are refused; reads are bounded. Not an OS sandbox.
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  const rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const rs = fstatSync(rootFd, { bigint: true });
    if (tree.id && `${rs.dev}:${rs.ino}` !== tree.id) throw Error("Worker directory changed while it was opened");
    const proc = `/proc/self/fd/${rootFd}`,
      viaProc = existsSync(proc);
    const fd = openSync(viaProc ? join(proc, rel) : target, flags);
    try {
      if (viaProc) {
        const opened = readlinkSync(`/proc/self/fd/${fd}`),
          rootNow = readlinkSync(proc);
        if (opened !== join(rootNow, rel)) throw Error("Verification file changed while it was opened");
      }
      const stat = fstatSync(fd),
        limit = 2 * 1024 * 1024;
      if (!stat.isFile()) throw Error("Verification needs a regular file");
      if (stat.size > limit) throw Error("Verification file exceeds 2 MiB limit");
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length <= limit) {
        const n = readSync(fd, buffer, length, buffer.length - length, null);
        if (!n) break;
        length += n;
      }
      if (length > limit) throw Error("Verification file exceeds 2 MiB limit");
      bytes = buffer.subarray(0, length);
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(rootFd);
  }
  if (check.kind === "file_contains" && !bytes.toString("utf8").includes(check.expected))
    throw Error("File does not contain the human-declared expected text");
  if (check.kind === "file_sha256" && createHash("sha256").update(bytes).digest("hex") !== check.expected.toLowerCase())
    throw Error("File hash does not match the human-declared expected hash");
  return "daemon: " + check.kind;
}
export function evidenceRevision(task: Task) {
  return createHash("sha256")
    .update(JSON.stringify([task.objectiveId, task.owner, task.scope, task.acceptance, task.prerequisites]))
    .digest("hex");
}
export function launchRevision(task: Task) {
  return `${evidenceRevision(task)}:${task.humanRevision ?? 0}`;
}
