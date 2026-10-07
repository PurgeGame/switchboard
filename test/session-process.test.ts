import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findTranscriptProcess, sessionProcessError } from "../src/daemon/session-process.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(provider: "claude" | "codex") {
  const sandbox = join(import.meta.dir, "../.sandbox");
  mkdirSync(sandbox, { recursive: true });
  const dir = mkdtempSync(join(sandbox, "session-proc-"));
  dirs.push(dir);
  const root = join(dir, "proc"), cwd = join(dir, "worktree");
  const transcriptPath = join(dir, provider === "codex" ? "rollout-2026-10-07-conversation.jsonl" : "conversation.jsonl");
  mkdirSync(root); mkdirSync(cwd); writeFileSync(transcriptPath, "");
  const s = { provider, cwd, transcriptPath };
  const stat = (pid: number, startTime = 123) => {
    const fields = Array(22).fill("0");
    fields[0] = "S"; fields[19] = String(startTime);
    writeFileSync(join(root, String(pid), "stat"), `${pid} (${provider}) ${fields.join(" ")}`);
  };
  const add = (pid: number, args = [`/usr/bin/${provider}`], folder = cwd, file = transcriptPath) => {
    const base = join(root, String(pid));
    mkdirSync(join(base, "fd"), { recursive: true });
    stat(pid);
    writeFileSync(join(base, "cmdline"), args.join("\0") + "\0");
    symlinkSync(folder, join(base, "cwd"));
    symlinkSync(file, join(base, "fd/5"));
  };
  return { root, cwd, transcriptPath, s, add, stat };
}

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: exactly one transcript owner resolves, duplicate descriptors count once`, () => {
    const x = fixture(provider);
    x.add(101);
    symlinkSync(x.transcriptPath, join(x.root, "101/fd/6"));
    x.add(102, ["/usr/bin/editor"]); // readers of the file are not agent processes
    x.add(103, [`/usr/bin/${provider}`], x.cwd, x.transcriptPath + ".other");
    expect(findTranscriptProcess(x.s, x.root)).toEqual({ process: { pid: 101, startTime: 123 } });
  });

  test(`${provider}: no match reports a reason; a matching filename alone is insufficient`, () => {
    const x = fixture(provider);
    x.add(101, [`/usr/bin/${provider}`], x.cwd, x.transcriptPath + ".other");
    expect(findTranscriptProcess(x.s, x.root)).toEqual({ error: `No ${provider} process in this folder has this session's transcript open; nothing was ended.` });
  });

  test(`${provider}: two matching processes refuse to choose either`, () => {
    const x = fixture(provider);
    x.add(101); x.add(102);
    expect(findTranscriptProcess(x.s, x.root)).toEqual({ error: `More than one ${provider} process has this session's transcript open; nothing was ended.` });
  });

  test(`${provider}: PID reused by an unrelated process is rejected before acting`, () => {
    const x = fixture(provider);
    x.add(101);
    const found = findTranscriptProcess(x.s, x.root);
    expect(found.process).toBeDefined();
    x.stat(101, 456);
    writeFileSync(join(x.root, "101/cmdline"), "/usr/bin/bash\0");
    expect(sessionProcessError(x.s, found.process!, x.root)).toContain("process has changed");
    expect(findTranscriptProcess(x.s, x.root).error).toContain("No " + provider + " process");
  });

  test(`${provider}: exec into another program or changing cwd invalidates a captured process`, () => {
    const x = fixture(provider);
    x.add(101);
    const identity = findTranscriptProcess(x.s, x.root).process!;
    writeFileSync(join(x.root, "101/cmdline"), `/usr/bin/bash\0-c\0${provider}\0`);
    expect(sessionProcessError(x.s, identity, x.root)).toContain("not the session's agent");
    writeFileSync(join(x.root, "101/cmdline"), `/usr/bin/${provider}\0`);
    rmSync(join(x.root, "101/cwd"));
    symlinkSync(x.root, join(x.root, "101/cwd"));
    expect(sessionProcessError(x.s, identity, x.root)).toContain("folder no longer matches");
    expect(findTranscriptProcess(x.s, x.root).error).toContain("No " + provider + " process");
  });
}

test("a shared Codex app-server holding the rollout is never a TUI target", () => {
  const x = fixture("codex");
  x.add(101, ["/usr/bin/codex", "app-server", "--managed-daemon"]);
  expect(findTranscriptProcess(x.s, x.root).error).toContain("No codex process");
  x.add(102);
  expect(findTranscriptProcess(x.s, x.root).process?.pid).toBe(102);
});
