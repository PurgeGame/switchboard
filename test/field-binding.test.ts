// The decision must be bound to exactly what the provider executes: every field that changes
// what runs (or where) is checked, or the request asks.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifySafePermission, type SafetyFacts } from "../src/daemon/safe-permission.ts";
import { codexApprovalInfo, permissionFacts } from "../src/daemon/permission-policy.ts";
import { PermissionBroker, type PermissionInfo } from "../src/daemon/permissions.ts";
import type { CodexApproval } from "../src/daemon/adapters/codex-live.ts";

const ROOT = "/workspace/repo";
const info = (command: unknown, cwd = ROOT, input: Record<string, unknown> = { command }): PermissionInfo => ({ sessionId: "claude:worker", provider: "claude", tool: "Bash", input, summary: String(command), cwd });
const file = (p: string) => ({ [`${ROOT}/${p}`]: { real: `${ROOT}/${p}`, kind: "file" as const } });
const dir = (p: string) => ({ [`${ROOT}/${p}`]: { real: `${ROOT}/${p}`, kind: "directory" as const, treeSafe: true } });
const missing = (p: string) => ({ [`${ROOT}/${p}`]: { real: `${ROOT}/${p}`, kind: "missing" as const } });
const facts: SafetyFacts = {
  root: ROOT, gitSafe: true,
  paths: { [ROOT]: { real: ROOT, kind: "directory", treeSafe: true }, ...dir("src"), ...dir("test"), ...file("src/main.ts"), ...file("package.json"), ...missing("dist"), ...missing("cov"), ...missing("coverage.xml"), ...missing("test/src") },
  package: { path: `${ROOT}/package.json`, scripts: { test: "x", build: "tsc" } },
  tracked: { [`${ROOT}/src`]: true },
};
const decide = (command: string, cwd = ROOT, f: SafetyFacts = facts) => classifySafePermission(info(command, cwd), f).decision;

// ---- Codex: the approval request's own fields decide where and what runs

const approval = (raw: Record<string, unknown>): CodexApproval => ({
  raw: { threadId: "t", turnId: "u", itemId: "i", ...raw }, rpcId: 1, threadId: "t", method: "item/commandExecution/requestApproval", kind: typeof raw.kind === "string" ? raw.kind : "command",
  summary: "", reason: null, ts: 0, command: typeof raw.command === "string" ? raw.command : null, rawCommand: (raw.command as string) ?? null,
  cwd: typeof raw.cwd === "string" ? raw.cwd : null, paths: [], grantRoot: null,
});
const codexDecide = (raw: Record<string, unknown>, sessionCwd: string | null = ROOT) => classifySafePermission(codexApprovalInfo(approval(raw), sessionCwd), facts).decision;

test("Codex: the command in the request runs where the request says", () => {
  expect(codexDecide({ command: "cat src/main.ts", cwd: ROOT })).toBe("allow");
  expect(codexDecide({ command: "cat src/main.ts", cwd: ROOT, kind: "command" })).toBe("allow");
});

test("Codex: a stdin write to a running terminal is not the command it names", () => {
  // kind "writeStdin" approves sending input to an existing process (perhaps an interactive
  // shell); the `command` field then is not what is executed.
  expect(codexDecide({ command: "cat src/main.ts", cwd: ROOT, kind: "writeStdin" })).toBe("ask");
  expect(codexDecide({ command: "cat src/main.ts", cwd: ROOT, kind: { other: true } })).toBe("ask");
});

test("Codex: a sub-command approval (zsh exec bridge) asks", () => {
  expect(codexDecide({ command: "cat src/main.ts", cwd: ROOT, approvalId: "5d1c" })).toBe("ask");
  expect(codexDecide({ command: "cat src/main.ts", cwd: ROOT, approvalId: null })).toBe("allow");
});

test("Codex: the working directory comes from the request, never from Switchboard's session record", () => {
  // No cwd (or one that is not a string) in the request: Codex runs it wherever the turn is; the
  // session's recorded cwd may be stale or a different turn's.
  expect(codexDecide({ command: "cat src/main.ts" }, ROOT)).toBe("ask");
  expect(codexDecide({ command: "cat src/main.ts", cwd: { path: "/elsewhere" } }, ROOT)).toBe("ask");
  expect(codexDecide({ command: "cat src/main.ts", cwd: ["/elsewhere"] }, ROOT)).toBe("ask");
  expect(codexDecide({ command: "cat src/main.ts", cwd: "src/.." }, ROOT)).toBe("ask");
});

test("Codex: argv commands and remote environments", () => {
  expect(codexDecide({ command: ["cat", "src/main.ts"], cwd: ROOT })).toBe("allow");
  expect(codexDecide({ command: ["cat", "src/main.ts"], cwd: ROOT, environmentId: "remote-1" })).toBe("ask");
  expect(codexDecide({ command: ["cat", 7], cwd: ROOT })).toBe("ask");
});

// ---- Claude: fields beyond the command that change how it runs, and the exact allow response

test("Claude Bash: background, sandbox and unknown fields ask", () => {
  for (const extra of [{ run_in_background: true }, { dangerouslyDisableSandbox: true }, { run_in_background: false }, { shell: "zsh" }, { env: {} }])
    expect(classifySafePermission(info("cat src/main.ts", ROOT, { command: "cat src/main.ts", ...extra }), facts).decision).toBe("ask");
  expect(classifySafePermission(info("cat src/main.ts", ROOT, { command: "cat src/main.ts", description: "anything", timeout: 5 }), facts).decision).toBe("allow");
  for (const tool of ["BashOutput", "KillShell", "KillBash", "bash", "Bash ", "MultiEdit", "Write", "Edit", "NotebookEdit"])
    expect(classifySafePermission({ ...info("cat src/main.ts"), tool }, facts).decision).toBe("ask");
});

test("Claude: an automatic allow returns no updatedInput, so exactly the checked input runs", async () => {
  const broker = new PermissionBroker({ holdMs: () => 1000, safeDecision: () => ({ decision: "allow", rule: "r", reason: "r" }), mayJudge: () => false, roots: () => [], judge: async () => null, raise: () => {}, settle: () => {}, logAuto: () => {} });
  const out = await broker.claudeHook(info("cat src/main.ts")) as { hookSpecificOutput: { decision: Record<string, unknown> } };
  expect(out.hookSpecificOutput.decision).toEqual({ behavior: "allow" });
});

// ---- Verification: options whose effect is elsewhere than the checked value

test("package scripts run in the package's directory: arguments checked from a subdirectory ask", () => {
  // npm/pnpm/yarn/bun run the script with cwd = the directory of the nearest package.json, so
  // `--outDir src` from test/ writes <root>/src, while the check resolved <root>/test/src.
  expect(decide("npm run build -- --outDir src", `${ROOT}/test`)).toBe("ask");
  expect(decide("bun run build -- --project tsconfig.json", `${ROOT}/test`)).toBe("ask");
  expect(decide("npm test", `${ROOT}/test`)).toBe("allow");
  expect(decide("npm run build -- --outDir dist")).toBe("allow");
});

test("pytest coverage reports without a path write default files that were never checked", () => {
  for (const c of ["pytest --cov=src --cov-report=xml", "pytest --cov-report html", "pytest --cov-report=lcov", "pytest --cov-report=json", "pytest --cov-report=annotate"]) expect([c, decide(c)]).toEqual([c, "ask"]);
  for (const c of ["pytest --cov=src --cov-report=term-missing", "pytest --cov-report term", "pytest --cov-report=html:cov"]) expect([c, decide(c)]).toEqual([c, "allow"]);
});

test("output options resolved against another directory ask (go -outputdir, forge --out/--cache-path)", () => {
  for (const c of ["go test -outputdir dist -coverprofile=c.out ./...", "forge build --out dist", "forge test --cache-path cov"]) expect([c, decide(c)]).toEqual([c, "ask"]);
});

test("verification globs: a leading wildcard can expand to an option; ** recurses", () => {
  const f: SafetyFacts = { ...facts, globs: { [`${ROOT}/*.ts`]: [`${ROOT}/a.ts`], [`${ROOT}/src/**`]: [`${ROOT}/src/main.ts`] }, paths: { ...facts.paths, ...file("a.ts") } };
  for (const c of ["bun test *.ts", "bun test src/**"]) expect([c, decide(c, ROOT, f)]).toEqual([c, "ask"]);
});

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((f) => f()));
function repo() {
  mkdirSync(resolve(".sandbox"), { recursive: true });
  const base = mkdtempSync(resolve(".sandbox/field-binding-"));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "worker");
  mkdirSync(join(root, "src"), { recursive: true }); mkdirSync(join(root, "test/e2e"), { recursive: true });
  writeFileSync(join(root, "src/main.ts"), "x"); writeFileSync(join(root, "test/e2e/run.ts"), "x");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "bun test" } }));
  const classify = (c: string, cwd = root) => { const r = info(c, cwd); return classifySafePermission(r, permissionFacts(r, root)).decision; };
  return { root, classify };
}

test("real filesystem: a script's output option from a subdirectory was approved; it asks", () => {
  const t = repo();
  expect(t.classify("npm run build -- --outDir src", join(t.root, "test"))).toBe("ask");
  expect(t.classify("npm run build -- --outDir dist")).toBe("allow");
});

test("real filesystem: glob matches the shell may add (dotglob, nocaseglob) are checked too", () => {
  const t = repo();
  expect(t.classify("bun test/e2e/*.ts")).toBe("allow");
  writeFileSync(join(t.root, "test/e2e/.env.ts"), "private"); // bash with dotglob, zsh with GLOB_DOTS
  expect(t.classify("bun test/e2e/*.ts")).toBe("ask");
  rmSync(join(t.root, "test/e2e/.env.ts"));
  writeFileSync(join(t.root, "test/e2e/secrets.TS"), "private"); // nocaseglob / NO_CASE_GLOB
  expect(t.classify("bun test/e2e/*.ts")).toBe("ask");
});
