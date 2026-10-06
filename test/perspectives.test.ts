import { describe, expect, test } from "bun:test";
import { normPrompt, similarity, synthesisPrompt } from "../src/daemon/perspectives.ts";

describe("perspectives", () => {
  test("detection similarity", () => {
    expect(similarity("Build a local app called Coordinator", "  build a local  app called coordinator ")).toBe(1);
    expect(similarity("<pasted_content id=\"a\">\nSame long prompt here\n</pasted_content>", "Same long prompt here")).toBe(1);
    expect(similarity("Refactor the auth module to use sessions", "Write a poem about the sea")).toBeLessThan(0.2);
    expect(normPrompt("A\n\nB")).toBe("a b");
  });
  test("synthesis prompt labels answers as data", () => {
    const p = synthesisPrompt({
      prompt: "How?",
      members: [
        { label: "Claude · opus", answer: "Do X" },
        { label: "Codex", answer: "Do Y" },
        { label: "Gemini", answer: null },
      ],
    } as any);
    expect(p).toContain('<answer from="Claude · opus">\nDo X');
    expect(p).toContain('<answer from="Codex">\nDo Y');
    expect(p).not.toContain("Gemini");
    expect(p).toContain("## Merged final deliverable");
  });
});

describe("background perspective groups", () => {
  test("only members of coordinator-started groups are background agents", async () => {
    const { Store } = await import("../src/daemon/db.ts");
    const { Perspectives } = await import("../src/daemon/perspectives.ts");
    const store = new Store("", ":memory:");
    const dirty: string[] = [];
    const registry: any = { sessions: new Map(), markDirty: (id: string) => dirty.push(id) };
    const p = new Perspectives(store, registry, {} as any, {} as any, () => {}, () => {});
    let n = 0;
    p.launchAndSend = async () => `s${++n}`;
    const mine = await p.create("q", [], "/x", [{ kind: "new", provider: "claude" }, { kind: "new", provider: "codex" }], { autoSynthesize: true, background: true });
    const users = await p.create("q2", [], "/x", [{ kind: "new", provider: "claude" }]);
    expect(mine.background).toBe(true);
    expect(users.background).toBeUndefined();
    expect(p.isBackground("s1")).toBe(true);
    expect(p.isBackground("s2")).toBe(true);
    expect(p.isBackground("s3")).toBe(false); // the user's own Ask several
    expect(p.isBackground("nobody")).toBe(false);
    expect(dirty).toEqual(["s1", "s2"]);
    store.db.close();
  });
});
