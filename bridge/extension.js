// Switchboard Bridge: reports this window's terminals to the local Switchboard daemon and
// performs the few terminal actions it asks for (send text, show, create).
//
// Transport: newline-delimited JSON over the unix socket
// ~/.local/share/switchboard/bridge.sock. Before connecting, the extension checks that the
// directory is owned by this user and not accessible to anyone else (mode 0700), so only this
// user's daemon can be on the other end. No port, no token, nothing configurable per workspace.
// Silent when the daemon is down: no popups, never blocks VS Code.
"use strict";
const vscode = require("vscode");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.SB_DATA_DIR || path.join(os.homedir(), ".local", "share", "switchboard");
const SOCK = path.join(DATA_DIR, "bridge.sock");

let sock = null;
let stopped = false;
let backoff = 1000;
let reportTimer = null;
let buf = "";
const ids = new WeakMap(); // Terminal -> stable id within this window
const byId = new Map(); // id -> Terminal
const windowId = crypto.randomUUID();
let seq = 0;

function idOf(t) {
  let id = ids.get(t);
  if (!id) {
    id = `${windowId.slice(0, 8)}-${++seq}`;
    ids.set(t, id);
  }
  byId.set(id, t);
  return id;
}

/** Only connect to a socket inside a directory that this user owns exclusively. */
function trustedSocket() {
  try {
    const d = fs.statSync(DATA_DIR);
    const s = fs.lstatSync(SOCK);
    const uid = process.getuid();
    return d.isDirectory() && d.uid === uid && (d.mode & 0o077) === 0 && s.isSocket() && s.uid === uid;
  } catch {
    return false;
  }
}

function send(msg) {
  if (sock && !sock.destroyed) sock.write(JSON.stringify(msg) + "\n");
}

async function terminalsSnapshot() {
  const out = [];
  for (const t of vscode.window.terminals) {
    let pid = null;
    try {
      pid = (await t.processId) ?? null;
    } catch {}
    out.push({ id: idOf(t), name: t.name, processId: pid });
  }
  return out;
}

function scheduleReport() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(async () => send({ type: "terminals", terminals: await terminalsSnapshot() }), 250);
}

async function handle(msg) {
  const reply = (ok, data, error) => send({ type: "result", reqId: msg.reqId, ok, data, error });
  try {
    if (msg.type === "sendText") {
      const t = byId.get(msg.terminalId);
      if (!t || !vscode.window.terminals.includes(t)) return reply(false, null, "terminal is gone");
      // The daemon verifies the terminal's foreground process before every send.
      t.sendText(String(msg.text), false);
      return reply(true);
    }
    if (msg.type === "show") {
      const t = byId.get(msg.terminalId);
      if (!t) return reply(false, null, "terminal is gone");
      t.show(false);
      return reply(true);
    }
    if (msg.type === "create") {
      const t = vscode.window.createTerminal({ name: String(msg.name), cwd: String(msg.cwd) });
      t.show(false);
      if (msg.command) t.sendText(String(msg.command), true);
      const pid = await t.processId;
      scheduleReport();
      return reply(true, { terminalId: idOf(t), processId: pid ?? null });
    }
    if (msg.type === "ping") return reply(true);
    reply(false, null, `unknown request ${msg.type}`);
  } catch (e) {
    reply(false, null, String((e && e.message) || e));
  }
}

function connect() {
  if (stopped || (sock && !sock.destroyed)) return;
  if (!trustedSocket()) return retry();
  sock = net.createConnection(SOCK);
  buf = "";
  sock.setEncoding("utf8");
  sock.on("connect", async () => {
    backoff = 1000;
    send({
      type: "hello",
      windowId,
      extensionHostPid: process.pid,
      workspaceFolders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
      vscodeVersion: vscode.version,
    });
    send({ type: "terminals", terminals: await terminalsSnapshot() });
  });
  sock.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      void handle(m);
    }
  });
  sock.on("close", () => {
    sock = null;
    retry();
  });
  sock.on("error", () => {});
}

let retryTimer = null;
function retry() {
  if (stopped) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30000);
}

/** Reconnect as soon as the daemon (re)creates its socket, instead of waiting out the backoff. */
function watchSocket(context) {
  try {
    const w = fs.watch(DATA_DIR, (_ev, name) => {
      if (name === "bridge.sock" && !sock && trustedSocket()) {
        backoff = 1000;
        clearTimeout(retryTimer);
        connect();
      }
    });
    context.subscriptions.push({ dispose: () => w.close() });
  } catch {}
}

function activate(context) {
  watchSocket(context);
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(scheduleReport),
    vscode.window.onDidCloseTerminal((t) => {
      const id = ids.get(t);
      if (id) byId.delete(id);
      scheduleReport();
    }),
    vscode.window.onDidChangeTerminalState(scheduleReport),
    vscode.window.onDidChangeActiveTerminal(scheduleReport),
  );
  connect();
}

function deactivate() {
  stopped = true;
  if (sock) sock.destroy();
}

module.exports = { activate, deactivate };
