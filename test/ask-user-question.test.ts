// Claude's AskUserQuestion reaches Switchboard through the PermissionRequest hook. It's a question
// for the user, never judged: the card shows one button per option plus a box for their own words,
// and the answer goes back to the session as the hook's updatedInput (the shape Claude Code 2.1.292
// admits: the fields its card showed, unchanged, plus `answers` keyed by question text). The last
// test drives the real hook and answer routes over HTTP. Fake judge, in-memory store, no session.
import { afterEach, expect, test } from "bun:test";
import { AttentionEngine } from "../src/daemon/attention.ts";
import { Store } from "../src/daemon/db.ts";
import { startHttp } from "../src/daemon/http.ts";
import { askedQuestions, PermissionBroker, questionAnswerReply, type PermissionInfo } from "../src/daemon/permissions.ts";
import { blankSession } from "../src/daemon/state.ts";
import type { AttentionItem, Session } from "../src/shared/types.ts";
import { answersFrom, answersOnTap, pick, questionsOf } from "../src/web/src/questions.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});

const QUESTIONS = [
  {
    question: "Which database should the cache use?",
    header: "Cache",
    options: [
      { label: "Redis", description: "Fast, already deployed" },
      { label: "SQLite", description: "No new service" },
    ],
    multiSelect: false,
  },
  {
    question: "Which checks should run before merging?",
    header: "Checks",
    options: [{ label: "Unit tests" }, { label: "Type check" }, { label: "Lint" }],
    multiSelect: true,
  },
];
const input = { questions: QUESTIONS, metadata: { source: "plan" } };
const ask = (i: Record<string, unknown> = input): PermissionInfo => ({ sessionId: "claude:s1", provider: "claude", tool: "AskUserQuestion", input: i, summary: "q", cwd: "/home/u/app" });

function broker() {
  const calls = { judged: 0, raised: [] as { key: string; questions: unknown }[], settled: [] as [string, string][] };
  const b = new PermissionBroker({
    holdMs: () => 60_000,
    mayJudge: () => true,
    roots: () => ["/home/u/app"],
    judge: async () => (calls.judged++, { decision: "allow", reason: "looks fine" }),
    raise: (_i, key, _rec, questions) => calls.raised.push({ key, questions }),
    settle: (key, how) => calls.settled.push([key, how]),
    logAuto: () => {},
  });
  return { b, calls };
}

test("askedQuestions reads the card's questions; anything malformed isn't a question", () => {
  expect(askedQuestions(input)!.map((q) => [q.question, q.options.length, q.multiSelect])).toEqual([
    ["Which database should the cache use?", 2, false],
    ["Which checks should run before merging?", 3, true],
  ]);
  for (const bad of [{}, { questions: [] }, { questions: "x" }, { questions: [{ options: [] }] }, { questions: [QUESTIONS[0], QUESTIONS[0]] }, { questions: Array(5).fill(QUESTIONS[0]) }])
    expect(askedQuestions(bad as any)).toBeNull();
});

test("the hook's answer carries the shown fields unchanged plus one answer per question", () => {
  const reply: any = questionAnswerReply({ ...input, title: "Before I build it" }, { [QUESTIONS[0].question]: "Redis", [QUESTIONS[1].question]: "Unit tests, Lint" });
  expect(reply).toEqual({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedInput: {
          title: "Before I build it",
          questions: QUESTIONS,
          metadata: { source: "plan" },
          answers: { [QUESTIONS[0].question]: "Redis", [QUESTIONS[1].question]: "Unit tests, Lint" },
        },
      },
    },
  });
  // Nothing the card didn't show is echoed back (an empty title isn't shown either).
  expect(Object.keys((questionAnswerReply({ questions: [QUESTIONS[0]], title: "", extra: 1 } as any, { [QUESTIONS[0].question]: "SQLite" }) as any).hookSpecificOutput.decision.updatedInput)).toEqual(["questions", "answers"]);
  expect(() => questionAnswerReply(input, { [QUESTIONS[0].question]: "Redis" })).toThrow(/answer every question/);
  expect(() => questionAnswerReply(input, { "Something else?": "x", [QUESTIONS[0].question]: "Redis", [QUESTIONS[1].question]: "Lint" })).toThrow(/no such question/);
  expect(() => questionAnswerReply(input, { [QUESTIONS[0].question]: "  ", [QUESTIONS[1].question]: "Lint" })).toThrow(/needs some text/);
  expect(() => questionAnswerReply(input, ["Redis"])).toThrow(/map each question/);
});

test("a question is never judged: it's held for the user, and only answers (or a decline) settle it", async () => {
  const { b, calls } = broker();
  const pending = b.claudeHook(ask());
  await Bun.sleep(0);
  expect(calls.judged).toBe(0); // the judge would have allowed it: it never sees questions
  expect(calls.raised).toHaveLength(1);
  expect(calls.raised[0].questions).toEqual(askedQuestions(input));
  const key = calls.raised[0].key;
  expect(b.answer(key, "accept")).toBe(false); // a bare "yes" isn't an answer
  expect(() => b.answerQuestions(key, { [QUESTIONS[0].question]: "Redis" })).toThrow(/answer every question/);
  expect(b.isPending(key)).toBe(true);
  expect(b.answerQuestions(key, { [QUESTIONS[0].question]: "SQLite", [QUESTIONS[1].question]: "Type check" })).toBe(true);
  const out: any = await pending;
  expect(out.hookSpecificOutput.decision.updatedInput.answers).toEqual({ [QUESTIONS[0].question]: "SQLite", [QUESTIONS[1].question]: "Type check" });
  expect(calls.settled[0][1]).toBe("answered in Switchboard");
  // Declining tells the session the user didn't answer here.
  const again = b.claudeHook(ask());
  await Bun.sleep(0);
  expect(b.answer(calls.raised[1].key, "decline")).toBe(true);
  expect(((await again) as any).hookSpecificOutput.decision.behavior).toBe("deny");
  // Answers can't be forced onto an ordinary permission prompt.
  const bash = b.claudeHook({ ...ask(), tool: "Bash", input: { command: "git push" } });
  await Bun.sleep(0);
  expect(b.answerQuestions(calls.raised[2].key, {})).toBe(false);
  b.answer(calls.raised[2].key, "decline");
  await bash;
});

test("the card: questions from the item, one tap for a single choice, picks or your own words otherwise", () => {
  const item = { id: 1, kind: "approval", status: "open", meta: { answerKey: "claude-hook:x", questions: QUESTIONS } } as unknown as AttentionItem;
  const qs = questionsOf(item)!;
  expect(qs.map((q) => q.options.map((o) => o.label))).toEqual([["Redis", "SQLite"], ["Unit tests", "Type check", "Lint"]]);
  expect(questionsOf({ ...item, meta: { answerKey: "claude-hook:x" } } as any)).toBeNull(); // an ordinary prompt: Allow/Deny
  expect(questionsOf({ ...item, meta: { questions: QUESTIONS } } as any)).toBeNull(); // nothing to answer it through
  expect(answersOnTap(qs)).toBe(false);
  expect(answersOnTap([qs[0]])).toBe(true);
  expect(pick(qs[0], ["Redis"], "SQLite")).toEqual(["SQLite"]);
  expect(pick(qs[1], ["Lint"], "Unit tests")).toEqual(["Lint", "Unit tests"]);
  expect(pick(qs[1], ["Lint", "Unit tests"], "Lint")).toEqual(["Unit tests"]);
  expect(answersFrom(qs, { [qs[0].question]: ["Redis"] }, {})).toBeNull(); // the second isn't answered yet
  expect(answersFrom(qs, { [qs[0].question]: ["Redis"], [qs[1].question]: ["Unit tests", "Lint"] }, {})).toEqual({ [qs[0].question]: "Redis", [qs[1].question]: "Unit tests, Lint" });
  // Your own words win over a pick.
  expect(answersFrom(qs, { [qs[0].question]: ["Redis"], [qs[1].question]: ["Lint"] }, { [qs[0].question]: "  Postgres, we already run it " })![qs[0].question]).toBe("Postgres, we already run it");
});

test("end to end over HTTP: the hook holds the question, the card's answer goes back to the session", async () => {
  const store = new Store("", ":memory:");
  cleanup.push(() => store.db.close());
  const session: Session = { ...blankSession("claude:s1", "claude", "tui", "s1"), cwd: "/home/u/app", name: "app", execution: "working" };
  const sessions = new Map([[session.id, session]]);
  const registry: any = { sessions, onPush() {}, list: () => [...sessions.values()], update: (id: string, fn: (s: Session) => void) => (fn(sessions.get(id)!), true) };
  const attention = new AttentionEngine(store, {} as any, { pushItem() {}, notify() {}, setExecution() {} });
  const permissions = new PermissionBroker({
    holdMs: () => 60_000,
    mayJudge: () => true,
    roots: () => ["/home/u/app"],
    judge: async () => ({ decision: "allow", reason: "never asked" }),
    // As main.ts wires it.
    raise: (info, answerKey, recommendation, questions) =>
      attention.raisePermission(sessions.get(info.sessionId)!, { tool: info.tool, summary: info.summary, answerKey, recommendation, ...(questions ? { questions } : {}) }),
    settle: (key, how) => attention.settlePermission(key, how),
    logAuto: () => {},
  });
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const token = "q".repeat(64);
  const { server } = startHttp({ port, token, coordinatorToken: "c".repeat(64), registry, store, attention, permissions, webDist: "/nonexistent", system: () => null, perspectives: { list: () => [] } } as any);
  cleanup.push(() => server.stop(true));
  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/api/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  // The session's hook asks (sb-permission.sh posts this and waits).
  const hook = post("hook/claude/PermissionRequest?wait=1", { session_id: "s1", tool_name: "AskUserQuestion", tool_input: input, cwd: "/home/u/app" });
  let card: AttentionItem | undefined;
  for (let i = 0; i < 100 && !card; i++) {
    await Bun.sleep(10);
    card = attention.open("claude:s1").find((it) => it.kind === "approval" && Array.isArray(it.meta.questions));
  }
  expect(card).toBeDefined();
  expect(card!.title).toBe("Asks you a question");
  expect(card!.text).toBe(`${QUESTIONS[0].question}\n${QUESTIONS[1].question}`);
  expect(questionsOf(card!)).toHaveLength(2);
  // An incomplete answer is refused and the question stays held.
  expect((await post(`attention/${card!.id}/answer`, { decision: "accept", answers: { [QUESTIONS[0].question]: "Redis" } })).status).toBe(400);
  const ok = await post(`attention/${card!.id}/answer`, { decision: "accept", answers: { [QUESTIONS[0].question]: "Redis", [QUESTIONS[1].question]: "Unit tests, Type check" } });
  expect(ok.status).toBe(200);
  const reply: any = await (await hook).json();
  expect(reply.hookSpecificOutput.decision).toEqual({
    behavior: "allow",
    updatedInput: { questions: QUESTIONS, metadata: { source: "plan" }, answers: { [QUESTIONS[0].question]: "Redis", [QUESTIONS[1].question]: "Unit tests, Type check" } },
  });
  expect(attention.open("claude:s1").filter((it) => it.kind === "approval")).toHaveLength(0); // the card is settled
});
