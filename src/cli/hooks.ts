// Install/uninstall Switchboard's Claude Code hooks into ~/.claude/settings.json.
// Merge, never overwrite: existing hooks are left exactly as they are.
// Our entries are recognised by the hook script path, so install is idempotent.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Events we hook, and why. Codex needs none: the shared daemon reports approvals/input waits. */
export const CLAUDE_EVENTS = ["PermissionRequest", "Notification"] as const;

export interface HookPaths {
  settings: string;
  script: string; // installed copy of scripts/sb-hook.sh
  pretool: string; // installed copy of scripts/sb-pretool.sh (soft-lock)
  permission: string; // installed copy of scripts/sb-permission.sh (decides/holds permission prompts)
  header: string; // "Authorization: Bearer <token>", 0600
}

export function defaultHookPaths(): HookPaths {
  const home = homedir();
  return {
    settings: join(home, ".claude/settings.json"),
    script: join(home, ".local/share/switchboard/bin/sb-hook.sh"),
    pretool: join(home, ".local/share/switchboard/bin/sb-pretool.sh"),
    permission: join(home, ".local/share/switchboard/bin/sb-permission.sh"),
    header: join(process.env.SB_CONFIG_DIR ?? join(home, ".config/switchboard"), "hook-header"),
  };
}

const isOurs = (h: any, script: string) => typeof h?.command === "string" && h.command.includes(script);

/** Seconds Claude waits for the permission hook: above the daemon's hold window (default 10 min). */
const PERMISSION_HOOK_TIMEOUT = 900;

/** Pure: returns new settings with our hooks added (idempotent). */
export function mergeClaudeHooks(settings: any, script: string, pretool?: string, permission?: string): any {
  const out = structuredClone(settings ?? {});
  out.hooks ??= {};
  for (const ev of CLAUDE_EVENTS) {
    if (ev === "PermissionRequest" && permission) {
      // The blocking hook replaces our old fire-and-forget entry for this event.
      const groups: any[] = (out.hooks[ev] ??= []);
      // Drop only groups that held nothing but our old entry; the user's groups stay as they are.
      out.hooks[ev] = groups.flatMap((g) => {
        const all = g.hooks ?? [];
        const kept = all.filter((h: any) => !isOurs(h, script));
        return kept.length === all.length ? [g] : kept.length ? [{ ...g, hooks: kept }] : [];
      });
      if (!out.hooks[ev].some((g: any) => (g.hooks ?? []).some((h: any) => isOurs(h, permission))))
        out.hooks[ev].push({ hooks: [{ type: "command", command: permission, timeout: PERMISSION_HOOK_TIMEOUT }] });
      continue;
    }
    const groups: any[] = (out.hooks[ev] ??= []);
    const present = groups.some((g) => (g.hooks ?? []).some((h: any) => isOurs(h, script)));
    if (!present) groups.push({ hooks: [{ type: "command", command: `${script} claude ${ev}`, timeout: 2 }] });
  }
  if (pretool) {
    const groups: any[] = (out.hooks.PreToolUse ??= []);
    if (!groups.some((g) => (g.hooks ?? []).some((h: any) => isOurs(h, pretool))))
      groups.push({ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: pretool, timeout: 1 }] });
  }
  return out;
}

/** Pure: removes only our hooks; drops groups/events that become empty because of us. */
export function removeClaudeHooks(settings: any, script: string, pretool?: string, permission?: string): any {
  let out = removeOne(settings, script);
  if (pretool) out = removeOne(out, pretool);
  if (permission) out = removeOne(out, permission);
  return out;
}

function removeOne(settings: any, script: string): any {
  const out = structuredClone(settings ?? {});
  if (!out.hooks) return out;
  for (const ev of Object.keys(out.hooks)) {
    const groups: any[] = out.hooks[ev];
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => {
        const before = (g.hooks ?? []).length;
        const hooks = (g.hooks ?? []).filter((h: any) => !isOurs(h, script));
        return { g: { ...g, hooks }, removedAll: before > 0 && hooks.length === 0 };
      })
      .filter((x) => !x.removedAll)
      .map((x) => x.g);
    if (kept.length) out.hooks[ev] = kept;
    else delete out.hooks[ev];
  }
  return out;
}

export function hooksInstalled(settings: any, script: string, permission?: string): Record<string, boolean> {
  const r: Record<string, boolean> = {};
  for (const ev of CLAUDE_EVENTS) {
    const want = ev === "PermissionRequest" && permission ? permission : script;
    r[ev] = (settings?.hooks?.[ev] ?? []).some((g: any) => (g.hooks ?? []).some((h: any) => isOurs(h, want)));
  }
  return r;
}

function backup(file: string): string | null {
  if (!existsSync(file)) return null;
  const b = `${file}.switchboard-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(file, b);
  return b;
}

function writeJsonAtomic(file: string, v: unknown) {
  const tmp = `${file}.tmp-${process.pid}`;
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", { mode });
  renameSync(tmp, file);
}

export function installHooks(repoScript: string, token: string, p = defaultHookPaths()) {
  mkdirSync(dirname(p.script), { recursive: true });
  copyFileSync(repoScript, p.script);
  chmodSync(p.script, 0o755);
  copyFileSync(join(dirname(repoScript), "sb-pretool.sh"), p.pretool);
  chmodSync(p.pretool, 0o755);
  copyFileSync(join(dirname(repoScript), "sb-permission.sh"), p.permission);
  chmodSync(p.permission, 0o755);
  mkdirSync(dirname(p.header), { recursive: true, mode: 0o700 });
  writeFileSync(p.header, `Authorization: Bearer ${token}\n`, { mode: 0o600 });
  chmodSync(p.header, 0o600);
  const before = existsSync(p.settings) ? JSON.parse(readFileSync(p.settings, "utf8")) : {};
  const after = mergeClaudeHooks(before, p.script, p.pretool, p.permission);
  if (JSON.stringify(before) === JSON.stringify(after)) return { changed: false, backup: null };
  const b = backup(p.settings);
  writeJsonAtomic(p.settings, after);
  return { changed: true, backup: b };
}

export function uninstallHooks(p = defaultHookPaths()) {
  if (!existsSync(p.settings)) return { changed: false, backup: null };
  const before = JSON.parse(readFileSync(p.settings, "utf8"));
  const after = removeClaudeHooks(before, p.script, p.pretool, p.permission);
  if (JSON.stringify(before) === JSON.stringify(after)) return { changed: false, backup: null };
  const b = backup(p.settings);
  writeJsonAtomic(p.settings, after);
  return { changed: true, backup: b };
}
