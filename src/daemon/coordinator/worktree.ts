// The one git operation the coordinator can cause: create a fresh worktree for a launched worker.
// Argument arrays only (no shell); a new branch sb/<slug> from the repo's current HEAD; never
// touches the repo's working tree, index or existing branches.
//
// Workers have a shell, so every path here may be raced. Nothing is trusted before the end:
// - the repository must still be the granted directory (device+inode), before and after git runs;
// - git runs without inherited GIT_* variables and with hooks and fsmonitor disabled, so neither
//   the daemon's environment nor the repository's config can redirect it or run code;
// - the worktree root and its per-repo directory must be real directories owned by this user and
//   not world-writable; the worktree directory is created exclusively (mkdir fails if anything,
//   including a dangling symlink, is there) and must be the same inode after `git worktree add`;
// - the result must be a worktree of the granted repository (same --git-common-dir) whose HEAD is
//   refs/heads/sb/<slug>, reached by a path with no symlink component.
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { dirIdentity, verifyDir } from "../grants.ts";

/** Slugs become a path component and the branch sb/<slug>: this alphabet is a strict subset of
 *  what `git check-ref-format --branch` accepts (no dots, slashes, `@{`, leading dash or `.lock`). */
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;

/** A worktree name that always satisfies SLUG: short task id + a trimmed, sanitized title. */
export function worktreeSlug(taskId: string, title: string): string {
  const id = taskId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "task";
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return words ? `${id}-${words}` : id;
}

export const isValidSlug = (s: string) => SLUG.test(s);

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

async function git(args: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    env: gitEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args[0]}: ${err.trim() || out.trim()}`);
  return out.replace(/\n$/, "");
}

/** A real directory owned by this user and not writable by everyone. */
function ownedDir(p: string) {
  const s = lstatSync(p);
  if (!s.isDirectory()) throw new Error(`${p} is not a directory`);
  if (typeof process.getuid === "function" && s.uid !== process.getuid()) throw new Error(`${p} is not owned by you; inspect it`);
  if (s.mode & 0o002) throw new Error(`${p} is world-writable; refusing to create worktrees there`);
}

/**
 * Returns the worker's working directory: the new worktree, or the same subdirectory inside it
 * when `repo` is a subdirectory of its git toplevel (a grant rooted at /repo/pkg works in
 * <worktree>/pkg, so its files and checks line up with the grant).
 *
 * `repoId` is the granted directory's identity ("dev:ino"); when given, `repo` must still name
 * exactly that directory before and after git runs.
 */
export async function createWorktree(root: string, repo: string, slug: string, repoId?: string): Promise<string> {
  if (!SLUG.test(slug)) throw new Error("bad worktree slug");
  if (!isAbsolute(root) || !isAbsolute(repo)) throw new Error("worktree root and repository must be absolute paths");
  const checkRepo = () => verifyDir(repo, repoId, "Granted repository");
  checkRepo();
  const commonDir = async (cwd: string) => realpathSync(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd));
  const top = realpathSync(await git(["rev-parse", "--show-toplevel"], repo));
  const repoCommon = await commonDir(repo);
  checkRepo(); // the answers above came from the granted directory, not a replacement
  const sub = relative(top, repo);
  if (sub.startsWith("..") || isAbsolute(sub)) throw new Error("repo is outside its git toplevel");
  if (/[\x00-\x1f\x7f]/.test(sub)) throw new Error("repository path has control characters");
  const name = basename(top).replace(/[^\w.-]/g, "_");
  if (!name || /^\.+$/.test(name)) throw new Error(`can't name a worktree directory after ${top}`);

  mkdirSync(root, { recursive: true, mode: 0o700 });
  const base = realpathSync(root);
  ownedDir(base);
  const parent = join(base, name);
  try {
    mkdirSync(parent, { mode: 0o700 });
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
  }
  verifyDir(parent, undefined, "Worktree directory"); // no symlink anywhere in the chain
  ownedDir(parent);
  const parentId = dirIdentity(parent);
  const dir = join(parent, slug);

  const isOurs = async () => {
    verifyDir(dir, undefined, "Worktree");
    ownedDir(dir);
    if (realpathSync(await git(["rev-parse", "--show-toplevel"], dir)) !== dir || (await commonDir(dir)) !== repoCommon)
      throw new Error(`${dir} exists but is not a worktree of ${top}; inspect it`);
    const head = await git(["symbolic-ref", "-q", "HEAD"], dir).catch(() => "");
    if (head !== `refs/heads/sb/${slug}`) throw new Error(`${dir} is checked out on ${head || "a detached HEAD"}, not branch sb/${slug}; inspect it`);
  };

  let exists = true;
  try {
    lstatSync(dir); // a dangling symlink also counts as taken
  } catch {
    exists = false;
  }
  if (exists) {
    // idempotent: a retried launch reuses its own worktree, but only a real one of this repo on sb/<slug>
    await isOurs();
  } else {
    // Exclusive: fails if anything appeared at this name since the check above.
    mkdirSync(dir, { mode: 0o700 });
    const dirId = dirIdentity(dir);
    await git(["worktree", "add", "-b", `sb/${slug}`, "--", dir, "HEAD"], top);
    verifyDir(dir, dirId, "Worktree"); // still the directory we created, not a swapped-in one
    await isOurs();
  }
  verifyDir(parent, parentId, "Worktree directory");
  checkRepo();
  if (!sub) return dir;
  const cwd = join(dir, sub);
  mkdirSync(cwd, { recursive: true }); // an untracked subdirectory isn't checked out
  verifyDir(cwd, undefined, "Worktree subdirectory");
  return cwd;
}
