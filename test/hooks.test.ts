import { describe, expect, test } from "bun:test";
import { hooksInstalled, mergeClaudeHooks, removeClaudeHooks } from "../src/cli/hooks.ts";
import { classifyTurnEnd } from "../src/daemon/classify.ts";

const SCRIPT = "/home/u/.local/share/switchboard/bin/sb-hook.sh";
const existing = {
  permissions: { allow: ["Bash(*)"] },
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "node other-hook.js", timeout: 10 }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash guard.sh" }] }],
  },
};

describe("claude hook merge", () => {
  test("adds ours, keeps theirs, is idempotent", () => {
    const once = mergeClaudeHooks(existing, SCRIPT);
    const twice = mergeClaudeHooks(once, SCRIPT);
    expect(twice).toEqual(once);
    expect(once.hooks.Stop).toEqual(existing.hooks.Stop);
    expect(once.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    expect(once.permissions).toEqual(existing.permissions);
    expect(hooksInstalled(once, SCRIPT)).toEqual({ PermissionRequest: true, Notification: true });
  });

  test("uninstall restores the original exactly", () => {
    expect(removeClaudeHooks(mergeClaudeHooks(existing, SCRIPT), SCRIPT)).toEqual(existing);
  });

  test("uninstall never removes other hooks sharing an event", () => {
    const mixed = mergeClaudeHooks({ hooks: { Notification: [{ hooks: [{ type: "command", command: "notify-me" }] }] } }, SCRIPT);
    const back = removeClaudeHooks(mixed, SCRIPT);
    expect(back.hooks.Notification).toEqual([{ hooks: [{ type: "command", command: "notify-me" }] }]);
    expect(back.hooks.PermissionRequest).toBeUndefined();
  });
});

describe("turn-end classifier", () => {
  test("questions", () => {
    expect(classifyTurnEnd("I fixed the parser.\n\nShould I also update the tests?").question).toBe("yes");
    expect(classifyTurnEnd("Two options:\n1. Rewrite the module\n2. Patch the call site\n\nWhich do you prefer?").realChoice).toBe(true);
    expect(classifyTurnEnd("Done. All 21 tests pass.").question).toBe("no");
  });

  test("continuation asks are separated from real choices", () => {
    const c = classifyTurnEnd("Phase 1 is complete and committed.\n\nShall I proceed with Phase 2?");
    expect(c.question).toBe("yes");
    expect(c.continuationAsk).toBe(true);
    expect(c.realChoice).toBe(false);
    const r = classifyTurnEnd("Should I use Postgres or SQLite for this?");
    expect(r.continuationAsk).toBe(false);
    expect(r.realChoice).toBe(true);
  });

  test("outcomes", () => {
    expect(classifyTurnEnd("Implemented the feature; all tests pass.").outcome).toBe("success");
    expect(classifyTurnEnd("3 tests are still failing in auth.spec.ts.").outcome).toBe("failure");
    expect(classifyTurnEnd("Did the schema. Remaining: the API layer and the UI.").outcome).toBe("incomplete");
    expect(classifyTurnEnd("You've hit your usage limit · resets 9pm").outcome).toBe("limit");
    expect(classifyTurnEnd("Build finished with no errors.").outcome).not.toBe("failure");
  });

  test("the blocking permission hook replaces our old PermissionRequest entry, keeps the user's, and uninstalls cleanly", () => {
    const PERM = "/home/u/.local/share/switchboard/bin/sb-permission.sh";
    const old = mergeClaudeHooks(existing, SCRIPT); // what earlier installs wrote
    const userHook = { type: "command", command: "/home/u/my-own-permission-logger.sh" };
    old.hooks.PermissionRequest.push({ hooks: [userHook] });
    const upgraded = mergeClaudeHooks(old, SCRIPT, undefined, PERM);
    const cmds = upgraded.hooks.PermissionRequest.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(cmds).toContain(PERM);
    expect(cmds).toContain(userHook.command);
    expect(cmds.some((c: string) => c.includes(SCRIPT))).toBe(false);
    const perm = upgraded.hooks.PermissionRequest.flatMap((g: any) => g.hooks).find((h: any) => h.command === PERM);
    expect(perm.timeout).toBeGreaterThan(600);
    expect(mergeClaudeHooks(upgraded, SCRIPT, undefined, PERM)).toEqual(upgraded);
    expect(hooksInstalled(upgraded, SCRIPT, PERM)).toEqual({ PermissionRequest: true, Notification: true });
    const removed = removeClaudeHooks(upgraded, SCRIPT, undefined, PERM);
    expect(removed.hooks.PermissionRequest.flatMap((g: any) => g.hooks.map((h: any) => h.command))).toEqual([userHook.command]);
  });
});
