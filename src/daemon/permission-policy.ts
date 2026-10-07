// Filesystem/settings boundary for the pure classifier. Never execute a requested command.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Store } from "./db.ts";
import type { PermissionInfo } from "./permissions.ts";
import type { DeniedToolCall } from "./adapters/tool-denial.ts";
import { classifySafePermission, executesProjectCode, insideRoot, permissionPlan, sensitivePath, type PathFact, type SafetyFacts, type SafeVerdict } from "./safe-permission.ts";
import type { AutoApproveSetting } from "./config.ts";
import { verifyDir } from "./grants.ts";

// Git can launch fsmonitor, pagers, textconv, external diffs, lazy fetches and alternate object
// stores. Permit only ordinary local configuration, and reject anything we can't inspect.
function gitSafe(root: string): boolean {
  if (Object.keys(process.env).some((k) => k.startsWith("GIT_"))) return false;
  try {
    let dir = join(root, ".git");
    if (lstatSync(dir).isSymbolicLink()) return false;
    if (statSync(dir).isFile()) {
      if (statSync(dir).size > 4096) return false;
      const m = readFileSync(dir, "utf8").trim().match(/^gitdir: (.+)$/);
      if (!m) return false;
      dir = realpathSync(resolve(root, m[1]));
      const backlink = join(dir, "gitdir");
      if (lstatSync(backlink).isSymbolicLink() || statSync(backlink).size > 4096 || realpathSync(readFileSync(backlink, "utf8").trim()) !== realpathSync(join(root, ".git"))) return false;
    }
    const common = existsSync(join(dir, "commondir")) ? realpathSync(resolve(dir, readFileSync(join(dir, "commondir"), "utf8").trim())) : dir;
    // Linked-worktree metadata must belong to this checkout. Even read-only Git can follow
    // object/ref symlinks into another repository, so inspect that metadata too (bounded).
    let remaining = 10_000;
    const localMetadata = (p: string): boolean => {
      if (--remaining < 0) return false;
      const st = lstatSync(p);
      if (st.isSymbolicLink() || (st.isFile() && st.nlink !== 1) || (!st.isFile() && !st.isDirectory())) return false;
      return !st.isDirectory() || readdirSync(p).every((n) => localMetadata(join(p, n)));
    };
    if (!localMetadata(common) || (dir !== common && !insideRoot(dir, common) && !localMetadata(dir))) return false;
    if ([dir, common].some((d) => existsSync(join(d, "objects/info/alternates")) || existsSync(join(d, "objects/info/http-alternates")))) return false;
    const files = ["/etc/gitconfig", join(homedir(), ".gitconfig"), join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git/config"), join(common, "config"), join(dir, "config.worktree")];
    const allowed = new Set(["core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates", "core.ignorecase", "core.precomposeunicode", "core.autocrlf", "core.eol", "user.name", "user.email", "user.signingkey", "commit.gpgsign", "init.defaultbranch", "push.default", "pull.rebase", "fetch.prune", "rerere.enabled"]);
    for (const file of files) {
      if (!existsSync(file)) continue;
      if (lstatSync(file).isSymbolicLink() || statSync(file).size > 64_000) return false;
      let section = "";
      for (const raw of readFileSync(file, "utf8").split("\n")) {
        const line = raw.trim();
        if (!line || /^[#;]/.test(line)) continue;
        const group = line.match(/^\[([a-z]+)(?: "[^"\\]+")?\]$/i);
        if (group) { section = group[1].toLowerCase(); continue; }
        const key = line.match(/^([a-z]+)\s*=\s*(.*)$/i);
        if (!key || /\\/.test(line)) return false;
        const name = `${section}.${key[1].toLowerCase()}`;
        if (!allowed.has(name) && !/^(?:remote\.(?:url|fetch|pushurl)|branch\.(?:remote|merge)|color\.(?:ui|status|diff|branch))$/.test(name)) return false;
        if (name === "core.bare" && key[2] !== "false") return false;
      }
    }
    // Deleted/staged secrets may no longer exist in the directory walk. Inspect index names
    // only, with helpers disabled; do not read object contents or invoke the requested command.
    const index = spawnSync("git", ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--stage", "--full-name", "-z"], {
      cwd: root, encoding: "utf8", timeout: 2000, maxBuffer: 2_000_000,
      env: { PATH: process.env.PATH, HOME: homedir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
    });
    if (index.status !== 0) return false;
    return index.stdout.split("\0").filter(Boolean).every((entry) => {
      const m = entry.match(/^(\d+) [a-f0-9]+ \d\t(.+)$/s);
      return m && m[1] !== "160000" && !sensitivePath(m[2]) && m[2] !== ".gitmodules";
    });
  } catch { return false; }
}

/** Git discovers the nearest `.git` above the cwd. One between the worktree root and the cwd (a
 * nested repository, or a `.git` file pointing anywhere) has a config gitSafe never read. */
function noNestedRepository(cwd: string, root: string): boolean {
  for (let directory = cwd; directory !== root; directory = dirname(directory)) {
    if (!insideRoot(directory, root)) return false;
    try { lstatSync(join(directory, ".git")); return false; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false; }
  }
  return true;
}

/** Snapshot only explicit paths for verification commands; suite internals are authorized.
 * Readers still get the bounded recursive secret/link check. No requested command is executed. */
export function permissionFacts(info: PermissionInfo, root: string | null): SafetyFacts {
  const facts: SafetyFacts = { root: null, paths: Object.create(null), globs: Object.create(null) };
  const plan = permissionPlan(info);
  if (!plan || !root || !isAbsolute(root) || !info.cwd || !isAbsolute(info.cwd)) return facts;
  try {
    const realRoot = realpathSync(root);
    if (realRoot === "/" || insideRoot(homedir(), realRoot) || !statSync(realRoot).isDirectory()) return facts;
    facts.root = realRoot;
    if (realRoot !== root || !insideRoot(info.cwd, root)) return facts;
    let remaining = 10_000;
    const tree = (p: string, git: boolean): boolean => {
      if (--remaining < 0 || sensitivePath(p)) return false;
      const st = lstatSync(p);
      if (st.isSymbolicLink() || (st.isFile() && st.nlink !== 1) || (!st.isFile() && !st.isDirectory())) return false;
      return !st.isDirectory() || readdirSync(p).every((n) => git && p === root && n === ".git" || tree(join(p, n), git));
    };
    const entries = facts.paths as Record<string, PathFact>;
    const capture = (p: string, recursive = false, git = false): PathFact | undefined => {
      if (!insideRoot(p, root) || sensitivePath(p)) return;
      let current = root, missing = false;
      let kind: PathFact["kind"] = "directory";
      try {
        for (const part of relative(root, p).split("/").filter(Boolean)) {
          current = join(current, part);
          try {
            const st = lstatSync(current);
            if (st.isSymbolicLink() || (st.isFile() && st.nlink !== 1) || (!st.isFile() && !st.isDirectory())) return;
            kind = st.isDirectory() ? "directory" : "file";
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") return;
            missing = true;
          }
        }
        const f: PathFact = { real: missing ? p : realpathSync(p), kind: missing ? "missing" : kind, treeSafe: entries[p]?.treeSafe };
        if (recursive && f.kind === "directory") f.treeSafe = tree(p, git);
        entries[p] = f;
        return f;
      } catch { return; }
    };
    capture(info.cwd);
    for (const command of plan.commands) for (const p of command.paths) {
      const absolute = resolve(info.cwd, p);
      if (!insideRoot(absolute, root) || p.split("/").includes("..")) continue;
      if (command.verification && p.includes("*")) {
        // Only filename globs: shell expansion through a wildcard directory could traverse
        // a symlink the glob walker skips. Enumerating names also includes broken symlinks.
        const base = dirname(absolute);
        if (base.includes("*") || capture(base)?.kind !== "directory") continue;
        const pattern = new Bun.Glob(absolute.slice(base.length + 1));
        const matches: string[] = [];
        for (const name of readdirSync(base)) {
          if (--remaining < 0) return { root: null, paths: {} };
          if (!pattern.match(name)) continue;
          const path = join(base, name);
          matches.push(path);
          capture(path);
        }
        (facts.globs as Record<string, string[]>)[absolute] = matches;
      } else capture(absolute, command.recursive, !!command.git);
    }
    const writes = plan.commands.flatMap((c) => c.writes ?? []);
    for (const output of [...plan.outputs, ...writes]) capture(resolve(info.cwd, output));
    // A `>` onto an existing file replaces its contents, and an output option can replace a file
    // or empty a directory: ask Git (index names only, helpers off) whether it holds anything
    // tracked. Anything but a clean "not tracked" counts as tracked.
    for (const output of [...plan.truncating, ...writes]) {
      const absolute = resolve(info.cwd, output), kind = entries[absolute]?.kind;
      if (kind !== "file" && !(kind === "directory" && writes.includes(output))) continue;
      const r = spawnSync("git", ["-c", "core.fsmonitor=false", "ls-files", "--error-unmatch", "--", relative(root, absolute)], {
        cwd: root, encoding: "utf8", timeout: 2000, maxBuffer: 200_000,
        env: { PATH: process.env.PATH, HOME: homedir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
      });
      (facts.tracked ??= Object.create(null) as Record<string, boolean>);
      (facts.tracked as Record<string, boolean | undefined>)[absolute] = r.status === 0 ? true : r.status === 1 && /did not match/i.test(r.stderr ?? "") ? false : undefined;
    }
    if (plan.commands.some((c) => c.script)) {
      // Package runners find the nearest manifest, and must never fall back past this root.
      for (let directory = info.cwd; insideRoot(directory, root); directory = dirname(directory)) {
        const file = join(directory, "package.json");
        let exists = true;
        try { lstatSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") exists = false; }
        if (exists) {
          if (capture(file)?.kind === "file" && statSync(file).size <= 1_000_000) {
            const pkg = JSON.parse(readFileSync(file, "utf8"));
            if (pkg?.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)) facts.package = { path: file, scripts: pkg.scripts };
          }
          break;
        }
        if (directory === root) break;
      }
    }
    if (plan.commands.some((c) => c.git)) facts.gitSafe = gitSafe(root) && noNestedRepository(info.cwd, root);
    if (plan.commands.some((c) => /read-only-(?:stdin-)?(?:rg|grep)/.test(c.rule)) && (process.env.RIPGREP_CONFIG_PATH || process.env.GREP_OPTIONS)) return { root: null, paths: {} };
  } catch { /* Incomplete evidence means ask. */ }
  return facts;
}

/** Map provider tool names/arguments exactly; unknown wrappers and extra options stay unknown. */
export function deniedPermissionInfo(sessionId: string, provider: "claude" | "codex", call: DeniedToolCall): PermissionInfo {
  let input = call.input && typeof call.input === "object" && !Array.isArray(call.input) ? { ...call.input } as Record<string, unknown> : {};
  let tool = call.tool;
  if (provider === "codex" && ["exec_command", "functions.exec_command", "shell_command", "shell"].includes(tool)) {
    tool = "command";
    if ("cmd" in input && !("command" in input)) { input.command = input.cmd; delete input.cmd; }
  }
  return { sessionId, provider, tool, input, cwd: call.cwd, summary: typeof input.command === "string" ? input.command : JSON.stringify(call.input) };
}

/** Is `p` (resolved through symlinks) inside the configured worktree root? Fails closed. */
export function insideWorktreeRoot(p: string | null | undefined, worktreeRoot: string): boolean {
  if (!p || !isAbsolute(p) || !worktreeRoot || !isAbsolute(worktreeRoot)) return false;
  try {
    const real = realpathSync(p), base = realpathSync(worktreeRoot);
    return base !== "/" && real !== base && insideRoot(real, base);
  } catch { return false; }
}

/**
 * D44's "coordinator worker inside its own Switchboard worktree", from the daemon's records only:
 * the session is one the coordinator launched; its launch reservation recorded a directory that
 * still is exactly that directory (canonical, same device/inode); that directory is strictly
 * inside the configured worktree root and is not the shared tree it was launched from (a worker
 * launched without a worktree, or a worktree root that contains the repository, doesn't count);
 * and where the call runs (resolved through symlinks and `..`) is inside it. No folder name, no
 * string prefix and nothing from the request beyond the cwd being checked.
 */
export function inOwnWorktree(launched: boolean, reservation: { cwd?: string; cwdId?: string; root?: string } | undefined, requestCwd: string | null, worktreeRoot: string): boolean {
  if (!launched || !reservation?.cwd || !requestCwd || !isAbsolute(requestCwd)) return false;
  try {
    verifyDir(reservation.cwd, reservation.cwdId, "Worker directory");
    const worktree = reservation.cwd;
    if (!insideWorktreeRoot(worktree, worktreeRoot)) return false;
    if (!reservation.root) return false;
    const shared = realpathSync(reservation.root);
    if (insideRoot(worktree, shared) || insideRoot(shared, worktree)) return false;
    return insideRoot(realpathSync(requestCwd), worktree);
  } catch { return false; }
}

export interface PolicyOptions {
  /** Sessions excluded from coordination: never auto-approved. */
  excluded?: (sessionId: string) => boolean;
  /** A coordinator-launched worker running inside its own Switchboard worktree. */
  ownWorktree?: (info: PermissionInfo) => boolean;
}

/**
 * The Settings switch (D44) turns auto-approval on or off; `setting` (config
 * autoApproveSafePermissions) is the default for that switch and decides how far "on" reaches:
 * true = read-only rules everywhere, project-code execution only for coordinator workers in their
 * own worktree; "all" = execution rules for every session too.
 */
export class SafePermissionPolicy {
  constructor(private store: Store, private root: (info: PermissionInfo) => string | null, private setting: AutoApproveSetting = false, private opts: PolicyOptions = {}) {
    store.db.run("CREATE TABLE IF NOT EXISTS permission_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
  }
  snapshot(): { autoApproveSafe: boolean; scope: "workers" | "all" } {
    const row = this.store.db.query("SELECT value FROM permission_settings WHERE key='autoApproveSafe'").get() as { value: number } | null;
    return { autoApproveSafe: row ? row.value === 1 : this.setting !== false, scope: this.setting === "all" ? "all" : "workers" };
  }
  setEnabled(enabled: boolean) {
    this.store.db.run("INSERT INTO permission_settings VALUES ('autoApproveSafe', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [enabled ? 1 : 0]);
    return this.snapshot();
  }
  decide(info: PermissionInfo): SafeVerdict {
    const settings = this.snapshot();
    if (!settings.autoApproveSafe) return { decision: "ask", reason: "Safe permission auto-approval is off" };
    try {
      if (this.opts.excluded?.(info.sessionId)) return { decision: "ask", reason: "Session is excluded from coordination: nothing is approved automatically" };
      const verdict = classifySafePermission(info, permissionFacts(info, this.root(info)));
      const plan = permissionPlan(info);
      if (verdict.decision === "allow" && plan && executesProjectCode(plan) && settings.scope !== "all" && !this.opts.ownWorktree?.(info))
        return { decision: "ask", reason: "Runs project code: approved automatically only for coordinator workers in their own Switchboard worktree (autoApproveSafePermissions: \"all\" extends it to every session)" };
      return verdict;
    } catch { return { decision: "ask", reason: "Could not verify the worker's worktree" }; }
  }
}

/** Provider protocol metadata is inert; every other extra field must go to the classifier. */
export function codexApprovalInput(raw: Record<string, unknown>, command: unknown): Record<string, unknown> {
  const input: Record<string, unknown> = { command };
  const metadata = new Set(["command", "cwd", "threadId", "thread", "turnId", "itemId", "callId", "approvalId", "reason", "kind", "availableDecisions", "commandActions", "parsedCmd"]);
  for (const [key, value] of Object.entries(raw)) if (!metadata.has(key) && value !== null && value !== undefined) input[key] = value;
  return input;
}
