// Differential test: every command string the safe-permission grammar accepts must be split by
// bash exactly as we split it: the same simple commands, operators and redirections, and the
// same argument words after quote removal. Any disagreement is a parser differential (the
// classifier would check one command and the shell would run another), so the grammar tightens.
//
// Bash never executes a corpus command here:
//  - structure: the string becomes the body of a function definition (`eval "__f() { $c\n}"`),
//    which bash parses but does not run, and `declare -f` prints bash's own canonical form. The
//    grammar rejects `{`, `}`, `(`, `)`, `$`, backticks, backslashes and newlines (asserted below
//    before bash sees anything), so a body cannot close the definition early or expand anything.
//  - words: only for strings whose structure already matched, each single word's source text goes
//    through `set -f; eval "set -- $word"`: no unquoted operator can be in it (bash agreed on the
//    structure), no expansion character is, and globbing is off.
// Both run with PATH=/nonexistent, no profile/rc files, in an empty temporary directory.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellSyntax, type ShellSyntax } from "../src/daemon/safe-permission.ts";

const BASH = Bun.which("bash") ?? "/bin/bash";
const ZSH = Bun.which("zsh");
const SCRATCH = mkdtempSync(join(tmpdir(), "sb-parser-differential-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const HELPER = `
set -f
mode=$1; shift
if [ "$mode" = parse ]; then
  for c in "$@"; do
    if eval "__f() { $c
}" 2>/dev/null; then declare -f __f; else printf 'SYNTAX-ERROR\\n'; fi
    unset -f __f 2>/dev/null
    printf '\\0'
  done
else
  for w in "$@"; do
    eval "set -- $w" 2>/dev/null || printf 'EVAL-ERROR'
    for a in "$@"; do printf '%s\\001' "$a"; done
    printf '\\0'
  done
fi`;

/** Never hand bash anything that could run: the grammar's own exclusions, re-checked here. */
const inert = (s: string) => /^[\x20-\x7e]*$/.test(s) && !/[$`\\(){}]/.test(s);

function run(shell: string[], mode: "parse" | "words", items: string[]): string[] {
  if (!items.length) return [];
  for (const s of items) if (!inert(s)) throw new Error(`refusing to pass a non-inert string to a shell: ${JSON.stringify(s)}`);
  const p = Bun.spawnSync([...shell, HELPER, "_", mode, ...items], { cwd: SCRATCH, env: { PATH: "/nonexistent", HOME: SCRATCH }, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().split("\0");
  out.pop();
  if (out.length !== items.length) throw new Error(`shell returned ${out.length} results for ${items.length} items: ${p.stderr.toString()}`);
  return out;
}

/** bash's `declare -f` layout for the structure we parsed, words exactly as written. */
function canonical(s: ShellSyntax): string {
  let body = "";
  s.commands.forEach((c, i) => {
    // bash prints the default descriptor of `1>`/`1>>` as `>`/`>>`.
    const parts = [...c.words.map((w) => w.raw), ...c.redirects.map((r) => (r.target ? `${r.op.replace(/^1(?=>[^&]*$)/, "")} ${r.target.raw}` : r.op))];
    body += parts.join(" ");
    const op = s.operators[i];
    if (op) body += op === ";" ? ";\n    " : ` ${op} `;
  });
  return `__f () \n{ \n    ${body}\n}\n`;
}

// ---- corpus: commands from the existing tests, tricky hand-written ones and generated variants
const fromTests = [
  "cat src/main.ts; ls", "cat src/main.ts && ls", "cat src/main.ts | cat", "pwd", "ls", "ls -lah src", "cat 'src/a b.ts'", 'cat "src/a b.ts"', "head -n 20 src/main.ts", "tail -10 src/main.ts",
  "rg 'permission|approval' src", "rg -n -e word src", "rg --files src", "grep -rn word src", "git status --short", "git log --oneline -5", "git diff --stat", "git diff -- src/main.ts", "git status", "rg -n 'foo' src",
  "bun test", "bun test -t 'approval && retry'", "bun test --timeout 10000", "bun run test", "npm test", "cargo test", "cargo clippy -- -D warnings", "pytest -k 'one or two' --maxfail=1", "pytest tests/test_app.py::test_example",
  "python3 -m pytest -q -c pytest.ini", "go test -race -count=1 -run TestExample ./...", "make test -j2", "bun test && bun run typecheck && bun run build", "bun test; cargo check", "pytest || make test",
  "bun test 2>&1 | tail -20", "bun run build | grep error", "bun test > out.log", "bun test>>out.log", "bun test 2>out.log", "bun test &>out.log", "bun test > reports/result.xml && bun run typecheck",
  "npm run build -- --outDir dist", "cat '=ls'", "cat =ls", "grep 'a*b' src/main.ts", "rg \"x[0-9]\" src", "bun test -t 'x*'", "bun test/e2e/*.ts", "go test -c -o test-bin", "bun test 1>&2",
];
const handWritten = [
  "cat 12>out", "cat 0>out", "cat x 3>out", "cat a2>out", "cat 'a'>out", "cat \"a\">out", "cat a>out", "a 2>&1>x", "a 2>&10", "a >&2", "a > >x", "a >| x", "a |& b", "a & b", "a &", "a;;b", "a ; ; b",
  "x=1 cat a", "'x=1' cat a", "cat a x=1", "time cat a", "if cat a", "! cat a", "cat a; then", "cat ^a", "cat a==b", "cat \"a!b\"", "cat 'a!b'", "cat a!b", "cat #a", "cat a#b", "cat ~/a", "cat a~", "cat [a]", "cat a]",
  "cat ''", "cat \"\"", "cat '' \"\" x", "cat 'a'b", "cat a'b'", "cat 'a''b'", "cat \"a\"'b'", "cat \"it's\"", "cat 'say \"hi\"'", "cat 'a;b|c&d>e<f'", "cat \"a;b&&c||d\"", "cat \"#x\"", "cat '#x'",
  "cat a,b @a %a +a a:b a.b a-b a_b A9", "cat --a=b -n -- -x", "  cat   a  ", "cat a  ", "cat\ta", "cat a|cat", "cat a&&cat b", "cat a||cat b", "cat a;cat b", "cat a 2>&1|cat", "cat a 1>&2&&cat b", ">x cat a", "2>x cat a", "cat >x a",
];

/** mulberry32: a deterministic corpus. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}
const pick = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];
const TOKENS = ["cat", "git", "status", "a", "b", "12", "0", "1", "2", "x=y", "=x", "-n", "--a=b", "'a b'", "''", '""', '"c d"', `"it's"`, `'say "hi"'`, "'a;b|c&d>e'", '"a;b&&c"', '"#x"', "'#'", "x,y", "@a", "%a", "+a", "a:b", "^a", "!a", '"!a"', "a*", "[a]", "a]", "~a", "a~", "#a", "a#b", "a==b", "if", "then", "time"];
const OPS = [";", "|", "&&", "||", "&", ">", ">>", "2>", "2>>", "1>", "&>", "&>>", "2>&1", "1>&2", ">&2", "<", "|&", ";;", ">|"];
const generated: string[] = [];
{
  const r = rng(Number(process.env.SB_DIFF_SEED ?? 47)); // other seeds: SB_DIFF_SEED=n
  for (let n = 0; n < 6000; n++) {
    let s = "";
    for (let k = 1 + Math.floor(r() * 6); k > 0; k--) s += (r() < 0.3 ? pick(r, OPS) : pick(r, TOKENS)) + pick(r, [" ", " ", " ", "", "  "]);
    generated.push(s);
  }
  // Mostly grammatical: accepted strings with every word form, operator and redirection.
  const words = ["cat", "rg", "-n", "--a=b", "a", "src/x.ts", "12", "0", "'a b'", "''", '""', '"c d"', `"it's"`, `'say "hi"'`, "'a;b|c&d>e<f'", '"a;b&&c||d"', '"#x"', "'#!^~'", "x,y", "@a", "%a", "+a", "a:b", "a=b", "a*", "x[a]", "-", "--", "'if'", "'x=1'"];
  const ops = [";", "|", "&&", "||", ">", ">>", "1>", "1>>", "2>", "2>>", "2>&1", "1>&2"];
  for (let n = 0; n < 10000; n++) {
    let s = pick(r, ["cat", "rg", "git", "'cat'", '"cat"']);
    for (let k = Math.floor(r() * 6); k > 0; k--) {
      const op = r() < 0.3 ? pick(r, ops) : null;
      s += pick(r, [" ", " ", "  ", ""]) + (op ?? pick(r, words));
      if (op && !op.includes("&1") && !op.includes("&2")) s += pick(r, [" ", ""]) + (op.includes(">") ? pick(r, words) : pick(r, ["cat", "git", "rg"]));
    }
    generated.push(s + pick(r, ["", " "]));
  }
  const alphabet = "ab12 '\"=;|&><*[]-^!#~:,.@%+".split("");
  for (let n = 0; n < 30000; n++) {
    let s = "";
    for (let k = 1 + Math.floor(r() * 10); k > 0; k--) s += pick(r, alphabet);
    generated.push(s);
  }
}
const corpus = [...new Set([...fromTests, ...handWritten, ...generated])];
const accepted = corpus.map((c) => [c, shellSyntax(c)] as const).filter((e): e is readonly [string, ShellSyntax] => e[1] !== null);

test("the corpus exercises the grammar (common commands are accepted)", () => {
  for (const c of ["git status", "git diff --stat", "rg -n 'foo' src", "bun test", "npm test", "cargo test", "bun test 2>&1 | tail -20", "cat 'src/a b.ts'"]) expect([c, shellSyntax(c) !== null]).toEqual([c, true]);
  expect(accepted.length).toBeGreaterThan(800);
});

test("bash splits every accepted string into the same commands, operators and redirections", () => {
  const ours = accepted.map(([, s]) => canonical(s));
  const bash = run([BASH, "--noprofile", "--norc", "-c"], "parse", accepted.map(([c]) => c));
  const diffs = accepted.map(([c], i) => ({ command: c, ours: ours[i], bash: bash[i] })).filter((d) => d.ours !== d.bash);
  expect(diffs).toEqual([]);
});

function wordDiffs(shell: string[]) {
  const words = accepted.flatMap(([, s]) => s.commands.flatMap((c) => [...c.words, ...c.redirects.flatMap((r) => (r.target ? [r.target] : []))]));
  const unique = [...new Map(words.map((w) => [w.raw, w])).values()];
  const out = run(shell, "words", unique.map((w) => w.raw));
  return unique.map((w, i) => ({ raw: w.raw, ours: [w.text], shell: out[i].split("\x01").slice(0, -1) })).filter((d) => JSON.stringify(d.ours) !== JSON.stringify(d.shell));
}

test("bash removes quotes from every accepted word exactly as we do (one word, same text)", () => {
  expect(wordDiffs([BASH, "--noprofile", "--norc", "-c"])).toEqual([]);
});

test.skipIf(!ZSH)("zsh removes quotes from every accepted word exactly as we do", () => {
  // Same helper: zsh -f reads no rc files; NO_GLOB is set by `set -f`.
  expect(wordDiffs([ZSH!, "-f", "-c"])).toEqual([]);
});

// Meaning that bash's printed form does not show, and constructs that differ only in zsh or sh.
test("grammar refuses assignments, reserved words and zsh/sh-specific syntax", () => {
  for (const c of [
    "x=1 cat a", "FOO=bar git status", ">x A=b cat a", "time cat a", "if cat a", "cat a; then", "coproc cat a", "function cat", "select cat", "repeat 2 cat a", "foreach x",
    // zsh EXTENDED_GLOB: ^x is "every file but x"; MAGIC_EQUAL_SUBST: x==cmd expands =cmd.
    "cat ^a", "cat a^b", "cat --x==ls", "cat a==b",
    // History expansion in double quotes (interactive shells); `&>` backgrounds in POSIX sh.
    'cat "a!b"', "bun test &>out.log", "bun test &>>out.log",
    // A redirection glued to a word: bash and zsh read `12>`/`0>` as file descriptors.
    "cat 12>out", "cat 0>out", "cat a>out", "cat 'a'>out", "bun test>>out.log",
    // Command position: bash parses `a[...]` as an array subscript, across spaces and operators.
    "a[|b]", "a[ x ] cat", "x[1]=y cat",
  ]) expect([c, shellSyntax(c)]).toEqual([c, null]);
  for (const c of ["cat 'x=1'", "cat x=1", "cat a > out", "bun test 2>&1 | tail -20", "bun test >> out.log", "cat 'a^b'", "cat 'a!b'", "git status"]) expect([c, shellSyntax(c) !== null]).toEqual([c, true]);
});
