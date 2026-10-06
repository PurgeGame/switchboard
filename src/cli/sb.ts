#!/usr/bin/env bun
// sb: Switchboard CLI.
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CodexDaemonClient } from "../daemon/adapters/codex-daemon.ts";
import { configuredPort, loadConfig, loadToken, paths } from "../daemon/config.ts";
import { defaultHookPaths, hooksInstalled, installHooks, uninstallHooks } from "./hooks.ts";
import { EXTERNAL_INSTRUCTIONS, runMcpProxy } from "../daemon/coordinator/mcp-server.ts";

// `sb mcp`: your own agent as the coordinator (coordinator.agent "external"). stdout is the MCP
// channel, so this runs before anything else could print, and holds only the coordinator token.
if (process.argv[2] === "mcp") {
  await runMcpProxy({ port: configuredPort(), configDir: paths.configDir, instructions: EXTERNAL_INSTRUCTIONS });
  process.exit(0);
}

const cfg = loadConfig();
const base = `http://127.0.0.1:${cfg.port}`;
const repoScript = join(import.meta.dir, "../../scripts/sb-hook.sh");

async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${loadToken()}`, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

const [cmd = "help", ...args] = process.argv.slice(2);

switch (cmd) {
  case "open": {
    const { url } = await api("/api/login-code", { method: "POST" });
    const sessionId = args.find((arg) => !arg.startsWith("--"));
    const loginUrl = sessionId ? `${url}#/s/${encodeURIComponent(sessionId)}` : url;
    const opened = spawnSync("xdg-open", [loginUrl], { stdio: "ignore" });
    if (opened.error || opened.status !== 0) {
      console.log("Could not open a browser here. Use `sb login` to print a one-time login link.");
    } else {
      console.log(`Opened Switchboard (${base}).`);
    }
    break;
  }
  case "login": {
    // For SSH, forward this host's loopback port, then open the link in the local browser.
    // The link is single-use and valid for 60 seconds.
    const { url } = await api("/api/login-code", { method: "POST" });
    console.log(url);
    break;
  }
  case "phone": {
    // A phone (or any device) on your tailnet: `tailscale serve` gives this machine a private HTTPS
    // name that forwards to the loopback daemon; scan the code to log that device in.
    const serving = spawnSync("tailscale", ["serve", "status", "--json"], { encoding: "utf8", timeout: 5000 });
    if (serving.error) {
      console.log("Tailscale isn't installed here. Install it on this machine and your phone, sign both in, then run `sb phone` again.");
      process.exit(1);
    }
    if (!serving.stdout.includes(`127.0.0.1:${cfg.port}`)) {
      console.log("Setting up `tailscale serve` (once)…");
      const serve = () => spawnSync("tailscale", ["serve", "--bg", "--https=443", `http://127.0.0.1:${cfg.port}`], { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"], timeout: 120_000 });
      let r = serve();
      // Tailscale lets only root or its "operator" change serve: make this user the operator (asks for your password once).
      if (r.status !== 0 && /access denied/i.test(`${r.stdout}${r.stderr}`)) {
        console.log("Tailscale needs your password once to let your account manage it.");
        const user = process.env.USER ?? spawnSync("whoami", { encoding: "utf8" }).stdout.trim();
        if (spawnSync("sudo", ["tailscale", "set", `--operator=${user}`], { stdio: "inherit" }).status === 0) r = serve();
      }
      if (r.status !== 0) {
        console.log(`${r.stdout}${r.stderr}`.trim());
        console.log("Couldn't set up `tailscale serve`; see above.");
        process.exit(1);
      }
    }
    const { remoteUrl } = await api("/api/login-code", { method: "POST" });
    if (!remoteUrl) {
      console.log("The daemon doesn't know this machine's tailnet name. Restart it (it looks it up at start), then run `sb phone` again.");
      process.exit(1);
    }
    const qr = (await import("qrcode-terminal")).default;
    qr.generate(remoteUrl, { small: true }, (code: string) => console.log(code));
    console.log(`Scan with your phone's camera within 60 seconds (Tailscale must be on on the phone):\n${remoteUrl}`);
    console.log(`After that, open https://${new URL(remoteUrl).host} on the phone. Logins last 12 hours.`);
    break;
  }
  case "rotate-token": {
    // New root token for the CLI, hooks and the daemon. Old copies (e.g. a cookie the pre-upgrade
    // daemon set, which held the root token itself) stop working once the daemon restarts.
    const tokFile = join(paths.configDir, "token");
    // Browser sessions minted with the old token (by you or by whoever copied it) must end too.
    // Ask the running daemon first (it also closes their sockets), then revoke in the database
    // directly in case the daemon is down.
    let viaDaemon = false;
    try {
      await api("/api/auth/revoke-all", { method: "POST" });
      viaDaemon = true;
    } catch {}
    const dbFile = join(paths.dataDir, "switchboard.db");
    if (existsSync(dbFile)) {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbFile);
      try {
        const has = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_sessions'").get();
        if (has) db.query("UPDATE auth_sessions SET revoked = 1 WHERE revoked = 0").run();
      } finally {
        db.close();
      }
    }
    console.log(`Signed out every browser${viaDaemon ? "" : " (daemon not reachable: revoked in the database)"}.`);
    writeFileSync(tokFile, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    chmodSync(tokFile, 0o600);
    const hp = defaultHookPaths();
    if (existsSync(hp.header)) {
      writeFileSync(hp.header, `Authorization: Bearer ${loadToken()}\n`, { mode: 0o600 });
      chmodSync(hp.header, 0o600);
    }
    console.log("Rotated the root token" + (existsSync(hp.header) ? " and the hooks' copy." : "."));
    console.log("Restart the daemon now (scripts/dev-restart.sh). Until then it still accepts the old token and hooks get refused.");
    console.log("On restart it sees the new token and revokes every browser session from before, including any minted in the meantime. Then sign in again with `sb open`.");
    break;
  }
  case "signout": {
    // Ends every browser session (the root token is unaffected).
    const { revoked } = await api("/api/auth/revoke-all", { method: "POST" });
    console.log(`Signed out ${revoked} browser session(s). Run \`sb open\` to sign in again.`);
    break;
  }
  case "status": {
    const [sessions, attention] = await Promise.all([api("/api/sessions"), api("/api/attention")]);
    const live = sessions.filter((s: any) => s.execution !== "ended");
    for (const s of live) console.log(`${s.execution.padEnd(16)} ${s.provider.padEnd(6)} ${(s.name ?? s.goal ?? s.id).slice(0, 40).padEnd(40)} ${s.cwd ?? ""}`);
    console.log(`\n${attention.length} open attention item(s)`);
    for (const a of attention) console.log(`  [${a.kind}] ${a.title}: ${(a.text ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
    break;
  }
  case "hooks": {
    const p = defaultHookPaths();
    if (args[0] === "install") {
      const r = installHooks(repoScript, loadToken(), p);
      console.log(r.changed ? `Installed Claude hooks into ${p.settings}\nBackup: ${r.backup}` : "Claude hooks already installed.");
      console.log("Running Claude sessions pick up settings changes without a restart (verified for project settings).");
    } else if (args[0] === "uninstall") {
      const r = uninstallHooks(p);
      console.log(r.changed ? `Removed Switchboard hooks from ${p.settings}\nBackup: ${r.backup}` : "No Switchboard hooks found.");
    } else {
      const s = existsSync(p.settings) ? JSON.parse(readFileSync(p.settings, "utf8")) : {};
      console.log(JSON.stringify({ settings: p.settings, script: existsSync(p.script) ? p.script : "(not installed)", hooks: hooksInstalled(s, p.script, p.permission) }, null, 2));
    }
    break;
  }
  case "doctor": {
    // null = optional and not set up: shown with a dash, doesn't fail the run.
    const checks: [string, boolean | null, string][] = [];
    const ok = (name: string, pass: boolean | null, detail = "") => checks.push([name, pass, detail]);
    try {
      const h = await fetch(`${base}/api/health`).then((r) => r.json());
      ok("daemon reachable", !!h.ok, base);
      // Version: the daemon records the checkout commit at start; compare with the checkout now.
      const head = spawnSync("git", ["-C", join(import.meta.dir, "../.."), "rev-parse", "HEAD"], { encoding: "utf8" });
      const cur = head.status === 0 ? head.stdout.trim() : null;
      if (!cur) ok("daemon matches checkout", null, "not a git checkout: version check skipped");
      else ok("daemon matches checkout", !!cur && h.commit === cur, h.commit && cur ? `daemon ${String(h.commit).slice(0, 8)}, checkout ${cur.slice(0, 8)}${h.commit === cur ? "" : " (restart the daemon: scripts/dev-restart.sh)"}` : "commit unknown (not a git checkout, or a daemon started before version reporting: restart it)");
    } catch {
      ok("daemon reachable", false, `${base} (start it: bun run daemon)`);
    }
    const tokFile = join(paths.configDir, "token");
    ok("token is 0600", existsSync(tokFile) && (statSync(tokFile).mode & 0o077) === 0, tokFile);
    ok("data dir is 0700", existsSync(paths.dataDir) && (statSync(paths.dataDir).mode & 0o077) === 0, paths.dataDir);
    const hp = defaultHookPaths();
    const settings = existsSync(hp.settings) ? JSON.parse(readFileSync(hp.settings, "utf8")) : {};
    const inst = hooksInstalled(settings, hp.script, hp.permission);
    const anyHooks = Object.values(inst).some(Boolean);
    if (!anyHooks) ok("claude hooks", null, "not installed (optional; permission prompts won't reach the UI): sb hooks install");
    else {
      ok("claude hooks installed", Object.values(inst).every(Boolean), JSON.stringify(inst));
      ok("hook script executable", existsSync(hp.script) && (statSync(hp.script).mode & 0o111) !== 0, hp.script);
      ok("hook header is 0600", existsSync(hp.header) && (statSync(hp.header).mode & 0o077) === 0, hp.header);
    }
    const preTool = (settings?.hooks?.PreToolUse ?? []).some((g: any) => (g.hooks ?? []).some((h: any) => typeof h?.command === "string" && h.command.includes(hp.pretool)));
    if (anyHooks) ok("soft-lock pretool hook", preTool && existsSync(hp.pretool) && (statSync(hp.pretool).mode & 0o111) !== 0, hp.pretool);
    const bsock = join(paths.dataDir, "bridge.sock");
    if (existsSync(bsock)) {
      const bm = statSync(bsock).mode & 0o777;
      const dm = statSync(paths.dataDir).mode & 0o777;
      ok("bridge socket 0600 in a 0700 dir", bm === 0o600 && dm === 0o700, `${bsock} ${bm.toString(8)}, dir ${dm.toString(8)}`);
    } else ok("bridge socket 0600 in a 0700 dir", false, `${bsock} missing (daemon not running?)`);
    const ext = spawnSync("code", ["--list-extensions"], { encoding: "utf8", timeout: 15000 });
    if (ext.status !== 0) ok("VS Code bridge", null, "`code` not on PATH (optional; needed to message Claude sessions in VS Code terminals)");
    else if (!ext.stdout.includes("switchboard-local.switchboard-bridge")) ok("VS Code bridge", null, "not installed (optional): scripts/bridge.sh install, then reload VS Code");
    else ok("bridge extension installed", true, "code --list-extensions");
    const hasCodex = spawnSync("which", ["codex"]).status === 0;
    if (hasCodex) ok("codex daemon socket", existsSync(paths.codexControlSock), existsSync(paths.codexControlSock) ? paths.codexControlSock : `${paths.codexControlSock} missing (start a Codex TUI, which starts its shared daemon)`);
    if (existsSync(paths.codexControlSock)) {
      // Read-only: thread/loaded/list lists the threads; it changes nothing.
      const cd = new CodexDaemonClient(paths.codexControlSock);
      try {
        const up = await cd.ensure();
        const r = up ? await Promise.race([cd.call<{ data: string[] }>("thread/loaded/list", {}), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000))]) : null;
        ok("codex daemon reachable", !!r, r ? `${r.data.length} loaded thread(s)` : "handshake failed");
      } catch (e) {
        ok("codex daemon reachable", false, String((e as Error).message));
      } finally {
        cd.close();
      }
    }
    const bp = spawnSync("bash", ["-ic", "bind -v 2>/dev/null | grep -q 'enable-bracketed-paste on'"], { timeout: 3000 });
    ok("bash bracketed paste on", bp.status === 0, "guards terminal injection");
    const hasClaude = spawnSync("which", ["claude"]).status === 0;
    ok("claude or codex on PATH", hasClaude || hasCodex, [hasClaude && "claude", hasCodex && "codex"].filter(Boolean).join(", ") || "install Claude Code and/or Codex");
    if (spawnSync("which", ["notify-send"]).status !== 0) ok("notify-send", null, "not found (optional; desktop notifications are off by default)");
    for (const [name, pass, detail] of checks) console.log(`${pass === null ? "–" : pass ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
    // Only real failures fail the run; a dash is an optional piece that isn't set up.
    process.exit(checks.every((c) => c[1] !== false) ? 0 : 1);
  }
  default:
  console.log(`sb: Switchboard CLI

  sb open                  open the UI (logs the browser in)
  sb login                 print a one-time login link for an SSH-forwarded browser
  sb phone                 log a phone in over Tailscale (shows a QR code)
  sb rotate-token          new root token (then restart the daemon); retires any leaked copy
  sb signout               sign every browser out (sessions otherwise last 12 hours)
  sb status                live sessions and open attention items
  sb hooks install|uninstall|status
  sb doctor                health checks
  sb mcp                   MCP server (stdio) for your own agent as the coordinator
                           (config coordinator.agent "external"; see docs/COORDINATOR.md)`);
}
