// The user authorizes verification suites to execute arbitrary repository code. This parser
// checks the command's explicit arguments; it does not try to audit suite/script contents.
import type { ReadPlan } from "./safe-permission.ts";

export const verificationScript = (name: string) => /^(?:(?:test|typecheck|build|lint)(?::[\w.-]+)?|e2e[\w:.-]*)$/.test(name);
/**
 * paths: inputs (configs, manifests, test files), checked inside the worktree.
 * outputs: files or directories the tool writes, replaces or empties. Besides the path checks they
 * must be missing or untracked, and never a tool/dependency/agent configuration (safe-permission.ts).
 */
type Options = { flags?: string[]; values?: string[]; paths?: string[]; outputs?: string[]; short?: RegExp; operands?: "paths" | "names" | "none" | "go" | "pytest" };
const COMMON: Options = {
  flags: ["--watch", "--coverage", "--run", "--noEmit", "--pretty", "--fix", "--quiet", "--verbose", "--silent", "--help", "--version", "--ci", "--update", "--update-snapshots", "--runInBand", "--passWithNoTests"],
  values: ["--timeout", "--testTimeout", "--reporter", "--test-name-pattern", "--maxWorkers", "--minWorkers", "--max-warnings", "--mode", "--browser", "--port", "-t"],
  paths: ["--config", "--project"],
  outputs: ["--output", "--output-file", "--outputFile", "--output-dir", "--outDir", "--out-dir", "--outdir", "--outfile", "--coverage-dir", "--coverageDirectory", "--reporter-outfile", "--junitxml", "--junit-xml", "-o"],
  short: /^-[qv]+$/,
};
const RUNNERS: Record<string, Options> = {
  bun: { flags: ["--only", "--todo", "--concurrent", "--randomize"], values: ["--bail", "--rerun-each", "--max-concurrency", "--seed", "--shard"], short: /^-[quv]+$/ },
  cargo: {
    flags: ["--release", "--workspace", "--all", "--all-targets", "--all-features", "--no-default-features", "--locked", "--offline", "--frozen", "--no-run", "--lib", "--bins", "--tests", "--benches", "--examples", "--doc", "--nocapture", "--show-output", "--ignored", "--include-ignored", "--exact", "--all-targets"],
    values: ["-p", "--package", "--features", "--bin", "--test", "--bench", "--example", "--profile", "--target", "--jobs", "-j", "--message-format", "--test-threads", "-D", "-W", "-A"],
    paths: ["--manifest-path"], outputs: ["--target-dir"], operands: "names",
  },
  // Not merged with COMMON: pytest's `-o` is --override-ini (cache_dir, testpaths, addopts...),
  // and --basetemp deletes its directory before the run, so neither is offered.
  pytest: {
    flags: ["--disable-warnings", "--collect-only", "--lf", "--ff", "--failed-first", "--last-failed", "--exitfirst", "--strict-markers", "--strict-config", "--no-header", "--no-summary", "--verbose", "--quiet", "--help", "--version"],
    values: ["-k", "-m", "--maxfail", "--tb", "--capture", "--durations", "--durations-min", "--color", "-n", "--dist", "--cov-report", "--timeout"],
    paths: ["--cov", "-c"], outputs: ["--junitxml", "--junit-xml"], operands: "pytest", short: /^-[qvsx]+$/,
  },
  go: {
    flags: ["-race", "-v", "-short", "-json", "-cover", "-benchmem", "-failfast", "-c", "-x"],
    values: ["-run", "-bench", "-count", "-timeout", "-parallel", "-cpu", "-shuffle", "-vet", "-covermode"],
    outputs: ["-o", "-outputdir", "-coverprofile", "-cpuprofile", "-memprofile", "-blockprofile", "-mutexprofile", "-trace"], operands: "go",
  },
  forge: {
    flags: ["--gas-report", "--via-ir", "--offline", "--force", "--no-cache", "--json", "--summary", "--detailed"],
    values: ["--match-test", "--no-match-test", "--match-contract", "--no-match-contract", "--fuzz-runs", "--fuzz-seed", "--threads", "-j"],
    paths: ["--match-path", "--no-match-path"], outputs: ["--out", "--cache-path"], short: /^-[qv]+$/,
  },
  make: { flags: ["--no-print-directory", "--keep-going", "--silent"], values: ["--jobs", "-j"], short: /^-j[1-9][0-9]*$/, operands: "none" },
};

/**
 * All path-like values are checked even in name/filter options (no hidden output escape).
 * `opaque`: argument words not checked as an input path exactly as written; the caller refuses
 * shell globbing in those (an expanded glob would shift or add arguments).
 */
function argumentsPlan(args: string[], options: Options): { paths: string[]; writes: string[]; opaque: string[] } | null {
  const paths: string[] = [], writes: string[] = [], opaque: string[] = [];
  const value = (v: string, kind: "path" | "output" | "value") => {
    if (!v || v.startsWith("-") || /[$`\\~\x00-\x1f]|(?:^|\/)\.\.(?:\/|$)|^[\w]+:\/\//.test(v)) return false;
    if (kind === "output") writes.push(v);
    else if (kind === "path" || v.includes("/")) paths.push(v);
    return true;
  };
  for (let n = 0; n < args.length; n++) {
    const arg = args[n];
    if (arg === "--") continue;
    if (arg.startsWith("-")) {
      opaque.push(arg);
      const eq = arg.indexOf("=");
      const flag = eq < 0 ? arg : arg.slice(0, eq);
      const kind = options.outputs?.includes(flag) ? "output" : options.paths?.includes(flag) ? "path" : options.values?.includes(flag) ? "value" : null;
      if (kind) {
        const v = eq < 0 ? args[++n] : arg.slice(eq + 1);
        if (typeof v !== "string") return null;
        if (eq < 0) opaque.push(v);
        if (flag === "--cov-report" && v.includes(":")) {
          const [format, ...target] = v.split(":");
          if (!["html", "xml", "json", "lcov", "annotate"].includes(format) || !value(target.join(":"), "output")) return null;
        } else if (!value(v, kind)) return null;
      } else if (eq < 0 && (options.flags?.includes(arg) || options.short?.test(arg))) continue;
      else return null;
    } else {
      // Shell-style and make variable assignments can alter interpreters, cwd or output paths.
      if (arg.includes("=") || options.operands === "none") return null;
      if (options.operands === "go" && arg !== "." && !arg.startsWith("./") && !arg.endsWith(".go")) return null;
      const operand = options.operands === "pytest" ? arg.replace(/::.*$/, "") : options.operands === "go" ? arg.replace(/\/\.\.\.$/, "") || "." : arg;
      if (operand !== arg || options.operands === "names") opaque.push(arg);
      if (!value(operand, options.operands !== "names" ? "path" : "value")) return null;
    }
  }
  // `--` forwards flags but never disables the checks above.
  return { paths, writes, opaque };
}

export function verificationPlan(argv: string[]): ReadPlan | null {
  const [program, ...args] = argv;
  let runner = program, script: string | undefined, offset = 1, initial: string[] = [];
  if (["npm", "pnpm", "yarn", "bun"].includes(program)) {
    if (program === "bun" && args[0] === "test") runner = "bun";
    else if (program === "bun" && /^(?:\.\/)?test\/e2e\/[\w./*-]+\.ts$/.test(args[0] ?? "")) initial = [args[0]];
    else {
      if (["npm", "bun"].includes(program) && args[0] !== "run" && !(program === "npm" && args[0] === "test")) return null;
      script = args[0] === "run" ? args[1] : args[0];
      offset = args[0] === "run" ? 2 : 1;
      if (!script || !verificationScript(script)) return null;
    }
  } else if (program === "cargo" && ["test", "build", "check", "clippy"].includes(args[0])) runner = "cargo";
  else if (program === "go" && ["test", "vet"].includes(args[0])) runner = "go";
  else if (program === "forge" && ["test", "build"].includes(args[0])) runner = "forge";
  else if (program === "make" && args[0] === "test") runner = "make";
  else if (program === "pytest") { runner = "pytest"; offset = 0; }
  else if (["python", "python3"].includes(program) && args[0] === "-m" && args[1] === "pytest") { runner = "pytest"; offset = 2; }
  else return null;
  const specific = RUNNERS[runner] ?? {};
  // Package scripts take conventional check flags; script contents remain the user's choice.
  const options = script || runner === "bun" ? {
    ...COMMON, ...specific,
    flags: [...COMMON.flags!, ...specific.flags ?? []], values: [...COMMON.values!, ...specific.values ?? []],
    paths: [...COMMON.paths!, ...specific.paths ?? []], outputs: [...COMMON.outputs!, ...specific.outputs ?? []],
  } : specific;
  const parsed = argumentsPlan(args.slice(offset), options);
  if (!parsed) return null;
  return { rule: script ? `verification-package-script:${program}:${script}` : `verification-${runner}:${initial.length ? "e2e-file" : runner === "pytest" ? "test" : args[0]}`,
    paths: [".", ...initial, ...parsed.paths], writes: parsed.writes, opaque: parsed.opaque, recursive: false, verification: true, ...(script ? { script } : {}) };
}
