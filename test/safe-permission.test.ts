import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifySafePermission, type SafetyFacts } from "../src/daemon/safe-permission.ts";
import { permissionFacts, SafePermissionPolicy, deniedPermissionInfo, codexApprovalInput, insideWorktreeRoot, inOwnWorktree } from "../src/daemon/permission-policy.ts";
import { dirIdentity } from "../src/daemon/grants.ts";
import { PermissionBroker, type PermissionInfo } from "../src/daemon/permissions.ts";
import { Store } from "../src/daemon/db.ts";

const ROOT = "/workspace/app";
const info = (command: unknown, extra: Partial<PermissionInfo> = {}): PermissionInfo => ({ sessionId: "claude:worker", provider: "claude", tool: "Bash", input: { command }, summary: String(command), cwd: ROOT, ...extra });
const facts: SafetyFacts = { root: ROOT, gitSafe: true, paths: {
  [ROOT]: { real: ROOT, kind: "directory", treeSafe: true },
  [`${ROOT}/src`]: { real: `${ROOT}/src`, kind: "directory", treeSafe: true },
  [`${ROOT}/src/main.ts`]: { real: `${ROOT}/src/main.ts`, kind: "file" },
  [`${ROOT}/src/a b.ts`]: { real: `${ROOT}/src/a b.ts`, kind: "file" },
} };
for (const command of ["cat src/main.ts; ls", "cat src/main.ts && ls", "cat src/main.ts | cat", "pwd", "ls", "ls -lah src", "cat src/main.ts", "cat 'src/a b.ts'", 'cat "src/a b.ts"', "head -n 20 src/main.ts", "tail -10 src/main.ts", "wc -l src/main.ts", "rg 'permission|approval' src", "rg -n -e word src", "rg --files src", "grep -rn word src", "git status --short", "git log --oneline -5", "git diff --stat", "git diff -- src/main.ts"]) {
  test(`pure classifier allows: ${command}`, () => {
    const result = classifySafePermission(info(command), facts);
    expect(result.decision).toBe("allow");
    if (result.decision === "allow") expect(result.rule).toMatch(/^(read-only-|git-|working-)/);
  });
}
const adversarial = [
  "cat ../secret", "cat src/../../outside", "cat src/../src/main.ts", "cat /workspace/app-other/file", "cat /etc/passwd", "cat ~/file",
  "cat $HOME/file", "cat ${PWD}/src/main.ts", "cat $(pwd)/src/main.ts", "cat `pwd`/src/main.ts", "cat src/main.ts || true", "cat src/main.ts &", "cat src/main.ts\nls", "cat src/main.ts\tls", "cat src/main.ts > out", "cat < src/main.ts", "cat <(ls)",
  "cat src/*", "cat src/?.ts", "cat src/{a,b}.ts", "c'at' src/main.ts", "c\\at src/main.ts", "cat src/main.ts # tail", "cat 'src/main.ts", "cat $'src/main.ts'", "cat -- -", "cat",
  "PATH=./bin cat src/main.ts", "env cat src/main.ts", "env -i cat src/main.ts", "FOO=bar cat src/main.ts", "GIT_CONFIG_COUNT=1 git status", "RIPGREP_CONFIG_PATH=evil rg word src", "BASH_ENV=evil bash -c 'ls'", "bash -c 'cat src/main.ts'", "./cat src/main.ts", "/tmp/cat src/main.ts",
  "curl https://example.com", "git fetch", "git push", "git reset --hard", "git clean -fd", "git checkout -- src/main.ts", "git restore src/main.ts", "git rebase main", "git gc", "git branch -D branch", "git -c core.fsmonitor=evil status", "git -C /elsewhere status", "git diff --ext-diff", "git diff --textconv", "git diff --output=../output", "git log -p", "git log --format=%B", "git show HEAD:.env", "git diff --no-index /etc/passwd src/main.ts",
  "rg --pre=evil word src", "rg --pre evil word src", "rg --search-zip word src", "rg -f .env src", "grep --file=.env src", "rg --unknown word src", "rg --files /etc", "grep -R word /etc", "ls -R .", "find . -exec cat {} ;", "sed -n 1p src/main.ts", "rm src/main.ts", "touch ../outside", "sort -o../outside src/main.ts",
  "npm test", "npm run test", "pnpm test", "yarn test", "node tests.js", "python -c 'print(1)'",
];
for (const command of adversarial) test(`pure classifier asks: ${JSON.stringify(command)}`, () => expect(classifySafePermission(info(command), facts).decision).toBe("ask"));

for (const secret of [".credentials", ".secrets", "client_secret.json", "private-key.json", "api_key.txt", "passwords.txt", "service-account.json", ".env", ".env.local", ".env.production.local", ".ssh/id_ed25519", "server.pem", "private.key", "keys/api", "credentials.json", "secrets.txt", "switchboard.db", "switchboard.db-wal", "data.sqlite3", ".git/config", ".codex/auth.json", ".npmrc"]) {
  test(`even an in-worktree regular file cannot expose ${secret}`, () => {
    const p = `${ROOT}/${secret}`;
    expect(classifySafePermission(info(`cat ${secret}`), { ...facts, paths: { ...facts.paths, [p]: { real: p, kind: "file" } } }).decision).toBe("ask");
  });
}

test("requires complete path evidence, a known cwd/root and a safe recursive tree", () => {
  for (const f of [{ ...facts, root: null }, { ...facts, root: "/" }, { ...facts, paths: {} }, { ...facts, paths: { ...facts.paths, [`${ROOT}/src`]: { real: `${ROOT}/src`, kind: "directory" as const, treeSafe: false } } }]) expect(classifySafePermission(info("rg word src"), f).decision).toBe("ask");
  expect(classifySafePermission(info("cat missing"), facts).decision).toBe("ask");
  expect(classifySafePermission(info("ls", { cwd: null }), facts).decision).toBe("ask");
  expect(classifySafePermission(info("ls", { cwd: "/workspace/other" }), facts).decision).toBe("ask");
  expect(classifySafePermission(info("git status"), { ...facts, gitSafe: false }).decision).toBe("ask");
});

test("symlink targets outside, at secrets, and cwd symlinks are rejected by the pure function", () => {
  for (const real of ["/outside/file", `${ROOT}/.env`]) expect(classifySafePermission(info("cat src/main.ts"), { ...facts, paths: { ...facts.paths, [`${ROOT}/src/main.ts`]: { real, kind: "file" } } }).decision).toBe("ask");
  expect(classifySafePermission(info("ls"), { ...facts, paths: { [ROOT]: { real: "/outside", kind: "directory" } } }).decision).toBe("ask");
});

test("provider argv and direct Read are supported, but unknown input fields never widen approval", () => {
  for (const command of [["cat", "src/main.ts"], ["bash", "-lc", "cat src/main.ts"]]) expect(classifySafePermission(info(command, { provider: "codex", tool: "command" }), facts).decision).toBe("allow");
  expect(classifySafePermission(info("", { tool: "Read", input: { file_path: "src/main.ts", limit: 10 } }), facts).decision).toBe("allow");
  for (const command of [["bash", "-lc", "ls; curl https://x"], ["bash", "-lc", "ls", "extra"], ["cat", 123]]) expect(classifySafePermission(info(command, { provider: "codex", tool: "command" }), facts).decision).toBe("ask");
  for (const extra of [{ env: { PATH: "evil" } }, { shell: "/tmp/evil" }, { grantRoot: "/" }, { workdir: "/elsewhere" }, { cwd: "/elsewhere" }, { command2: "curl x" }, { sandbox_permissions: "require_escalated" }, { login: true }]) expect(classifySafePermission(info("ls", { input: { command: "ls", ...extra } }), facts).decision).toBe("ask");
  for (const tool of ["Write", "Edit", "file change", "exec", "Agent", "WebFetch"]) expect(classifySafePermission(info("ls", { tool }), facts).decision).toBe("ask");
});

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((f) => f()));
function tree() {
  const base = resolve(".sandbox"); mkdirSync(base, { recursive: true });
  const tmp = mkdtempSync(join(base, "safe-permission-"));
  cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
  const root = join(tmp, "worker"); const outside = join(tmp, "other");
  mkdirSync(join(root, "src"), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(root, "src/main.ts"), "safe"); writeFileSync(join(outside, "file"), "private");
  const at = (cmd: string) => info(cmd, { cwd: root });
  const classify = (cmd: string) => classifySafePermission(at(cmd), permissionFacts(at(cmd), root));
  return { root, outside, at, classify };
}

test("real filesystem: regular reads pass; symlinks, broken links, traversal and hardlinks fail closed", () => {
  const t = tree();
  expect(t.classify("cat src/main.ts").decision).toBe("allow");
  expect(t.classify("rg word src").decision).toBe("allow");
  symlinkSync(t.outside, join(t.root, "escape"));
  symlinkSync(join(t.outside, "missing"), join(t.root, "broken"));
  symlinkSync(t.outside, join(t.root, "src/nested"));
  linkSync(join(t.outside, "file"), join(t.root, "alias"));
  for (const cmd of ["cat escape/file", "cat escape/../other/file", "cat broken", "cat alias", "rg word src", "cat ../other/file"]) expect([cmd, t.classify(cmd).decision]).toEqual([cmd, "ask"]);
  expect(t.classify("cat src/main.ts").decision).toBe("allow"); // unrelated link doesn't block explicit safe file
});

test("recursive searches inspect hidden and ignored files without reading their contents", () => {
  const t = tree();
  writeFileSync(join(t.root, "src/.env"), "secret");
  for (const cmd of ["rg word src", "rg --hidden word src", "rg --no-ignore word src", "grep -r word src", "rg --files src"]) expect(t.classify(cmd).decision).toBe("ask");
  expect(t.classify("cat src/main.ts").decision).toBe("allow");
});

test("setting defaults off, follows config, persists on/off, and policy cannot fall back to the model", async () => {
  const t = tree(); const store = new Store("", ":memory:"); cleanup.push(() => store.db.close());
  expect(new SafePermissionPolicy(store, () => t.root).snapshot()).toEqual({ autoApproveSafe: false, scope: "workers" });
  expect(new SafePermissionPolicy(store, () => t.root).decide(t.at("cat src/main.ts")).reason).toMatch(/off/);
  const policy = new SafePermissionPolicy(store, () => t.root, true);
  expect(policy.snapshot().autoApproveSafe).toBe(true);
  expect(policy.decide(t.at("cat src/main.ts")).decision).toBe("allow");
  policy.setEnabled(false);
  expect(new SafePermissionPolicy(store, () => t.root).snapshot().autoApproveSafe).toBe(false);
  expect(policy.decide(t.at("cat src/main.ts")).decision).toBe("ask");
  const auto: string[] = []; let judged = 0;
  const broker = new PermissionBroker({ safeDecision: (i) => policy.decide(i), holdMs: () => 10, mayJudge: () => true, roots: () => [t.root], judge: async () => { judged++; return { decision: "allow", reason: "unsafe override" }; }, raise() {}, settle() {}, logAuto: (_i, v) => auto.push(v.rule!) });
  expect((await broker.decide(t.at("cat src/main.ts"))).allow).toBe(false);
  policy.setEnabled(true);
  expect((await broker.decide(t.at("cat src/main.ts"))).allow).toBe(true);
  expect((await broker.decide(t.at("curl https://example.com"))).allow).toBe(false);
  expect(auto).toEqual(["read-only-cat"]); expect(judged).toBe(0);
});

test("denied-call normalization preserves unsafe fields and cwd mismatches", () => {
  const call = { tool: "exec_command", toolUseId: "x", input: { cmd: "cat src/main.ts", workdir: ROOT, max_output_tokens: 100 }, cwd: ROOT, reason: "automatic approval review denied" };
  expect(classifySafePermission(deniedPermissionInfo("s", "codex", call), facts).decision).toBe("allow");
  expect(classifySafePermission(deniedPermissionInfo("s", "codex", { ...call, input: { ...call.input, shell: "evil" } }), facts).decision).toBe("ask");
  expect(classifySafePermission(deniedPermissionInfo("s", "codex", { ...call, input: { ...call.input, command: "ls" } }), facts).decision).toBe("ask");
});

test("real Git repository: local status/log/diff pass; helpers, includes, alternates and staged secrets ask", () => {
  const t = tree();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  env.HOME = t.outside; env.XDG_CONFIG_HOME = t.outside;
  const git = (...args: string[]) => { const p = Bun.spawnSync(["git", ...args], { env, cwd: t.root, stdout: "pipe", stderr: "pipe" }); expect(p.exitCode).toBe(0); };
  git("init", "-q");
  // Bun caches homedir at startup; a fresh process supplies an isolated global Git config.
  const classifyGit = (command: string, root = t.root) => {
    const p = Bun.spawnSync(["bun", "-e", 'import { permissionFacts } from "./src/daemon/permission-policy.ts"; import { classifySafePermission } from "./src/daemon/safe-permission.ts"; const {info,root}=await Bun.stdin.json(); console.log(JSON.stringify(classifySafePermission(info,permissionFacts(info,root))));'], { env, stdin: Buffer.from(JSON.stringify({ info: { ...t.at(command), cwd: root }, root })), stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    return JSON.parse(p.stdout.toString());
  };
  for (const cmd of ["git status", "git log --oneline -5", "git diff", "git diff -- src/main.ts"]) expect([cmd, classifyGit(cmd).decision]).toEqual([cmd, "allow"]);
  git("add", "src/main.ts");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  const linked = join(t.outside, "linked");
  git("worktree", "add", "--detach", linked);
  expect(classifyGit("git status", linked).decision).toBe("allow");
  const spoof = join(t.outside, "spoof"); mkdirSync(spoof);
  writeFileSync(join(spoof, ".git"), `gitdir: ${join(t.root, ".git")}\n`);
  expect(classifyGit("git status", spoof).decision).toBe("ask");
  const config = join(t.root, ".git/config");
  const normal = "[core]\nrepositoryformatversion = 0\nfilemode = true\nbare = false\nlogallrefupdates = true\n";
  for (const extra of ["[core]\nfsmonitor = evil", "[diff]\nexternal = evil", "[pager]\nlog = evil", "[filter \"lfs\"]\nprocess = evil", "[include]\npath = /outside/config", "[remote \"origin\"]\npromisor = true", "[extensions]\npartialclone = origin"]) {
    writeFileSync(config, normal + extra + "\n"); expect(classifyGit("git status").decision).toBe("ask");
  }
  writeFileSync(config, normal);
  symlinkSync(join(t.outside, "file"), join(t.root, ".git/objects/leak"));
  expect(classifyGit("git diff").decision).toBe("ask");
  rmSync(join(t.root, ".git/objects/leak"));
  writeFileSync(join(t.root, ".git/objects/info/alternates"), t.outside);
  expect(classifyGit("git log").decision).toBe("ask");
  rmSync(join(t.root, ".git/objects/info/alternates"));
  writeFileSync(join(t.root, ".env"), "private"); git("add", ".env"); rmSync(join(t.root, ".env"));
  expect(classifyGit("git diff --cached").decision).toBe("ask");
});

test("Codex approval transport cannot hide environment changes or broader permissions", () => {
  for (const raw of [{ env: { PATH: "evil" } }, { additionalPermissions: { network: true } }, { proposedExecpolicyAmendment: ["cat"] }, { grantRoot: ROOT }, { networkApprovalContext: { host: "example.com" } }]) {
    expect(classifySafePermission(info("", { provider: "codex", tool: "command", input: codexApprovalInput(raw, "cat src/main.ts") }), facts).decision).toBe("ask");
  }
});

// ---------------------------------------------------------------- D44: scope, exclusion, protected redirect targets
const PROTECTED = [".mcp.json", ".vscode/settings.json", ".husky/pre-commit", ".github/workflows/ci.yml", "package.json", "Makefile", "makefile", "package-lock.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "go.sum", "sub/package.json", ".envrc", ".env.test", ".claude/settings.json", ".codex/config.toml", ".git/hooks/pre-commit"];
for (const target of PROTECTED) for (const op of [">", ">>"]) test(`a redirection never writes ${target} (${op})`, () => {
  const p = `${ROOT}/${target}`;
  const f = { ...facts, paths: { ...facts.paths, [p]: { real: p, kind: "missing" as const } } };
  expect(classifySafePermission(info(`bun test ${op} ${target}`), f).decision).toBe("ask");
});

test("a > redirection over an existing tracked (or unknown) file asks; >> and untracked files don't", () => {
  const p = `${ROOT}/out.log`;
  const at = (tracked: boolean | undefined) => ({ ...facts, paths: { ...facts.paths, [p]: { real: p, kind: "file" as const } }, tracked: { [p]: tracked } });
  expect(classifySafePermission(info("bun test > out.log"), at(true))).toMatchObject({ decision: "ask", reason: expect.stringMatching(/tracked/) });
  expect(classifySafePermission(info("bun test > out.log"), at(undefined)).decision).toBe("ask");
  expect(classifySafePermission(info("bun test 2> out.log"), at(true)).decision).toBe("ask");
  expect(classifySafePermission(info("bun test > out.log"), at(false)).decision).toBe("allow");
  expect(classifySafePermission(info("bun test >> out.log"), at(true)).decision).toBe("allow");
});

test("real Git: truncating a committed file asks, an untracked or new file doesn't", () => {
  const t = tree();
  const git = (...args: string[]) => expect(Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: t.root, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  git("init", "-q"); git("add", "src/main.ts"); git("commit", "-qm", "fixture");
  writeFileSync(join(t.root, "scratch.log"), "old");
  expect(t.classify("bun test > src/main.ts").decision).toBe("ask");
  expect(t.classify("bun test > scratch.log").decision).toBe("allow");
  expect(t.classify("bun test > fresh.log").decision).toBe("allow");
  expect(t.classify("bun test >> src/main.ts").decision).toBe("allow");
});

test("true: reads for any session; project code only for a coordinator worker in its own worktree; \"all\" for everyone", () => {
  const t = tree(); const store = new Store("", ":memory:"); cleanup.push(() => store.db.close());
  let own = false;
  writeFileSync(join(t.root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  const workers = new SafePermissionPolicy(store, () => t.root, true, { ownWorktree: () => own });
  expect(workers.snapshot()).toEqual({ autoApproveSafe: true, scope: "workers" });
  expect(workers.decide(t.at("cat src/main.ts")).decision).toBe("allow");
  for (const cmd of ["bun test", "npm test", "make test", "cargo test", "pytest", "cat src/main.ts && bun test"])
    expect([cmd, workers.decide(t.at(cmd))]).toEqual([cmd, { decision: "ask", reason: expect.stringMatching(/coordinator workers in their own Switchboard worktree/) }]);
  own = true;
  expect(workers.decide(t.at("bun test")).decision).toBe("allow");
  const all = new SafePermissionPolicy(store, () => t.root, "all");
  expect(all.snapshot().scope).toBe("all");
  expect(all.decide(t.at("bun test")).decision).toBe("allow");
});

test("excluded sessions are never auto-approved, for Claude hooks and Codex approvals alike", async () => {
  const t = tree(); const store = new Store("", ":memory:"); cleanup.push(() => store.db.close());
  const excluded = new Set(["claude:worker", "codex:thread"]);
  const policy = new SafePermissionPolicy(store, () => t.root, "all", { excluded: (id) => excluded.has(id), ownWorktree: () => true });
  expect(policy.decide(t.at("cat src/main.ts"))).toMatchObject({ decision: "ask", reason: expect.stringMatching(/excluded/) });
  const broker = new PermissionBroker({ safeDecision: (i) => policy.decide(i), holdMs: () => 10, mayJudge: () => true, roots: () => [t.root], judge: async () => ({ decision: "allow", reason: "x" }), raise() {}, settle() {}, logAuto() {} });
  const codex: PermissionInfo = { sessionId: "codex:thread", provider: "codex", tool: "command", input: codexApprovalInput({}, "bun test"), summary: "bun test", cwd: t.root };
  expect((await broker.decide(codex)).allow).toBe(false);
  excluded.clear();
  expect((await broker.decide(codex)).allow).toBe(true);
  // Codex follows the same scope switch as Claude.
  const scoped = new SafePermissionPolicy(store, () => t.root, true);
  expect(scoped.decide(codex).decision).toBe("ask");
  expect(scoped.decide({ ...codex, input: codexApprovalInput({}, "cat src/main.ts") }).decision).toBe("allow");
});

test("config: autoApproveSafePermissions is false by default; true and \"all\" are kept; anything else is false", async () => {
  const { mergeConfig } = await import("../src/daemon/config.ts");
  expect(mergeConfig({}).autoApproveSafePermissions).toBe(false);
  expect(mergeConfig({ autoApproveSafePermissions: true }).autoApproveSafePermissions).toBe(true);
  expect(mergeConfig({ autoApproveSafePermissions: "all" }).autoApproveSafePermissions).toBe("all");
  for (const bad of ["true", "workers", 1, null]) expect(mergeConfig({ autoApproveSafePermissions: bad as any }).autoApproveSafePermissions).toBe(false);
});

test("own worktree comes from the daemon's launch record, never a folder name, string prefix, symlink or ..", () => {
  const t = tree();
  const base = join(t.outside, "w"), repo = join(base, "repo"), wtRoot = join(base, "worktrees"), task = join(wtRoot, "repo/task"), other = join(wtRoot, "repo/other");
  for (const d of [join(repo, "src"), join(task, "src"), other]) mkdirSync(d, { recursive: true });
  const rec = { cwd: task, root: repo, cwdId: dirIdentity(task) };
  expect(inOwnWorktree(true, rec, join(task, "src"), wtRoot)).toBe(true);
  expect(inOwnWorktree(true, rec, task, wtRoot)).toBe(true);
  expect(inOwnWorktree(false, rec, task, wtRoot)).toBe(false); // not launched by the coordinator
  expect(inOwnWorktree(true, undefined, task, wtRoot)).toBe(false);
  expect(inOwnWorktree(true, rec, other, wtRoot)).toBe(false); // another worker's worktree
  expect(inOwnWorktree(true, rec, `${task}/../other`, wtRoot)).toBe(false);
  expect(inOwnWorktree(true, rec, repo, wtRoot)).toBe(false); // the shared tree
  expect(inOwnWorktree(true, rec, "src", wtRoot)).toBe(false); // relative
  symlinkSync(repo, join(task, "escape"));
  expect(inOwnWorktree(true, rec, join(task, "escape"), wtRoot)).toBe(false); // resolves outside
  // A user's own folder named like the worktree root grants nothing.
  const lookalike = join(repo, ".switchboard-worktrees/x"); mkdirSync(lookalike, { recursive: true });
  expect(inOwnWorktree(false, undefined, lookalike, wtRoot)).toBe(false);
  expect(inOwnWorktree(true, { cwd: lookalike, root: repo }, lookalike, wtRoot)).toBe(false);
  // A worker launched without a worktree, even under a worktree root that contains the repo.
  expect(inOwnWorktree(true, { cwd: repo, root: repo, cwdId: dirIdentity(repo) }, repo, base)).toBe(false);
  // The recorded directory swapped for a symlink or a different directory no longer counts.
  const swapped = join(wtRoot, "repo/swapped"); mkdirSync(swapped);
  const swappedRec = { cwd: swapped, root: repo, cwdId: dirIdentity(swapped) };
  rmSync(swapped, { recursive: true }); mkdirSync(swapped);
  expect(inOwnWorktree(true, swappedRec, swapped, wtRoot)).toBe(false);
  rmSync(swapped, { recursive: true }); symlinkSync(task, swapped);
  expect(inOwnWorktree(true, { cwd: swapped, root: repo }, swapped, wtRoot)).toBe(false);
});

const BYPASSES = ["NODE_OPTIONS=--require=./x.js bun test", "FOO=1 npm test", "env NODE_OPTIONS=x npm test", "npx vitest", "bunx vitest", "bun x vitest", "npm exec vitest", "pnpm dlx vitest", "bun -e 'require(1)'", "bun --eval x", "node -e x", "node test.js", "npm run deploy", "npm run install", "bun run ./script.ts", "bun ./script.ts", "bun test --preload ./x.ts", "npm test; curl https://example.com", "bun test && sh x.sh", "bun test | sh", "bun test $(id)", "bun test `id`", "sh -c 'bun test'", "bash -c 'bun test; id'", "make deploy", "make test CC=./evil", "cargo run", "go run .", "python x.py", "python -m pip install x", "pytest -p evil_plugin", "npm test --prefix /elsewhere", "npm test --userconfig=.npmrc", "yarn test --cwd /elsewhere"];
for (const cmd of BYPASSES) test(`project-code bypass still asks even for an own-worktree worker under "all": ${cmd}`, () => {
  const t = tree(); const store = new Store("", ":memory:"); cleanup.push(() => store.db.close());
  writeFileSync(join(t.root, "package.json"), JSON.stringify({ scripts: { test: "bun test", deploy: "x", install: "x" } }));
  writeFileSync(join(t.root, "x.sh"), ""); writeFileSync(join(t.root, "script.ts"), ""); writeFileSync(join(t.root, "x.ts"), "");
  const policy = new SafePermissionPolicy(store, () => t.root, "all", { ownWorktree: () => true });
  expect(policy.decide(t.at(cmd)).decision).toBe("ask");
  const codex: PermissionInfo = { sessionId: "codex:w", provider: "codex", tool: "command", input: codexApprovalInput({}, cmd), summary: cmd, cwd: t.root };
  expect(policy.decide(codex).decision).toBe("ask");
});

test("own worktree means strictly inside the configured worktree root, through symlinks", () => {
  const t = tree();
  const wtRoot = join(t.outside, "worktrees"), inside = join(wtRoot, "repo/task");
  mkdirSync(inside, { recursive: true });
  expect(insideWorktreeRoot(inside, wtRoot)).toBe(true);
  expect(insideWorktreeRoot(wtRoot, wtRoot)).toBe(false);
  expect(insideWorktreeRoot(t.root, wtRoot)).toBe(false);
  expect(insideWorktreeRoot(null, wtRoot)).toBe(false);
  expect(insideWorktreeRoot(join(wtRoot, "missing"), wtRoot)).toBe(false);
  symlinkSync(t.root, join(wtRoot, "link"));
  expect(insideWorktreeRoot(join(wtRoot, "link"), wtRoot)).toBe(false); // resolves outside
});
