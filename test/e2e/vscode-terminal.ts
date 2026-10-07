// Launch only an isolated VS Code test instance. Never reload the user's host.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
const root = process.cwd();
mkdirSync(join(root, ".sandbox"), { recursive: true });
const dir = mkdtempSync(join(root, ".sandbox/vs-"));
for (const child of ["data", "profile/User", "extensions", "workspace"]) mkdirSync(join(dir, child), { recursive: true, mode: 0o700 });
writeFileSync(join(dir, "profile/User/settings.json"), JSON.stringify({ "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false, "security.workspace.trust.enabled": false, "terminal.integrated.enablePersistentSessions": false, "terminal.integrated.shellIntegration.enabled": false, "workbench.startupEditor": "none" }));
// Keep the Unix socket address below Linux's 108-byte limit, inside this worktree.
const data = `/proc/${process.pid}/cwd/${relative(root, dir)}/data`;
const env: Record<string, string | undefined> = { ...process.env, SB_DATA_DIR: data, SB_VSCODE_TEST_DIR: dir, SB_VSCODE_TEST_ROOT: root };
delete env.VSCODE_IPC_HOOK_CLI;
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.env.SB_VSCODE_EXECUTABLE ?? join(dirname(realpathSync(Bun.which("code")!)), "../code");
const proc = Bun.spawn([executable, "--new-window", "--user-data-dir=" + join(dir, "profile"), "--extensions-dir=" + join(dir, "extensions"), "--extensionDevelopmentPath=" + join(root, "bridge"), "--extensionTestsPath=" + join(root, "test/e2e/vscode-terminal.cjs"), "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust", "--disable-gpu", join(dir, "workspace")], { env, stdout: "inherit", stderr: "inherit" });
console.log(`Isolated VS Code PID ${proc.pid}; artifacts ${dir}`);
const timer = setTimeout(() => { console.error("Isolated VS Code test timed out"); proc.kill(); }, 120_000);
const result = await proc.exited;
clearTimeout(timer);
if (result === 0) {
  const report = JSON.parse(readFileSync(join(dir, "actual-host-results.json"), "utf8"));
  if (report.checks.length !== 9) throw Error("Incomplete actual extension-host coverage");
}
process.exit(result);
