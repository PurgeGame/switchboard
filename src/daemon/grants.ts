import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, basename } from "node:path";
import type { HumanGrant, Objective, Task } from "../shared/types.ts";

/** Resolve existing symlinks even when the final file has not been created yet. */
export function canonical(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw Error("Absolute path required");
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return resolve(realpathSync(current), ...tail.reverse());
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      const parent = dirname(current);
      if (parent === current) throw e;
      tail.push(basename(current));
      current = parent;
    }
  }
}
/**
 * Identity of a real directory (never a symlink) as "dev:ino". A path names a directory only at
 * one moment; this pins which directory a human granted or a launch recorded.
 */
export function dirIdentity(path: string): string {
  const s = lstatSync(path, { bigint: true });
  if (!s.isDirectory()) throw Error(`${path} is not a directory`);
  return `${s.dev}:${s.ino}`;
}
/**
 * Does `path` still name exactly the recorded directory? It must be canonical (no symlink in any
 * component, no . or ..) and, when an identity was recorded, the same device and inode, so a
 * directory renamed away and replaced by another of the same name is caught.
 */
export function verifyDir(path: string, id: string | undefined, what: string) {
  let same = false;
  try {
    same = canonical(path) === path && (!id || dirIdentity(path) === id) && (!!id || lstatSync(path).isDirectory());
  } catch {
    /* gone or unreadable */
  }
  if (!same) throw Error(`${what} ${path} changed (it is gone, goes through a symlink, or is a different directory now)`);
}
export const within = (path: string, root: string) => path === root || path.startsWith(root === "/" ? "/" : root + "/");
export function pathScope(path: string, root: string) {
  if (typeof path !== "string" || !path.trim()) throw Error("Explicit scope path required");
  const clean = path.replace(/\/\*\*?$/, "");
  if (/[?*\[\]{}]/.test(clean)) throw Error("Scope supports files/directories and trailing /* or /** only");
  return canonical(resolve(root, clean));
}
export function resourceKey(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw Error("Resource required");
  const at = value.indexOf(":"),
    kind = value.slice(0, at),
    name = value.slice(at + 1).trim();
  if (!name || !["path", "branch", "port", "db", "database", "deploy"].includes(kind)) throw Error("Unknown resource kind");
  if (kind === "path") return "path:" + pathScope(name, "/");
  if (kind === "branch") {
    const cut = name.lastIndexOf("@");
    if (cut < 1 || !name.slice(cut + 1)) throw Error("Branch resource needs /repo@branch");
    return `branch:${canonical(name.slice(0, cut))}@${name.slice(cut + 1)}`;
  }
  return `${kind === "database" ? "db" : kind}:${name}`;
}
export function requireGrant(objective: Objective | undefined): HumanGrant {
  const g = objective?.grant;
  if (!g || g.issuedBy !== "human" || g.revokedAt || objective?.status !== "active")
    throw Error("Human grant required (objective ungranted or revoked)");
  // The grant is for the directory the human chose, not its name: same path, no symlink, same inode.
  try {
    verifyDir(g.root, g.rootId, "Granted root");
  } catch (e) {
    throw Error(`Granted root changed; human review required (${(e as Error).message})`);
  }
  return g;
}
export function requireTaskScope(task: Task, objective: Objective | undefined) {
  const g = requireGrant(objective);
  if (!task.scope.paths.length && !task.scope.resources.length) throw Error("Task needs explicit scope before dispatch");
  for (const path of task.scope.paths) if (!within(pathScope(path, g.root), g.root)) throw Error("Task scope is outside human grant");
  for (const value of task.scope.resources) {
    const r = resourceKey(value);
    if (r.startsWith("path:")) {
      if (!within(r.slice(5), g.root)) throw Error("Resource is outside human grant");
    } else if (!g.resources.includes(r)) throw Error("Resource is outside human grant");
  }
  return g;
}
