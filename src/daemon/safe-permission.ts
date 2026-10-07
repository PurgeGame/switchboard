// Deterministic allowlist. No filesystem, environment, clock, shell or model access here.
import { posix as path } from "node:path";
import { verificationPlan } from "./verification-command.ts";
import type { PermissionInfo } from "./permissions.ts";

export type SafeVerdict = { decision: "allow"; rule: string; reason: string } | { decision: "ask"; reason: string };
export interface PathFact {
  real: string;
  kind: "file" | "directory" | "missing";
  /** All descendants were checked, without following symlinks or reading file contents. */
  treeSafe?: boolean;
}
export interface SafetyFacts {
  root: string | null;
  paths: Readonly<Record<string, PathFact | undefined>>;
  /** Adapter checked Git's repository/config for helpers, alternate stores and partial clones. */
  gitSafe?: boolean;
  package?: { path: string; scripts: Readonly<Record<string, string>> };
  globs?: Readonly<Record<string, readonly string[] | undefined>>;
  /** For existing files a `>` redirection would truncate: tracked by Git (missing = unknown). */
  tracked?: Readonly<Record<string, boolean | undefined>>;
}
export interface ReadPlan { rule: string; paths: string[]; recursive: boolean; git?: boolean; verification?: boolean; script?: string;
  /** Files or directories an option makes the command write, replace or empty (verification). */
  writes?: string[];
  /** Argument words not checked as an input path verbatim: shell globbing in them asks. */
  opaque?: string[] }
/** truncating: the outputs written with `>` (not `>>`), which replace an existing file's contents. */
export interface PermissionPlan { commands: ReadPlan[]; outputs: string[]; truncating: string[] }
/** Does this plan execute project code (a verification command), as opposed to only reading? */
export const executesProjectCode = (plan: PermissionPlan) => plan.commands.some((c) => c.verification);
/**
 * Files a redirection must never write, inside the worktree too: they configure tools, hooks,
 * CI, dependencies or agent permissions, so writing them becomes code execution or wider access
 * later. Checked on the path relative to the worktree root.
 */
export const protectedOutput = (relativePath: string) => {
  const parts = relativePath.split("/");
  return parts.some((s) => /^(?:\.mcp\.json|\.vscode|\.husky|\.github|\.git|\.claude|\.codex|\.envrc|\.env.*)$/i.test(s))
    || /^(?:package\.json|Makefile|makefile|GNUmakefile|package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum)$/.test(parts.at(-1) ?? "");
};
const ask = (reason: string): SafeVerdict => ({ decision: "ask", reason });
export const insideRoot = (p: string, root: string) => p === root || p.startsWith(`${root}/`);
export const sensitivePath = (p: string) => p.split("/").some((s) =>
  /^(?:\.env(?:[.-].*)?|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.git|\.claude|\.codex|\.config|\.local|\.netrc|\.npmrc|\.pypirc|\.envrc|\.git-credentials|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|tokens?(?:[._-].*)?|keys?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(s)
  || /(?:^|[._-])(?:credentials?|secrets?|tokens?|passwords?|api[_-]?keys?|private[_-]?keys?|access[_-]?keys?|service[_-]?accounts?)(?:[._-]|$)/i.test(s)
  || /^\.env(?:$|[^a-z0-9])/i.test(s)
  || /\.(?:pem|key|p12|pfx|jks|keystore|db|sqlite[23]?)(?:[.-].*)?$/i.test(s));
const ordinaryPath = (p: string) => !!p && p !== "-" && !/[\x00-\x1f\x7f$`~\\*?\[\]{}!:]/.test(p) && !p.split("/").includes("..");

export interface ShellWord { text: string; raw: string; quoted: boolean }
export interface ShellCommand { words: ShellWord[]; redirects: { op: string; target?: ShellWord }[] }
/** operators[i] joins commands[i] and commands[i + 1]. */
export interface ShellSyntax { commands: ShellCommand[]; operators: string[] }

/** Words bash and zsh treat as syntax in command position (bash keywords, zsh reserved words). */
const RESERVED = new Set(["!", "[[", "]]", "{", "}", "case", "coproc", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if", "in", "select", "then", "time", "until", "while", "foreach", "end", "repeat", "nocorrect", "always", "declare", "export", "float", "integer", "local", "readonly", "typeset"]);

/**
 * The accepted shell grammar: a deliberately small subset that bash, zsh and POSIX sh all split
 * the same way, whatever their options (test/parser-differential.test.ts checks it against bash).
 * Anything outside it asks. Only printable ASCII, separated by spaces (no tabs, CR or newlines);
 * no `$`, backticks or backslashes anywhere. A word is exactly one of:
 *  - unquoted, from [A-Za-z0-9 _ @ % + = : , . / - * [ ]] (no `~ ! # ^ ? { } ( ) < >`), not
 *    starting with `=` and without `==` (zsh `=cmd` expansion, also after `=` with
 *    MAGIC_EQUAL_SUBST); `*` and `[...]` are globs and are tracked as such;
 *  - '...' with anything but `'` inside;
 *  - "..." with no `!` (history expansion) and, per the above, no `$`, backtick or backslash.
 * Quoted parts never touch another part (no concatenation). Operators: `;`, `|`, `&&`, `||`;
 * redirections `>`, `>>`, `1>`, `1>>`, `2>`, `2>>` before a target word, and `2>&1`, `1>&2`.
 * A word or redirection must be followed by a space, an operator or the end, so a redirection
 * never touches the word before it (bash reads `12>x` as descriptor 12, zsh as the word `12`).
 * No `&>` (in POSIX sh it is `&` then `>`), background jobs, input redirections or here-docs.
 * In command position an unquoted word is only [A-Za-z0-9 _ . / + -] (no assignment `A=b`, no
 * `a[...]` subscript, no glob) and not a reserved word.
 */
export function shellSyntax(command: string): ShellSyntax | null {
  if (typeof command !== "string" || command.length > 16_384 || /[^\x20-\x7e]|[$`\\]/.test(command)) return null;
  const commands: ShellCommand[] = [{ words: [], redirects: [] }], operators: string[] = [];
  const re = / *(?:'([^']*)'(?=[ ;&|]|$)|"([^"!]*)"(?=[ ;&|]|$)|(2>&1|1>&2)(?=[ ;&|]|$)|([12]?>>?)|(&&|\|\||[;|])|([A-Za-z0-9_@%+=:,./*[\]-]+)(?=[ ;&|]|$))/y;
  let end = 0;
  let pending: { op: string; target?: ShellWord } | null = null;
  while (end < command.trimEnd().length) {
    re.lastIndex = end;
    const m = re.exec(command);
    if (!m) return null;
    end = re.lastIndex;
    const current = commands.at(-1)!;
    if (m[3] || m[4] || m[5]) {
      if (pending) return null;
      if (m[3]) current.redirects.push({ op: m[3] });
      if (m[4]) current.redirects.push(pending = { op: m[4] });
      if (m[5]) {
        if (!current.words.length) return null;
        operators.push(m[5]);
        commands.push({ words: [], redirects: [] });
      }
    } else {
      const word: ShellWord = { text: m[1] ?? m[2] ?? m[6], raw: m[0].trimStart(), quoted: m[6] === undefined };
      if (!word.quoted && (word.text.startsWith("=") || word.text.includes("=="))) return null;
      // Command position: bash reads `a=` as an assignment and `a[` as an array subscript that may
      // span spaces and operators (`a[|b]` is one word); keywords are syntax.
      if (!pending && !current.words.length && !word.quoted && (!/^[A-Za-z0-9_./+-]+$/.test(word.text) || RESERVED.has(word.text))) return null;
      if (pending) { pending.target = word; pending = null; }
      else current.words.push(word);
    }
  }
  return pending || commands.some((c) => !c.words.length) ? null : { commands, operators };
}

function sequence(command: unknown): { commands: string[][]; outputs: string[]; truncating: string[]; piped: boolean[]; globs: Set<string>[] } | null {
  if (Array.isArray(command)) {
    if (!command.length || !command.every((v) => typeof v === "string" && !/[\x00-\x1f\x7f]/.test(v))) return null;
    if (command.length === 3 && /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|sh)$/.test(command[0]) && /^-l?c$/.test(command[1])) return sequence(command[2]);
    return { commands: [command], outputs: [], truncating: [], piped: [false], globs: [new Set()] };
  }
  const syntax = typeof command === "string" ? shellSyntax(command) : null;
  if (!syntax) return null;
  const redirects = syntax.commands.flatMap((c) => c.redirects.filter((r) => r.target));
  return {
    commands: syntax.commands.map((c) => c.words.map((w) => w.text)),
    outputs: redirects.map((r) => r.target!.text),
    truncating: redirects.filter((r) => !r.op.endsWith(">>")).map((r) => r.target!.text),
    piped: syntax.commands.map((_, i) => syntax.operators[i - 1] === "|"),
    // Unquoted `*` and `[...]` glob.
    globs: syntax.commands.map((c) => new Set(c.words.filter((w) => !w.quoted && /[*[\]]/.test(w.text)).map((w) => w.text))),
  };
}

/** Parse the complete call before inspecting any paths or granting any part of a chain. */
export function permissionPlan(info: PermissionInfo): PermissionPlan | null {
  const i = info.input;
  if (!i || typeof i !== "object" || Array.isArray(i)) return null;
  const shell = (info.provider === "claude" && info.tool === "Bash") || (info.provider === "codex" && info.tool === "command");
  if (!shell) {
    if (info.provider !== "claude" || info.tool !== "Read" || Object.keys(i).some((k) => !["file_path", "offset", "limit", "pages"].includes(k))) return null;
    return typeof i.file_path === "string" ? { commands: [{ rule: "read-file", paths: [i.file_path], recursive: false }], outputs: [], truncating: [] } : null;
  }
  // No environment, alternate shell, extra commands, writable roots or permission amendments.
  if (Object.keys(i).some((k) => !["command", "description", "timeout", "timeout_ms", "max_output_tokens", "yield_time_ms", "workdir", "cwd"].includes(k))) return null;
  const parsed = sequence(i.command);
  if (!parsed) return null;
  // A shell glob expands into any number of words: only verification path operands, whose every
  // match is checked, may contain one. A pattern or option value never may. Nor may a word that
  // starts with the wildcard (a match like `--reporter-outfile=x` would become an option) or uses
  // `**` (recursive with bash globstar).
  const commands = parsed.commands.map((argv, index) => {
    const globs = parsed.globs[index], verification = verificationPlan(argv);
    if (verification) return [...globs].every((w) => !verification.opaque?.includes(w) && verification.paths.includes(w) && !/^[*[\]]/.test(w) && !w.includes("**")) ? verification : null;
    return globs.size ? null : readPlan(argv, parsed.piped[index]);
  });
  if (commands.some((c) => !c)) return null;
  return { commands: commands as ReadPlan[], outputs: parsed.outputs, truncating: parsed.truncating };
}

/** The original read-only command allowlist. */
function readPlan(argv: string[], piped: boolean): ReadPlan | null {
  const [prog, ...args] = argv;
  if (prog === "git") {
    const [sub, ...opts] = args;
    if (!["status", "log", "diff"].includes(sub)) return null;
    const paths: string[] = [];
    let after = false;
    for (const a of opts) {
      if (a === "--" && !after) { after = true; continue; }
      if (after) { paths.push(a); continue; }
      const common = /^(?:--no-pager|--no-ext-diff|--no-textconv)$/;
      const ok = sub === "status" ? /^(?:--short|-s|--branch|-b|--porcelain(?:=v[12])?)$/
        : sub === "log" ? /^(?:--oneline|--stat|--name-only|--name-status|--all|--graph|--decorate|--no-decorate|-[1-9][0-9]*|--max-count=[1-9][0-9]*)$/
        : /^(?:--stat|--numstat|--shortstat|--name-only|--name-status|--check|--cached|--staged)$/;
      if (!common.test(a) && !ok.test(a)) return null;
    }
    return { rule: `git-${sub}-local`, paths: paths.length ? paths : ["."], recursive: true, git: true };
  }
  const flags: Record<string, RegExp> = {
    cat: /^-[benstuvAET]+$|^--(?:number|number-nonblank|squeeze-blank|show-all|show-ends|show-tabs|show-nonprinting)$/,
    ls: /^-[alhdtSr1]+$|^--(?:all|almost-all|human-readable|directory)$/,
    wc: /^-[clmwL]+$/, head: /^-[1-9][0-9]*$/, tail: /^-[1-9][0-9]*$/,
    rg: /^-[nilswFvcoxqUH]+$|^--(?:files|hidden|no-ignore|no-ignore-vcs|no-heading|line-number|files-with-matches|fixed-strings|ignore-case|count|no-config)$/,
    grep: /^-[nilswFEvcoxqrRHI]+$|^--(?:recursive|line-number|files-with-matches|fixed-strings|ignore-case|count)$/,
  };
  if (prog === "pwd") return args.length ? null : { rule: "working-directory", paths: ["."], recursive: false };
  if (!flags[prog]) return null;
  // With -e/--regexp anywhere (options are permuted), every operand is a file, including one
  // written before it; --files likewise makes every rg operand a path.
  let pattern = prog !== "rg" && prog !== "grep" || (prog === "rg" && args.includes("--files")) || args.some((a) => a === "-e" || a === "--regexp");
  let end = false;
  const paths: string[] = [];
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    if (!end && a === "--") { end = true; continue; }
    if (!end && a.startsWith("-")) {
      if (["-n", "-c"].includes(a) && (prog === "head" || prog === "tail")) {
        if (!/^[1-9][0-9]*$/.test(args[++n] ?? "")) return null;
      } else if ((prog === "rg" || prog === "grep") && ["-e", "--regexp"].includes(a)) {
        if (args[++n] === undefined) return null;
        pattern = true;
      } else if (!flags[prog].test(a)) return null;
    } else if (!pattern) pattern = true;
    else paths.push(a);
  }
  if (!pattern) return null;
  if (!paths.length) {
    if (piped && ["cat", "head", "tail", "wc", "grep", "rg"].includes(prog)) return { rule: `read-only-stdin-${prog}`, paths: ["."], recursive: false };
    if (!["ls", "rg", "grep"].includes(prog)) return null; // unknown stdin
    paths.push(".");
  }
  return { rule: `read-only-${prog}`, paths, recursive: ["rg", "grep"].includes(prog) };
}

/** Pure: decisions depend only on the exact request and an immutable, fail-closed FS snapshot. */
export function classifySafePermission(info: PermissionInfo, facts: SafetyFacts): SafeVerdict {
  const plan = permissionPlan(info);
  if (!plan) return ask("Command or tool is outside the reviewed read/verification subset");
  const root = facts.root;
  const cwd = info.cwd;
  if (!root || root === "/" || !path.isAbsolute(root) || !cwd || !path.isAbsolute(cwd) || !ordinaryPath(cwd)) return ask("Unknown worktree or working directory");
  for (const override of [info.input.cwd, info.input.workdir]) if (override !== undefined && override !== cwd) return ask("Conflicting working directories");
  const cwdFact = facts.paths[cwd];
  if (!insideRoot(cwd, root) || !cwdFact || cwdFact.kind !== "directory" || !insideRoot(cwdFact.real, root)) return ask("Working directory is outside the worker's worktree or unresolved");
  const checkPath = (p: string, recursive = false, verification = false): boolean => {
    if (verification && p.includes("*")) {
      if (!ordinaryPath(p.replaceAll("*", "x"))) return false;
      const matches = facts.globs?.[path.resolve(cwd, p)];
      return !!matches?.length && matches.every((m) => !m.includes("*") && checkPath(m, false, true));
    }
    if (!ordinaryPath(p)) return false;
    const absolute = path.resolve(cwd, p), f = facts.paths[absolute];
    return insideRoot(absolute, root) && !!f && insideRoot(f.real, root)
      && !sensitivePath(absolute) && !sensitivePath(f.real)
      && (verification || f.kind !== "missing")
      && (!recursive || f.kind !== "directory" || f.treeSafe === true);
  };
  for (const command of plan.commands) {
    if (command.git && facts.gitSafe !== true) return ask("Git configuration or repository can run helpers or access other stores");
    if (command.script) {
      const pkg = facts.package;
      if (!pkg || !checkPath(pkg.path) || facts.paths[pkg.path]?.kind !== "file" || !Object.hasOwn(pkg.scripts, command.script) || typeof pkg.scripts[command.script] !== "string" || !pkg.scripts[command.script].trim()) return ask("Verification script is not defined in the repository's package.json");
      // The runner starts the script in the package's directory, so its relative path and output
      // arguments resolve there, not in the cwd they were checked from.
      if (path.dirname(pkg.path) !== cwd && (command.paths.some((p) => p !== ".") || command.writes?.length))
        return ask("Package script arguments would resolve in the package's directory, not the working directory they were checked in");
    }
    if (!command.paths.every((p) => checkPath(p, command.recursive, command.verification))) return ask("Path is outside the worker's worktree, sensitive, unresolved or unsafe to read recursively");
    // Output options (`--outDir`, `-o`, `--junitxml`, `--target-dir`...) write, replace or empty
    // their target: like a `>`, only a new or untracked one, never configuration or dependencies.
    for (const p of command.writes ?? []) {
      if (p.includes("*") || !checkPath(p, false, true)) return ask("Output option is outside the worktree, sensitive or unresolved");
      const absolute = path.resolve(cwd, p), real = facts.paths[absolute]?.real ?? absolute;
      if ([absolute, real].some((a) => a === root || protectedOutput(path.relative(root, a)) || path.relative(root, a).split("/").some((s) => /^(?:node_modules|\.venv|venv)$/.test(s))))
        return ask("Output option would write the worktree root, a tool, hook, CI, dependency or agent configuration");
      if (facts.paths[absolute]?.kind !== "missing" && facts.tracked?.[absolute] !== false)
        return ask("Output option would replace or empty a file or directory tracked by Git");
    }
  }
  // Missing in-worktree outputs are fine; their nearest existing ancestors were checked for links.
  if (!plan.outputs.every((p) => !p.includes("*") && checkPath(p, false, true))) return ask("Redirection target is outside the worktree, sensitive or unresolved");
  for (const p of plan.outputs) {
    const absolute = path.resolve(cwd, p), real = facts.paths[absolute]?.real ?? absolute;
    if (protectedOutput(path.relative(root, absolute)) || protectedOutput(path.relative(root, real)))
      return ask("Redirection would write a tool, hook, CI, dependency or agent configuration file");
  }
  for (const p of plan.truncating) {
    const absolute = path.resolve(cwd, p);
    if (facts.paths[absolute]?.kind !== "missing" && facts.tracked?.[absolute] !== false)
      return ask("Redirection would overwrite a file tracked by Git");
  }
  const rules = [...new Set(plan.commands.map((c) => c.rule)), ...(plan.outputs.length ? ["worktree-output-redirection"] : [])];
  const rule = rules.join(" + ");
  return { decision: "allow", rule, reason: `${rule}: authorized commands inside the worker's worktree` };
}
