// Execute the actual packaged extension against an isolated VS Code API adapter.
// No socket, VS Code window, shell, or live daemon is used.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

function rig() {
  const terminals: any[] = [];
  const created: any[] = [];
  const replies: any[] = [];
  let disposals = 0;
  const terminal = (options: any = {}) => ({
    name: options.name ?? "user shell", creationOptions: options, processId: Promise.resolve(123),
    show: () => {}, sendText: () => { throw new Error("managed launch must not inject a command into a shell"); },
    dispose: () => { disposals++; },
  });
  const vscode = { window: { terminals, createTerminal: (options: any) => {
    const t = terminal(options); terminals.push(t); created.push(t); return t;
  } } };
  const module = { exports: {} as any };
  runInNewContext(readFileSync(new URL("../bridge/extension.js", import.meta.url), "utf8") + `
    sock = { destroyed: false, write: (raw) => receive(JSON.parse(raw)) };
    module.exports.test = { handle, terminalsSnapshot };
  `, {
    module, require: (name: string) => name === "vscode" ? vscode : require(name),
    process: { platform: "linux", env: {}, getuid: () => 1000 },
    receive: (m: any) => replies.push(m), setTimeout: () => 1, clearTimeout: () => {},
  });
  const { handle, terminalsSnapshot } = module.exports.test;
  return { terminals, created, terminal, replies, handle, terminalsSnapshot, disposals: () => disposals };
}

const request = (launchId = crypto.randomUUID()) => ({ type: "createManaged", reqId: "r", launchId, cwd: "/work", name: "same name", runtime: "/usr/bin/python3", runner: "/switchboard/managed-terminal.py", command: "claude --resume 'conversation'" });

test("actual extension uses dedicated process options, stable launch IDs and normal persistence", async () => {
  const x = rig(), r = request();
  await x.handle(r);
  expect(x.created).toHaveLength(1);
  expect(x.created[0].creationOptions).toEqual({
    name: r.name, cwd: r.cwd, shellPath: r.runtime, shellArgs: [r.runner, r.launchId, r.command],
    env: { SWITCHBOARD_TERMINAL_ID: r.launchId }, isTransient: false,
  });
  expect(x.replies[0]).toMatchObject({ ok: true, data: { terminalId: `managed-${r.launchId}`, launchId: r.launchId } });
  x.created[0].name = "arbitrary user title";
  expect((await x.terminalsSnapshot())[0]).toMatchObject({ id: `managed-${r.launchId}`, launchId: r.launchId });
  await x.handle(r); // same request attaches; no second process or command injection
  expect(x.created).toHaveLength(1);
  expect(x.disposals()).toBe(0);
});

test("user shells and legacy Switchboard shells are never closed/reused, even with identical titles", async () => {
  const x = rig();
  x.terminals.push(x.terminal({ name: "same name" }), x.terminal({ name: "sb-task-deep" }));
  for (let i = 0; i < 5; i++) {
    await x.handle(request());
    expect(x.terminals).toHaveLength(3);
    // Simulate VS Code's Process exit disposal, only for this dedicated launch.
    x.terminals.pop();
  }
  expect(x.terminals).toHaveLength(2);
  expect(x.disposals()).toBe(0);
  expect((await x.terminalsSnapshot()).every((t: any) => !t.launchId)).toBe(true);
});

test("ambiguous ownership, changed command and exited terminal never attach to a different launch", async () => {
  const x = rig(), r = request();
  await x.handle(r);
  x.terminals.push(x.terminal(x.created[0].creationOptions));
  await x.handle(r);
  expect(x.replies.at(-1)).toMatchObject({ ok: false, error: "ambiguous managed terminal ownership" });
  x.terminals.pop();
  await x.handle({ ...r, command: "codex" });
  expect(x.replies.at(-1).ok).toBe(false);
  x.created[0].exitStatus = { code: 0 };
  await x.handle(r);
  expect(x.replies.at(-1).ok).toBe(false);
  expect(x.created).toHaveLength(1);
  expect(x.disposals()).toBe(0);
});

test("there is no broad dispose API for a daemon to close an arbitrary terminal", async () => {
  const x = rig();
  x.terminals.push(x.terminal());
  const id = (await x.terminalsSnapshot())[0].id;
  await x.handle({ type: "dispose", terminalId: id, reqId: "r" });
  expect(x.replies.at(-1).ok).toBe(false);
  expect(x.disposals()).toBe(0);
});
