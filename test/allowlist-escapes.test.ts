// Allowlist escapes found in review: each command below was auto-approved while doing something
// outside "read-only" (safe-permission) or outside "run the project's verification".
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifySafePermission, type SafetyFacts } from "../src/daemon/safe-permission.ts";
import { permissionFacts } from "../src/daemon/permission-policy.ts";
import type { PermissionInfo } from "../src/daemon/permissions.ts";

const ROOT = "/workspace/repo";
const info = (command: unknown, cwd = ROOT): PermissionInfo => ({ sessionId: "claude:worker", provider: "claude", tool: "Bash", input: { command }, summary: String(command), cwd });
const file = (p: string) => ({ [`${ROOT}/${p}`]: { real: `${ROOT}/${p}`, kind: "file" as const } });
const dir = (p: string) => ({ [`${ROOT}/${p}`]: { real: `${ROOT}/${p}`, kind: "directory" as const, treeSafe: true } });
const missing = (p: string) => ({ [`${ROOT}/${p}`]: { real: `${ROOT}/${p}`, kind: "missing" as const } });
const facts: SafetyFacts = {
  root: ROOT, gitSafe: true,
  paths: { [ROOT]: { real: ROOT, kind: "directory", treeSafe: true }, ...dir("src"), ...dir("dist"), ...dir("target"), ...file("src/main.ts"), ...file("src/main.go"), ...file("package.json"), ...file("=ls"), ...missing("out.xml"), ...missing("cov") },
  package: { path: `${ROOT}/package.json`, scripts: { test: "x", build: "x" } },
  tracked: { [`${ROOT}/src`]: true, [`${ROOT}/src/main.go`]: true, [`${ROOT}/src/main.ts`]: true, [`${ROOT}/dist`]: false, [`${ROOT}/target`]: false },
};
const decide = (command: string, f: SafetyFacts = facts) => classifySafePermission(info(command), f).decision;

test("pytest -o rewrites ini settings (cache_dir, testpaths, addopts): asks", () => {
  for (const c of ["pytest -o cache_dir=/tmp/cache", "pytest -o cache_dir=src", "pytest -o addopts=-pevil", "python -m pytest -o testpaths=/elsewhere"]) expect([c, decide(c)]).toEqual([c, "ask"]);
});

test("pytest --basetemp deletes its directory first: asks even inside the worktree", () => {
  for (const c of ["pytest --basetemp=src", "pytest --basetemp .", "pytest --basetemp=dist"]) expect([c, decide(c)]).toEqual([c, "ask"]);
});

test("output options cannot overwrite tracked or unknown files and directories", () => {
  for (const c of ["go test -c -o src/main.go", "go test -coverprofile=src/main.go ./...", "npm run build -- --outDir src", "npm run build -- --outDir .", "bun test --coverage-dir=src", "pytest --junitxml=src/main.ts", "pytest --cov-report=html:src", "cargo test --target-dir src", "forge build --out src", "bun test --reporter-outfile=package.json", "npm run build -- --outDir=.github"])
    expect([c, decide(c)]).toEqual([c, "ask"]);
  for (const c of ["go test -c -o test-bin", "npm run build -- --outDir dist", "pytest --junitxml=out.xml", "pytest --cov-report=html:cov", "cargo test --target-dir target"]) {
    const f = { ...facts, paths: { ...facts.paths, ...missing("test-bin") } };
    expect([c, decide(c, f)]).toEqual([c, "allow"]);
  }
});

test("grep/rg: a word before -e/--regexp is a file, not the pattern", () => {
  for (const c of ["grep /etc/passwd -e root src/main.ts", "rg /etc/passwd -e root", "grep -n /etc/passwd --regexp root"]) expect([c, decide(c)]).toEqual([c, "ask"]);
  expect(decide("grep -n -e word src/main.ts")).toBe("allow");
});

test("unquoted glob characters ask outside checked verification path operands", () => {
  for (const c of ["grep /etc/* src/main.ts", "rg /home/*/.ssh/id* src", "grep -e x* src/main.ts", "rg [a]b src", "bun test -t x*", "pytest -k foo*"]) expect([c, decide(c)]).toEqual([c, "ask"]);
  for (const c of ["grep 'a*b' src/main.ts", "rg \"x[0-9]\" src", "bun test -t 'x*'"]) expect([c, decide(c)]).toEqual([c, "allow"]);
});

test("zsh =command expansion and non-ASCII separators ask", () => {
  expect(decide("cat =ls")).toBe("ask");
  expect(decide("cat src/main.ts")).toBe("ask");
  expect(decide("cat src/main.ts ls")).toBe("ask");
  expect(decide("cat '=ls'")).toBe("allow");
});

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((f) => f()));

test("real filesystem: pytest -o and --basetemp were approved; now ask", () => {
  mkdirSync(resolve(".sandbox"), { recursive: true });
  const base = mkdtempSync(resolve(".sandbox/escapes-")); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "worker"); mkdirSync(join(root, "src"), { recursive: true }); writeFileSync(join(root, "src/a.py"), "x");
  const classify = (c: string) => { const r = info(c, root); return classifySafePermission(r, permissionFacts(r, root)).decision; };
  expect(classify("pytest")).toBe("allow");
  for (const c of ["pytest -o cache_dir=/tmp/elsewhere", "pytest --basetemp=src"]) expect([c, classify(c)]).toEqual([c, "ask"]);
});

test("real Git repository: a nested .git between the worktree root and the cwd makes git ask", () => {
  mkdirSync(resolve(".sandbox"), { recursive: true });
  const base = mkdtempSync(resolve(".sandbox/escapes-git-")); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "worker"), home = join(base, "home"); mkdirSync(join(root, "src"), { recursive: true }); mkdirSync(home);
  writeFileSync(join(root, "src/main.ts"), "x");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  env.HOME = home; env.XDG_CONFIG_HOME = home;
  const git = (cwd: string, ...args: string[]) => expect(Bun.spawnSync(["git", ...args], { env, cwd, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  git(root, "init", "-q");
  const classifyGit = (command: string, cwd: string) => {
    const p = Bun.spawnSync(["bun", "-e", 'import { permissionFacts } from "./src/daemon/permission-policy.ts"; import { classifySafePermission } from "./src/daemon/safe-permission.ts"; const {info,root}=await Bun.stdin.json(); console.log(JSON.stringify(classifySafePermission(info,permissionFacts(info,root))));'], { env, stdin: Buffer.from(JSON.stringify({ info: info(command, cwd), root })), stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    return JSON.parse(p.stdout.toString()).decision;
  };
  const sub = join(root, "vendor/lib/sub"); mkdirSync(sub, { recursive: true }); writeFileSync(join(sub, "f.ts"), "x");
  expect(classifyGit("git status", sub)).toBe("allow");
  // A nested repository has its own config (hooks, fsmonitor, pager...) that gitSafe never read.
  git(join(root, "vendor/lib"), "init", "-q");
  expect(classifyGit("git status", sub)).toBe("ask");
  rmSync(join(root, "vendor/lib/.git"), { recursive: true });
  writeFileSync(join(root, "vendor/lib/.git"), `gitdir: ${join(base, "elsewhere")}\n`);
  expect(classifyGit("git log", sub)).toBe("ask");
  // From the root, the recursive walk of "." already meets the nested .git and asks.
  expect(classifyGit("git status", root)).toBe("ask");
  rmSync(join(root, "vendor/lib/.git"));
  expect(classifyGit("git status", sub)).toBe("allow");
});

test("real Git repository: output options may fill untracked output directories, never tracked ones", () => {
  mkdirSync(resolve(".sandbox"), { recursive: true });
  const base = mkdtempSync(resolve(".sandbox/escapes-out-")); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "worker"); mkdirSync(join(root, "src"), { recursive: true }); mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "src/main.ts"), "x"); writeFileSync(join(root, "dist/old.js"), "built");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const git = (...args: string[]) => expect(Bun.spawnSync(["git", ...args], { env, cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  git("init", "-q"); git("add", "src/main.ts", "package.json"); git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "fixture");
  const classify = (c: string) => { const r = info(c, root); return classifySafePermission(r, permissionFacts(r, root)).decision; };
  for (const c of ["npm run build -- --outDir dist", "npm run build -- --outDir build/new", "go test -c -o dist/old.js"]) expect([c, classify(c)]).toEqual([c, "allow"]);
  for (const c of ["npm run build -- --outDir src", "npm run build -- --outDir .", "go test -c -o src/main.ts", "npm run build -- --outDir node_modules"]) expect([c, classify(c)]).toEqual([c, "ask"]);
});
