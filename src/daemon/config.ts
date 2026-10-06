import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const HOME = homedir();
// Overridable so the simulator and the e2e tests can point the adapters at fake session trees.
const CLAUDE_HOME = process.env.SB_CLAUDE_HOME ?? join(HOME, ".claude");
const CODEX_HOME = process.env.SB_CODEX_HOME ?? join(HOME, ".codex");

export const paths = {
  home: HOME,
  configDir: process.env.SB_CONFIG_DIR ?? join(HOME, ".config/switchboard"),
  dataDir: process.env.SB_DATA_DIR ?? join(HOME, ".local/share/switchboard"),
  claudeSessions: join(CLAUDE_HOME, "sessions"),
  claudeProjects: join(CLAUDE_HOME, "projects"),
  codexHome: CODEX_HOME,
  codexSessions: join(CODEX_HOME, "sessions"),
  codexIndex: join(CODEX_HOME, "session_index.jsonl"),
  codexControlSock: join(CODEX_HOME, "app-server-control/app-server-control.sock"),
  webDist: join(import.meta.dir, "../../dist/web"),
};

export interface Config {
  /** Minutes a permission prompt waits for you in Switchboard before the terminal asks instead. */
  permissionHoldMinutes?: number;
  port: number;
  /** Turns at least this long that end without a question raise a Finished item. */
  longRunMs: number;
  stalledMs: number;
  /** How long an ended session stays listed. */
  endedRetentionMs: number;
  notifyDesktop: boolean;
  notifyFinished: boolean;
  /** Sessions whose folder contains one of these never raise desktop notifications. */
  notifyIgnore: string[];
  /** Use a cheap Haiku call (your Claude login) for ambiguous turn endings. */
  modelClassifier: boolean;
  autoContinue: { enabled: boolean; graceMs: number; maxConsecutive: number; typingHoldMs: number; offProjects: string[] };
  /** Name other devices reach this daemon by through `tailscale serve`. Unset: this machine's tailnet name; null: loopback only. */
  remoteHost?: string | null;
}

const defaults: Config = {
  port: 7777,
  longRunMs: 5 * 60_000,
  stalledMs: 10 * 60_000,
  endedRetentionMs: 6 * 60 * 60_000,
  notifyDesktop: false, // you want attention in the web UI only (2026-10-06)
  notifyFinished: false, // desktop notifications are for urgent items only
  notifyIgnore: ["/.sandbox/", "/.sandbox"],
  modelClassifier: true,
  autoContinue: { enabled: true, graceMs: 10_000, maxConsecutive: 3, typingHoldMs: 120_000, offProjects: [] },
};

/** Transcripts and tokens live here: owner-only directories and files. */
export function secureDirs() {
  // 0700 directories are the real barrier: other users cannot traverse into them, whatever the
  // file modes. No process-wide umask: sessions the daemon launches would inherit it.
  for (const d of [paths.configDir, paths.dataDir]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
    for (const f of readdirSync(d)) {
      try {
        const p = join(d, f);
        if (statSync(p).isFile()) chmodSync(p, 0o600); // subdirectories (e.g. bin/) keep their modes
      } catch {}
    }
  }
}

export function loadConfig(): Config {
  secureDirs();
  const f = join(paths.configDir, "config.json");
  let user: Partial<Config> = {};
  if (existsSync(f)) user = JSON.parse(readFileSync(f, "utf8"));
  const cfg = { ...defaults, ...user, autoContinue: { ...defaults.autoContinue, ...(user.autoContinue ?? {}) } };
  if (process.env.SB_PORT) cfg.port = Number(process.env.SB_PORT);
  if (cfg.remoteHost === undefined) cfg.remoteHost = tailnetName();
  return cfg;
}

/** The daemon's port without loadConfig's side effects (directory modes, a Tailscale lookup): for `sb mcp`. */
export function configuredPort(): number {
  if (process.env.SB_PORT) return Number(process.env.SB_PORT);
  try {
    const p = JSON.parse(readFileSync(join(paths.configDir, "config.json"), "utf8")).port;
    if (Number.isInteger(p)) return p;
  } catch {}
  return defaults.port;
}

/** This machine's MagicDNS name (e.g. pc.tail1234.ts.net), or null without Tailscale. */
export function tailnetName(): string | null {
  try {
    const r = Bun.spawnSync(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "ignore", timeout: 3000 });
    const name = String(JSON.parse(r.stdout.toString())?.Self?.DNSName ?? "").replace(/\.$/, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(name) ? name.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Random bearer token, stored mode 0600. Created on first run. */
export function loadToken(): string {
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  const f = join(paths.configDir, "token");
  if (!existsSync(f)) {
    writeFileSync(f, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  }
  chmodSync(f, 0o600);
  return readFileSync(f, "utf8").trim();
}

/**
 * The coordinator's own credential, rotated on every daemon start (mode 0600). Its MCP proxy
 * reads it at launch; it only reaches the coordinator tool endpoints.
 */
export function rotateCoordinatorToken(): string {
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  const f = join(paths.configDir, "coordinator-token");
  const t = randomBytes(32).toString("hex");
  writeFileSync(f, t + "\n", { mode: 0o600 });
  chmodSync(f, 0o600);
  return t;
}
