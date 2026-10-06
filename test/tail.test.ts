import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTail } from "../src/daemon/tail.ts";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "sb-tail-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function collect(path: string, opts = {}) {
  const got: any[] = [];
  const offsets: Record<string, { ino: number; offset: number }> = {};
  const t = new JsonlTail(path, (o) => got.push(o), {
    pollMs: 1_000_000, // drive polls manually
    getOffset: (p) => offsets[p] ?? null,
    setOffset: (p, ino, offset) => (offsets[p] = { ino, offset }),
    ...opts,
  });
  return { t, got, offsets };
}

describe("JsonlTail", () => {
  test("partial lines are held until complete", () => {
    const f = join(dir, "a.jsonl");
    writeFileSync(f, '{"a":1}\n{"b":');
    const { t, got } = collect(f);
    t.start();
    expect(got).toEqual([{ a: 1 }]);
    appendFileSync(f, '2}\n');
    t.poll();
    expect(got).toEqual([{ a: 1 }, { b: 2 }]);
    t.stop();
  });

  test("multi-byte characters split across a write boundary survive", () => {
    const f = join(dir, "u.jsonl");
    const line = Buffer.from('{"t":"héllo — ✓"}\n');
    const cut = line.indexOf(0xe2) + 1; // split inside the em dash
    writeFileSync(f, line.subarray(0, cut));
    const { t, got } = collect(f);
    t.start();
    appendFileSync(f, line.subarray(cut));
    t.poll();
    expect(got).toEqual([{ t: "héllo — ✓" }]);
    t.stop();
  });

  test("truncation restarts from zero; corrupt lines are skipped", () => {
    const f = join(dir, "t.jsonl");
    writeFileSync(f, '{"n":1}\nnot json\n{"n":2}\n');
    const { t, got } = collect(f);
    t.start();
    expect(got).toEqual([{ n: 1 }, { n: 2 }]);
    writeFileSync(f, '{"n":3}\n');
    t.poll();
    expect(got.at(-1)).toEqual({ n: 3 });
    t.stop();
  });

  test("resumes from the persisted offset (no replay after restart)", () => {
    const f = join(dir, "r.jsonl");
    writeFileSync(f, '{"n":1}\n{"n":2}\n');
    const first = collect(f);
    first.t.start();
    first.t.stop();
    appendFileSync(f, '{"n":3}\n');
    const got: any[] = [];
    const t2 = new JsonlTail(f, (o) => got.push(o), { pollMs: 1_000_000, getOffset: (p) => first.offsets[p] ?? null });
    t2.start();
    expect(got).toEqual([{ n: 3 }]);
    t2.stop();
  });

  test("history cap reads only the tail, aligned to a line", () => {
    const f = join(dir, "h.jsonl");
    writeFileSync(f, Array.from({ length: 100 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n");
    const { t, got } = collect(f, { initialMaxBytes: 50 });
    t.start();
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(10);
    expect(got.at(-1)).toEqual({ i: 99 });
    t.stop();
  });
});
