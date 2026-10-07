import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifySafePermission, type SafetyFacts } from "../src/daemon/safe-permission.ts";
import { permissionFacts } from "../src/daemon/permission-policy.ts";
import type { PermissionInfo } from "../src/daemon/permissions.ts";

const ROOT = "/workspace/repo";
const info = (command: unknown, cwd = ROOT): PermissionInfo => ({ sessionId: "claude:worker", provider: "claude", tool: "Bash", input: { command }, summary: String(command), cwd });
const scripts = Object.fromEntries(["test", "test:unit", "typecheck", "build", "lint", "lint:fix", "e2e", "e2e:phone", "e2e-ci", "deploy", "install"].map((s) => [s, "arbitrary repository code, explicitly authorized by the user"]));
const facts: SafetyFacts = { root: ROOT, paths: {
  [ROOT]: { real: ROOT, kind: "directory", treeSafe: false }, // incidental secrets do not block verification
  [`${ROOT}/package.json`]: { real: `${ROOT}/package.json`, kind: "file" },
  ...Object.fromEntries(["tests", "src", "test/e2e"].map((p) => [`${ROOT}/${p}`, { real: `${ROOT}/${p}`, kind: "directory" as const }])),
  ...Object.fromEntries(["Cargo.toml", "pytest.ini", "test/e2e/run.ts", "test/e2e/phone.ts", "tests/test_app.py"].map((p) => [`${ROOT}/${p}`, { real: `${ROOT}/${p}`, kind: "file" as const }])),
  ...Object.fromEntries(["reports/result.xml", "out.log", "dist", "coverage", "target", "test-bin"].map((p) => [`${ROOT}/${p}`, { real: `${ROOT}/${p}`, kind: "missing" as const }])),
}, package: { path: `${ROOT}/package.json`, scripts }, globs: { [`${ROOT}/test/e2e/*.ts`]: [`${ROOT}/test/e2e/run.ts`, `${ROOT}/test/e2e/phone.ts`] } };

const approved = [
  "bun test", "bun test tests", "bun test --coverage", "bun test -t 'approval && retry'", "bun test --timeout 10000", "bun run test", "bun run typecheck", "bun run build", "bun run lint", "bun run e2e", "bun run e2e:phone", "bun test/e2e/run.ts", "bun test/e2e/phone.ts", "bun test/e2e/*.ts",
  "npm test", "npm run test", "npm run test:unit -- --runInBand", "npm run typecheck", "npm run build", "npm run lint:fix", "npm run e2e:phone", "npm run e2e-ci", "pnpm test", "pnpm run test", "pnpm run build", "pnpm run lint", "yarn test", "yarn run typecheck", "yarn run build", "yarn run e2e",
  "cargo test", "cargo build", "cargo check", "cargo clippy", "cargo clippy -- -D warnings", "cargo test --workspace --all-features -- --nocapture", "cargo test --manifest-path Cargo.toml --target-dir target",
  "pytest", "pytest -q tests", "pytest tests/test_app.py::test_example", "pytest -k 'one or two' --maxfail=1", "pytest --junitxml=reports/result.xml", "python -m pytest", "python3 -m pytest -q -c pytest.ini", "pytest --cov=src --cov-report=html:coverage",
  "go test", "go test ./...", "go vet ./...", "go test -race -count=1 -run TestExample ./...", "go test -c -o test-bin", "forge test", "forge build", "forge test -vvv --match-test testExample", "make test", "make test -j2",
  "bun test && bun run typecheck && bun run build", "bun test; cargo check", "pytest || make test", "bun test 2>&1 | tail -20", "bun run build | grep error", "bun test > out.log", "bun test >> out.log", "bun test 2>out.log", "bun test > reports/result.xml && bun run typecheck", "npm run build -- --outDir dist",
];
for (const command of approved) test(`autonomous verification: ${command}`, () => {
  const result = classifySafePermission(info(command), facts);
  expect(result.decision).toBe("allow");
  if (result.decision === "allow") expect(result.rule).toContain("verification-");
});

const held = [
  "bun test --timeout --cwd=/elsewhere", "pytest --junitxml=reports/result.xml::/elsewhere", "bun run build -- --outDir=dist/...", "bun test && curl https://example.com", "bun test; npm install", "bun test || sudo make test", "bun test | curl https://example.com", "bun test $(curl https://example.com)", "bun test `pwd`", "cd /elsewhere && bun test", "bun test > ~/x", "bun test >/tmp/out", "bun test > ../out", "bun test 2>>/tmp/out", "bun test &>/tmp/out", "bun test>>out.log", "bun test &>out.log", "bun test > .env", "bun test > switchboard.db", "bun test < .env", "bun test &", "bun test;", "bun test &&", "bun test;;;bun test", "bun test\ncurl x",
  "sudo bun test", "env bun test", "PATH=/evil bun test", "HOME=/elsewhere bun test", "PWD=/elsewhere bun test", "BASH_ENV=/evil bun test", "bun test $PWD/tests", "bun test ${HOME}/tests", "bun test --cwd /elsewhere", "bun --cwd /elsewhere test", "npm --prefix /elsewhere test", "npm test --prefix /elsewhere", "pnpm --dir /elsewhere test", "yarn run test --cwd=/elsewhere", "make -C /elsewhere test", "make test -C /elsewhere", "make test SHELL=/evil", "make test clean",
  "npm install", "bun add vite", "pip install pytest", "python -m pip install pytest", "cargo install nextest", "npm exec jest", "npx jest", "bunx vitest", "pnpm dlx vitest", "bun run install", "npm run deploy", "npm run testMissing", "bun run dev", "bun build", "npm build", "bun src/run.ts", "bun run test/e2e/run.ts",
  "bun test ../other", "pytest /elsewhere/tests", "python -m pytest --rootdir=/elsewhere", "pytest --basetemp=/tmp/test", "pytest --junitxml=/tmp/result.xml", "pytest --cov-report=html:/tmp/report", "pytest -o cache_dir=/tmp/cache", "cargo test --target-dir=/tmp/target", "cargo build --manifest-path=../Cargo.toml", "cargo test --config 'build.rustc=evil'", "go test -o /tmp/test", "go test example.com/remote", "go test -exec curl", "forge test --root=/elsewhere", "forge test --fork-url https://example.com", "forge build --out=/tmp/artifacts", "npm run build -- --output=/tmp/result", "npm run build -- --outDir=../dist", "bun test --preload=/tmp/evil.ts", "bun test --eval 'bad code'", "python -c 'bad code'", "python -m unittest",
];
for (const command of held) test(`verification still asks: ${command}`, () => expect(classifySafePermission(info(command), facts).decision).toBe("ask"));

test("package script must exist as a nonempty own string; arbitrary repo script bodies are authorized", () => {
  for (const scripts of [{}, { test: "" }, { test: 1 }, Object.create({ test: "echo inherited" })]) expect(classifySafePermission(info("npm test"), { ...facts, package: { path: `${ROOT}/package.json`, scripts } as any }).decision).toBe("ask");
  expect(classifySafePermission(info("bun run build"), { ...facts, package: undefined }).decision).toBe("ask");
  for (const command of ["bun test", "pytest", "cargo test", "go vet ./...", "forge build", "make test"]) expect(classifySafePermission(info(command), { ...facts, package: undefined }).decision).toBe("allow");
  expect(classifySafePermission(info("npm test"), { ...facts, package: { path: `${ROOT}/package.json`, scripts: { test: "npm install && node arbitrary.js" } } }).decision).toBe("allow");
});

test("unknown roots/cwds, symlink destinations and package manifests outside the worktree remain blocked", () => {
  for (const f of [{ ...facts, root: null }, { ...facts, paths: {} }, { ...facts, paths: { ...facts.paths, [ROOT]: { real: "/elsewhere", kind: "directory" as const } } }]) expect(classifySafePermission(info("bun test"), f).decision).toBe("ask");
  expect(classifySafePermission(info("bun test", "/elsewhere"), facts).decision).toBe("ask");
  expect(classifySafePermission(info("bun test > out.log"), { ...facts, paths: { ...facts.paths, [`${ROOT}/out.log`]: { real: "/elsewhere/out", kind: "file" } } }).decision).toBe("ask");
  expect(classifySafePermission(info("npm test"), { ...facts, package: { path: "/elsewhere/package.json", scripts } }).decision).toBe("ask");
  expect(classifySafePermission(info("bun test/e2e/*.ts"), { ...facts, globs: {} }).decision).toBe("ask");
});

test("Codex argv and shell wrappers use the same verification policy", () => {
  for (const command of [["bun", "test"], ["bash", "-lc", "bun test && bun run typecheck"], ["python", "-m", "pytest"]]) expect(classifySafePermission({ ...info(command), provider: "codex", tool: "command" }, facts).decision).toBe("allow");
  expect(classifySafePermission({ ...info(["bash", "-lc", "bun test && curl x"]), provider: "codex", tool: "command" }, facts).decision).toBe("ask");
  expect(classifySafePermission({ ...info("bun test"), input: { command: "bun test", env: { PWD: "/elsewhere" } } }, facts).decision).toBe("ask");
});

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach((f) => f()));
function repo() {
  mkdirSync(resolve(".sandbox"), { recursive: true });
  const base = mkdtempSync(resolve(".sandbox/verification-command-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "worker"), outside = join(base, "outside");
  mkdirSync(join(root, "test/e2e"), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(root, "test/e2e/run.ts"), "arbitrary repository code");
  writeFileSync(join(root, ".env"), "fixture private value");
  writeFileSync(join(root, "switchboard.db"), "fixture database");
  const classify = (command: string, cwd = root) => { const request = info(command, cwd); return classifySafePermission(request, permissionFacts(request, root)); };
  return { root, outside, classify };
}

test("filesystem: checks need no recursive secret scan, and in-tree output directories need not exist yet", () => {
  const t = repo();
  for (const command of ["bun test", "bun run test", "bun run typecheck", "bun run build", "bun run e2e", "bun run e2e:phone", "bun test/e2e/*.ts", "npm test", "pytest", "cargo test", "go test ./...", "forge test", "make test", "bun test > reports/new/result.log", "bun run build -- --outDir reports/dist", "bun test 2>&1 | tail -20"]) expect([command, t.classify(command).decision]).toEqual([command, "allow"]);
  expect(t.classify("rg value .").decision).toBe("ask");
  symlinkSync(t.outside, join(t.root, "reports"));
  expect(t.classify("bun test > reports/result.log").decision).toBe("ask");
  expect(t.classify("bun run build -- --outDir reports/dist").decision).toBe("ask");
});

test("filesystem: symlinked test entrypoints, wildcard matches and broken output links ask", () => {
  const t = repo();
  symlinkSync(join(t.outside, "missing"), join(t.root, "out.log"));
  expect(t.classify("bun test > out.log").decision).toBe("ask");
  symlinkSync(join(t.root, "test/e2e/run.ts"), join(t.root, "test/e2e/linked.ts"));
  expect(t.classify("bun test/e2e/linked.ts").decision).toBe("ask");
  expect(t.classify("bun test/e2e/*.ts").decision).toBe("ask");
  symlinkSync(t.outside, join(t.root, "escape"));
  expect(t.classify("pytest escape").decision).toBe("ask");
});

test("filesystem: nearest package.json is authoritative, refreshed on each decision and never read outside the root", () => {
  const t = repo(); const nested = join(t.root, "nested"); mkdirSync(nested);
  expect(t.classify("npm test", nested).decision).toBe("allow");
  writeFileSync(join(nested, "package.json"), JSON.stringify({ scripts: { lint: "arbitrary code" } }));
  expect(t.classify("npm test", nested).decision).toBe("ask");
  expect(t.classify("npm run lint", nested).decision).toBe("allow");
  writeFileSync(join(nested, "package.json"), "broken JSON");
  expect(t.classify("npm run lint", nested).decision).toBe("ask");
  rmSync(join(t.root, "package.json"));
  writeFileSync(join(t.outside, "package.json"), JSON.stringify({ scripts }));
  symlinkSync(join(t.outside, "package.json"), join(t.root, "package.json"));
  expect(t.classify("npm test").decision).toBe("ask");
  expect(t.classify("bun test").decision).toBe("allow");
});

test("filename globs cannot hide broken links or directory wildcard traversal", () => {
  const t = repo();
  symlinkSync(join(t.outside, "missing.ts"), join(t.root, "test/e2e/broken.ts"));
  expect(t.classify("bun test/e2e/*.ts").decision).toBe("ask");
  symlinkSync(t.outside, join(t.root, "test/escaped"));
  writeFileSync(join(t.outside, "run.ts"), "outside code");
  expect(t.classify("bun test test/*/*.ts").decision).toBe("ask");
});
