import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CoordinatorAgent, type CoordinatorDeps } from "../src/daemon/coordinator/agent.ts";
import { loadCoordinatorConfig, mergeCoordinatorConfig, runtimeSelection, saveRuntimeSelection, type RuntimeSelection } from "../src/daemon/coordinator/config.ts";
import { ClaudeRuntime, CoordinatorRuntime, PROMPT_FILE, TOOL_PREFIX, type RuntimeLike } from "../src/daemon/coordinator/runtime.ts";
import { CodexRuntime, codexArgs } from "../src/daemon/coordinator/codex-runtime.ts";
import { CODEX_RESTRICTIONS, CODEX_VERSION, codexCost, restrictedCodexCatalog, toml } from "../src/daemon/coordinator/codex-config.ts";
import { TOOL_NAMES } from "../src/daemon/coordinator/tools.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { Store } from "../src/daemon/db.ts";
import { blankSession } from "../src/daemon/state.ts";
import { startHttp } from "../src/daemon/http.ts";
import type { Session } from "../src/shared/types.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
function directory() {
  const sandbox = resolve(import.meta.dir, "../.sandbox");
  mkdirSync(sandbox, { recursive: true });
  const d = mkdtempSync(join(sandbox, "coordinator-codex-test-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
class StubRuntime implements RuntimeLike {
  running = false; busy = false; turns: string[] = [];
  onText = (_: string) => {}; onResult: RuntimeLike["onResult"] = () => {}; onExit = (_: number | null) => {};
  start() { this.running = true; }
  stop() { this.running = this.busy = false; }
  send(t: string) { if (!this.running) return false; this.turns.push(t); return true; }
}
function rig(provider: "claude" | "codex", dir = directory(), dbPath = ":memory:") {
  const store = new Store("", dbPath);
  cleanup.push(() => store.db.close());
  const c = new Coordination(store);
  const sessions = new Map<string, Session>([["worker", { ...blankSession("worker", "claude", "tui", "worker"), cwd: dir, execution: "idle", sendMethods: ["terminal"] }]]);
  const deliveries: string[] = [];
  const cfg = mergeCoordinatorConfig({ provider, limits: { userChatMaxActions: 1, perSessionCooldownMs: 0, perSessionPerHour: 0 } });
  const deps: CoordinatorDeps = { db: store.db, coordination: c, cfg, sessions: () => sessions, events: () => [],
    send: async (_id, text) => (deliveries.push(text), { ok: true }), launch: async () => "worker",
    escalate: () => {}, push: () => {}, timers: false, now: () => Date.parse("2026-10-07T12:00:00Z") };
  const agent = new CoordinatorAgent(deps);
  const rt = new StubRuntime(); agent.setRuntime(rt);
  return { dir, store, c, sessions, agent, deps, rt, deliveries };
}

// Scripted brains speak the real Claude stream-json / Codex app-server protocols, and call the
// REAL stdio MCP proxy -> authenticated HTTP endpoint -> daemon enforcement. No provider call.
const BRAIN = String.raw`
import { createInterface } from "node:readline";
const provider = process.env.TEST_PROVIDER;
const proxy = Bun.spawn([process.execPath, process.env.TEST_PROXY], {env:process.env, stdin:"pipe",stdout:"pipe",stderr:"pipe"});
process.on("exit",()=>proxy.kill());
let n=0, turn=0; const pending=new Map();
(async()=>{ for await(const line of createInterface({input:require("node:stream").Readable.fromWeb(proxy.stdout)})) {
 const m=JSON.parse(line);pending.get(m.id)?.(m.result??m.error);pending.delete(m.id);
}})();
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 require("node:fs").appendFileSync(process.env.TEST_RECORD, JSON.stringify(m)+"\n");
 if(provider==="codex") {
  if(m.method==="initialize") { out({id:m.id,result:{}}); continue; }
  if(m.method==="thread/start") { out({id:m.id,result:{thread:{id:"thread"},model:m.params.model}}); continue; }
  if(m.method!=="turn/start") continue;
  out({id:m.id,result:{turn:{id:String(++turn)}}});
  out({method:"turn/started",params:{threadId:"thread",turn:{id:String(turn)}}});
 }
 const text=provider==="codex"?m.params.input[0].text:m.message.content[0].text;
 let result={ready:true}, command={};
 try { command=JSON.parse(text); if(command.method) result=await rpc(command.method,command.params); } catch {}
 for(const note of command.notes??[]) out(note);
 const value=JSON.stringify(result);
 if(provider==="codex") {
  out({method:"item/completed",params:{threadId:"thread",turnId:String(turn),item:{type:"agentMessage",text:value}}});
  const usage=command.tokens??{inputTokens:0,cachedInputTokens:0,outputTokens:0};
  out({method:"thread/tokenUsage/updated",params:{threadId:"thread",turnId:String(turn),tokenUsage:{total:usage,last:usage}}});
  out({method:"turn/completed",params:{threadId:"thread",turn:{id:String(turn),status:"completed"}}});
 } else {
  out({type:"assistant",message:{content:[{type:"text",text:value}]}});
  out({type:"result",total_cost_usd:0});
 }
}
function out(m) { process.stdout.write(JSON.stringify(m)+"\n"); }
function rpc(method,params) {
 const id=++n;
 return new Promise((resolve)=>{pending.set(id,resolve);proxy.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");proxy.stdin.flush();});
}

`;

async function brain(x: ReturnType<typeof rig>, provider: "claude" | "codex") {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!; probe.stop(true);
  const coordinatorToken = "c".repeat(64), token = "r".repeat(64);
  writeFileSync(join(x.dir, "coordinator-token"), coordinatorToken, { mode: 0o600 });
  const { server } = startHttp({ port, token, coordinatorToken, coordinator: x.agent, store: x.store, coordination: x.c,
    registry: { sessions: x.sessions, onPush() {}, all: () => [...x.sessions.values()] }, webDist: x.dir, system: () => null, coordinatorConfigDir: x.dir } as any);
  cleanup.push(() => server.stop(true));
  const file = join(x.dir, `brain-${provider}.ts`); writeFileSync(file, BRAIN);
  const proc = Bun.spawn([process.execPath, file], { stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, TEST_PROVIDER: provider, TEST_PROXY: resolve(import.meta.dir, "../src/daemon/coordinator/mcp-server.ts"), SB_PORT: String(port), SB_CONFIG_DIR: x.dir, TEST_RECORD: join(x.dir, "protocol.jsonl") } });
  const rt: RuntimeLike = provider === "claude" ? new ClaudeRuntime(() => "opus", TOOL_NAMES, port, () => null, () => proc)
    : new CodexRuntime({ provider, model: "gpt-6-astra", effort: "xhigh" }, TOOL_NAMES, port, () => ({ proc, cwd: x.dir }));
  x.agent.setRuntime(rt); rt.start();
  cleanup.push(async () => { rt.stop(); proc.kill(); await proc.exited; });
  const capture = (send: () => boolean) => new Promise<any>((resolve, reject) => {
    const text = rt.onText, result = rt.onResult, usage = rt.onUsage;
    let output: any;
    const timer = setTimeout(() => reject(new Error(`brain timeout (${provider})`)), 3000);
    rt.onText = (s) => { output = JSON.parse(s); text(s); };
    const finish = () => { rt.onText = text; rt.onResult = result; rt.onUsage = usage; clearTimeout(timer); resolve(output); };
    rt.onResult = (r) => { result(r); finish(); };
    rt.onUsage = (r) => { usage?.(r); if (!rt.running) finish(); };
    if (!send()) { clearTimeout(timer); reject(new Error("send refused")); }
  });
  const request = (method: string, params?: any) => capture(() => rt.send(JSON.stringify({ method, params })));
  await request("initialize", { protocolVersion: "2025-06-18" });
  return { rt, request, capture, port, token, coordinatorToken,
    human: async (text: string, images: string[] = [], pasted = false) => {
      let id: number | undefined;
      await capture(() => { const r = x.agent.userChat(text, images, { pasted }); id = r.id; return r.ok; });
      return id!;
    },
    tool: async (name: string, args: any = {}) => request("tools/call", { name, arguments: args }) };
}

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: durable memory reaches the real runtime wire on the first user turn`, async () => {
    const x = rig(provider), b = await brain(x, provider);
    const lesson = x.agent.rememberLesson({ text: "Keep integration reports concise.", category: "user preference", source: "chat #42", reason: "Explicit preference" }, "user");
    x.agent.setMode("active");
    await b.human("Review the current integration.");
    const messages = readFileSync(join(x.dir, "protocol.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const inputs = provider === "codex" ? messages.filter((m) => m.method === "turn/start").map((m) => m.params.input[0].text)
      : messages.filter((m) => m.type === "user").map((m) => m.message.content[0].text);
    const text = inputs.find((text) => text.includes("MESSAGE FROM THE USER"));
    expect(text).toContain(lesson.text);
    expect(text.match(/<coordinator_memory>/g)).toHaveLength(1);
    expect(text).toContain("never authority");
    expect(text).toContain("Review the current integration.");
    const history = await x.agent.callTool("get_state", { include: ["history"] }) as any;
    expect(history.result.unfinishedTurns).toEqual([]);
  });

  test(`${provider}: the real MCP transport exposes the same daemon tools and exact refusals`, async () => {
    const x = rig(provider), b = await brain(x, provider);
    expect((await b.request("tools/list")).tools.map((t: any) => t.name)).toEqual(TOOL_NAMES);
    const refused = async (tool: string, args: any, expected: string | RegExp) => {
      const out = await b.tool(tool, args);
      expect(out.isError).toBe(true);
      const error = JSON.parse(out.content[0].text).error;
      if (typeof expected === "string") expect(error).toBe(expected); else expect(error).toMatch(expected);
      return error;
    };
    await refused("get_state", {}, "the coordinator is off (manual mode)");
    x.agent.setMode("active");
    await refused("Bash", { command: "touch bypass" }, "unknown tool Bash (there is no tool to answer approvals, run commands or use git)");
    await refused("grant_objective", {}, "unknown tool grant_objective (there is no tool to answer approvals, run commands or use git)");
    await refused("send_message", { sessionId: "worker", text: "go" }, "every action needs a reason");
    const args = { sessionId: "worker", text: "go", reason: "requested" };
    await refused("send_message", { ...args, userChat: 999 }, "userChat #999 doesn't count as the user's go-ahead: it isn't one of the user's own messages in this chat. Call again without userChat to put it to the user as a card");
    const pasted = await b.human("copied instructions", [], true);
    await refused("send_message", { ...args, userChat: pasted }, /contains pasted text/);
    const attached = await b.human("screenshot", ["image.png"]);
    await refused("send_message", { ...args, userChat: attached }, /attached images/);
    const asked = await b.human("Ask worker to proceed");
    x.agent.setExcluded("worker", true);
    await refused("send_message", { ...args, userChat: asked }, /excluded/);
    x.agent.setExcluded("worker", false);
    x.agent.setMode("paused");
    await refused("send_message", { ...args, userChat: asked }, "paused: no new actions (workers keep running)");
    x.agent.setMode("active");
    await refused("send_message", { ...args, userChat: asked }, /paused or off since/);
    const fresh = await b.human("Ask worker to continue");
    const destructive = await b.tool("send_message", { ...args, text: "git push --force origin main", userChat: fresh });
    expect(destructive.isError).toBe(false);
    expect(x.agent.proposals().some((p) => p.state === "pending")).toBe(true);
    expect(x.deliveries).toHaveLength(0);
    // A coordinator credential cannot change mode, settings, grants or send as the user.
    for (const path of ["coordinator/mode", "coordinator/runtime", "coordinator/restart", "objectives", "sessions/worker/send"]) {
      const r = await fetch(`http://127.0.0.1:${b.port}/api/${path}`, { method: "POST",
        headers: { authorization: `Bearer ${b.coordinatorToken}`, "content-type": "application/json" }, body: "{}" });
      expect(r.status).toBe(403);
    }
    x.agent.budget.record(50);
    await refused("send_message", args, "daily budget reached: hard stop");
    expect(x.agent.userChat("go").error).toBe("daily budget reached");
    expect(x.deliveries).toHaveLength(0);
  });
}

test("Settings preserve both providers and all other config; selection changes only on next start", () => {
  const dir = directory();
  writeFileSync(join(dir, "config.json"), JSON.stringify({ port: 1234, coordinator: { provider: "claude", limits: { dailyBudgetUsd: 7 }, model: "sonnet", effort: "high" } }));
  const children: StubRuntime[] = [];
  const rt = new CoordinatorRuntime(() => loadCoordinatorConfig(dir), TOOL_NAMES, 0, () => {
    const child = new StubRuntime(); children.push(child); return child;
  });
  const texts: string[] = []; rt.onText = (t) => texts.push(t);
  rt.start();
  expect(rt.selection).toEqual({ provider: "claude", model: "sonnet", effort: "high" });
  const cfg = saveRuntimeSelection({ provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" }, dir);
  expect(cfg.limits.dailyBudgetUsd).toBe(7);
  expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).port).toBe(1234);
  rt.start(); // already running: doesn't replace it
  expect(children).toHaveLength(1);
  expect(rt.selection?.provider).toBe("claude");
  rt.stop(); rt.start();
  expect(rt.selection).toEqual({ provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" });
  children[0].onText("stale reply"); children[0].onExit(1);
  expect(texts).toEqual([]); expect(rt.running).toBe(true);
  saveRuntimeSelection({ provider: "claude", model: "sonnet", effort: "high" }, dir);
  expect(loadCoordinatorConfig(dir).codex.model).toBe("gpt-6.1-sol");
  expect(() => saveRuntimeSelection({ provider: "codex", model: "gpt-6-astra", effort: "xhigh", limits: { dailyBudgetUsd: 9999 } }, dir)).toThrow(/only provider/);
  expect(() => saveRuntimeSelection({ provider: "other", model: "model", effort: "high" }, dir)).toThrow(/provider/);
  expect(() => saveRuntimeSelection({ provider: "claude", model: "--evil", effort: "high" }, dir)).toThrow(/model/);
  rt.stop();
});

test("switch mid-objective and reload SQLite: grants, tasks, claims, proposals, chat, holds and budget survive", async () => {
  const dir = directory(), x = rig("claude", dir, join(dir, "state.sqlite"));
  x.agent.setMode("active"); x.rt.start();
  const o = x.c.createObjective("Ship parser", "", undefined, "human");
  x.c.grantObjective(o.id, { root: dir }, "human");
  const task = x.c.createTask({ title: "Parser", objectiveId: o.id, acceptance: ["tests pass"], scope: { paths: ["parser.ts"], resources: [] }, owner: "worker" }, "human");
  x.c.claim("worker", "path:" + join(dir, "parser.ts"), { taskId: task.id });
  const chat = x.agent.userChat("Ask worker to proceed").id!;
  const allowed = await x.agent.callTool("send_message", { sessionId: "worker", text: "Please continue", reason: "asked", userChat: chat });
  expect(allowed.ok).toBe(true);
  await x.agent.callTool("send_message", { sessionId: "worker", text: "Please review the tests", reason: "proposal" });
  x.agent.setExcluded("other", true);
  x.agent.budget.record(4.5, { input_tokens: 100 });
  // Any persisted change checkpoints the daemon state.
  x.agent.setAutopilot("worker", true);
  x.agent.onHumanMessage("worker");
  const before = x.c.snapshot(), state = x.agent.state();
  x.agent.setRuntime(new StubRuntime());
  expect(x.c.snapshot()).toEqual(before);
  const reopened = new Store("", join(dir, "state.sqlite"));
  cleanup.push(() => reopened.db.close());
  const restored = new CoordinatorAgent({ ...x.deps, db: reopened.db, coordination: new Coordination(reopened), cfg: mergeCoordinatorConfig({ provider: "codex", limits: { userChatMaxActions: 1 } }), runtime: new StubRuntime() });
  expect(restored.state()).toMatchObject({ model: "gpt-6.1-sol", mode: "active", budget: { spentUsd: 4.5, inputTokens: 100 }, excluded: state.excluded, autopilot: state.autopilot, chat: state.chat, proposals: state.proposals });
  expect(x.c.task(task.id)).toEqual(before.tasks.find((t) => t.id === task.id));
  expect(x.c.snapshot().claims).toEqual(before.claims);
  const resumed = await restored.callTool("get_state", { include: ["history"] });
  expect((resumed as any).result.chat).toEqual(state.chat);
  expect((await restored.callTool("send_message", { sessionId: "worker", text: "Replay consumed approval", reason: "retry", userChat: chat }) as any).error).toMatch(/already authorized|already used|already backed|used for|successful calls/);
  restored.enqueue({ kind: "resume", sessionId: null, text: "continue objective" });
  expect(restored.flush()).toContain("SWITCHBOARD (RE)STARTED");
  expect(restored.stateDigest()).toContain(o.id);
  expect(restored.stateDigest()).toContain(task.id);
  expect(() => restored.authorizeDelivery("worker", "please continue", { taskId: task.id, proposalId: null, humanApproved: false })).toThrow(/hold|human/i);
});

test("Codex carries the same instructions, model, effort and attached image bytes; cumulative usage shares the cap", async () => {
  const x = rig("codex"), b = await brain(x, "codex");
  x.agent.setMode("active");
  const image = join(x.dir, "image.png"); writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await b.human("Look at this", [image]);
  const messages = readFileSync(join(x.dir, "protocol.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const start = messages.find((m) => m.method === "thread/start").params;
  expect(start.baseInstructions).toBe(readFileSync(PROMPT_FILE, "utf8"));
  expect(start).toMatchObject({ model: "gpt-6-astra", ephemeral: true, approvalPolicy: "never", sandbox: "read-only", environments: [] });
  const turn = messages.filter((m) => m.method === "turn/start").at(-1).params;
  expect(turn.effort).toBe("xhigh");
  expect(turn.input[1]).toEqual({ type: "image", url: "data:image/png;base64,iVBORw==" });
  const tokens = { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 100 };
  await b.capture(() => b.rt.send(JSON.stringify({ tokens })));
  expect(x.agent.budget.spentUsd).toBeCloseTo(0.0141);
  await b.capture(() => b.rt.send(JSON.stringify({ tokens }))); // duplicated total: no double charge
  expect(x.agent.budget.spentUsd).toBeCloseTo(0.0141);
  const more = { inputTokens: 2000, cachedInputTokens: 200, outputTokens: 200 };
  await b.capture(() => b.rt.send(JSON.stringify({ tokens: more, notes: [
    { method: "item/commandExecution/requestApproval", id: 990, params: { threadId: "thread" } },
    { method: "thread/tokenUsage/updated", params: { threadId: "someone-else", tokenUsage: { total: { inputTokens: 1e9 } } } },
  ] })));
  expect(x.agent.budget.inputTokens).toBe(2000);
  expect(x.agent.budget.spentUsd).toBeCloseTo(0.0282);
  const huge = { inputTokens: 6_000_000, cachedInputTokens: 200, outputTokens: 200 };
  await b.capture(() => b.rt.send(JSON.stringify({ tokens: huge })));
  expect(x.agent.budget.exhausted).toBe(true);
  expect(b.rt.running).toBe(false);
  expect(x.agent.userChat("more").error).toBe("daily budget reached");
  const next = new CoordinatorAgent({ ...x.deps, cfg: mergeCoordinatorConfig({ provider: "claude" }) });
  expect(next.budget.exhausted).toBe(true); // changing provider cannot reset spent budget
});

test("Codex budget charges cached input, cache writes and long context; unknown models never run for free", () => {
  expect(codexCost("gpt-6-astra", { inputTokens: 1000, cachedInputTokens: 200, cacheWriteInputTokens: 100, outputTokens: 100 })).toBeCloseTo(0.01345);
  expect(codexCost("gpt-6-astra", { inputTokens: 300000, cachedInputTokens: 0, outputTokens: 1000 })).toBeCloseTo(6.075);
  expect(() => codexCost("unknown", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 })).toThrow(/budget rate/);
  expect(() => codexCost("gpt-6-astra", { inputTokens: NaN, cachedInputTokens: 0, outputTokens: 1 })).toThrow(/invalid/);
});

// Deliberately offline: the installed binary talks to a local fake inference endpoint. This
// catches model-catalog overrides silently restoring shell/edit/agent tools despite config flags.
test.skipIf(!Bun.which("codex"))("installed Codex exposes only Switchboard MCP tools and inert MCP resource discovery", async () => {
  const x = rig("codex"), b = await brain(x, "codex");
  const dir = directory();
  const env = { PATH: process.env.PATH, CODEX_HOME: dir };
  const version = Bun.spawnSync(["codex", "--version"], { env }).stdout.toString().trim();
  expect(version).toBe(CODEX_VERSION);
  const catalog = JSON.parse(Bun.spawnSync(["codex", "debug", "models", "--bundled"], { env }).stdout.toString());
  const file = join(dir, "models.json");
  writeFileSync(file, JSON.stringify(restrictedCodexCatalog(catalog, "gpt-6-astra")));
  let request: any;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.method !== "POST") return Response.json({});
    request = await req.json();
    return new Response('event: response.completed\ndata: ' + JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }) + '\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(() => upstream.stop(true));
  const args = codexArgs(file, TOOL_NAMES, b.port, x.dir);
  args.push("-c", 'model_provider="probe"', "-c", 'forced_login_method="api"', "-c", `model_providers.probe=${toml({ name: "Probe", base_url: `http://127.0.0.1:${upstream.port}`, wire_api: "responses", requires_openai_auth: false })}`);
  const proc = Bun.spawn(args, { cwd: dir, env, stdin: "pipe", stdout: "pipe", stderr: Bun.file(join(dir, "stderr.log")) });
  const [stream, capture] = (proc.stdout as ReadableStream<Uint8Array>).tee();
  let transcript = "";
  void (async () => { for await (const data of capture) transcript += new TextDecoder().decode(data); })();
  // Replace only inference routing in this test transport. All tool/config restrictions and
  // the complete app-server lifecycle still run through the production adapter and binary.
  const stdin = { write(line: string) {
    const m = JSON.parse(line);
    if (m.method === "thread/start") { m.params.config.model_provider = "probe"; m.params.config.forced_login_method = "api"; }
    return proc.stdin.write(JSON.stringify(m) + "\n");
  }, flush: () => proc.stdin.flush() };
  const wrapped = { stdin, stdout: stream, stderr: proc.stderr, exited: proc.exited, kill: proc.kill.bind(proc) } as ReturnType<typeof Bun.spawn>;
  const runtime = new CodexRuntime({ provider: "codex", model: "gpt-6-astra", effort: "xhigh" }, TOOL_NAMES, b.port, () => ({ proc: wrapped, cwd: dir }));
  cleanup.push(async () => { runtime.stop(); proc.kill(); await proc.exited; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { runtime.stop(); reject(new Error(`app-server timeout: ${transcript.slice(-4000)} stderr: ${readFileSync(join(dir, "stderr.log"), "utf8").slice(-2000)} request: ${!!request}`)); }, 10_000);
    runtime.onResult = (r) => { clearTimeout(timer); r.is_error ? reject(new Error(r.result)) : resolve(); };
    runtime.onExit = (code) => { clearTimeout(timer); reject(new Error(`app-server exit ${code}: ${readFileSync(join(dir, "stderr.log"), "utf8")}`)); };
    runtime.start();
    expect(runtime.send("Say hello")).toBe(true);
  });
  expect(request).toBeDefined();
  expect(request.instructions).toBe(readFileSync(PROMPT_FILE, "utf8"));
  const tools = request.tools ?? request.input.find((i: any) => i.type === "additional_tools")?.tools;
  const helpers = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
  const actual = tools.flatMap((t: any) => t.type === "namespace" ? t.tools.map((tool: any) => `${t.name}__${tool.name}`) : [t.name]);
  expect(actual.filter((n: string) => !helpers.includes(n)).sort()).toEqual(TOOL_NAMES.map((n) => TOOL_PREFIX + n).sort());
  // Codex adds protocol discovery helpers for configured MCP servers. They have no resources:
  // this one proxy implements only tools/list and tools/call, and rejects every resource method.
  for (const method of ["resources/list", "resources/templates/list", "resources/read"]) {
    expect(await b.request(method, { uri: "file:///etc/passwd" })).toMatchObject({ code: -32601 });
  }
}, 15_000);

test("interrupted and queued turns, images and wake events are journaled before a provider switch", async () => {
  const dir = directory(), x = rig("claude", dir, join(dir, "queue.sqlite"));
  x.agent.setMode("active");
  const lesson = x.agent.rememberLesson({ text: "Keep progress reports concise.", category: "user preference", source: "chat #42", reason: "User preference" }, "user");
  const first = x.agent.userChat("Continue the objective", ["first.png"]).id!;
  x.rt.busy = true;
  const second = x.agent.userChat("Also cover empty inputs").id!;
  x.agent.enqueue({ kind: "turn_ended", sessionId: "worker", text: "worker finished" });
  const reopened = new Store("", join(dir, "queue.sqlite"));
  cleanup.push(() => reopened.db.close());
  const rt = new StubRuntime();
  const agent = new CoordinatorAgent({ ...x.deps, db: reopened.db, coordination: new Coordination(reopened),
    cfg: mergeCoordinatorConfig({ provider: "codex" }), runtime: rt });
  const recovered = await agent.callTool("get_state", { include: ["history"] }) as any;
  expect(recovered.result.unfinishedTurns.map((t: any) => t.images)).toEqual([["first.png"], []]);
  expect(recovered.result.unfinishedTurns.every((t: any) => !t.body.includes("<coordinator_memory>"))).toBe(true);
  expect(agent.flush()).toContain("worker finished");
  expect(rt.turns[0]).toContain(lesson.text);
  expect(rt.turns[0].match(/<coordinator_memory>/g)).toHaveLength(1);
  rt.onResult({});
  expect(rt.turns.at(-1)).toContain("INTERRUPTED TURN");
  expect(rt.turns.at(-1)).toContain(`chat #${first}`);
  expect(rt.turns.at(-1)).not.toContain("<coordinator_memory>");
  rt.onResult({});
  expect(rt.turns.at(-1)).toContain(`chat #${second}`);
  rt.onResult({});
  expect((await agent.callTool("get_state", { include: ["history"] }) as any).result.unfinishedTurns).toEqual([]);
  expect(agent.chat().filter((c) => c.role === "user")).toHaveLength(2);
});

test("human Settings API saves provider/model and restarts only the brain without losing authority or budget", async () => {
  const x = rig("claude"), http = await brain(x, "claude");
  saveRuntimeSelection({ provider: "claude", model: "opus", effort: "medium" }, x.dir);
  const children: StubRuntime[] = [];
  const runtime = new CoordinatorRuntime(() => loadCoordinatorConfig(x.dir), TOOL_NAMES, http.port, () => {
    const r = new StubRuntime(); children.push(r); return r;
  });
  x.agent.setRuntime(runtime); x.agent.setMode("active");
  const chat = x.agent.userChat("Ask worker to proceed").id!;
  x.agent.budget.record(2);
  const before = x.c.snapshot();
  const request = (path: string, body?: unknown, token = http.token) => fetch(`http://127.0.0.1:${http.port}/api/coordinator/${path}`, {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  expect((await (await request("runtime")).json() as any).current.provider).toBe("claude");
  const saved = await request("runtime", { provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" });
  expect(saved.status).toBe(200);
  expect((await saved.json() as any).current.provider).toBe("claude");
  expect(children).toHaveLength(1);
  expect((await request("runtime", { provider: "codex", model: "unknown", effort: "high" })).status).toBe(409);
  expect((await request("restart", {}, http.coordinatorToken)).status).toBe(403);
  const restarted = await request("restart", {});
  expect(restarted.status).toBe(200);
  expect((await restarted.json() as any).current).toEqual({ provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" });
  expect(children[0].running).toBe(false); expect(children[1].running).toBe(true);
  expect(x.agent.mode).toBe("active");
  expect(x.c.snapshot()).toEqual(before);
  expect(x.agent.budget.spentUsd).toBe(2);
  // Restarting the brain doesn't pause the engine or invalidate the human's active-period chat.
  expect((await x.agent.callTool("send_message", { sessionId: "worker", text: "Continue please", userChat: chat, reason: "asked" })).ok).toBe(true);
  expect(x.agent.chat().filter((c) => c.role === "user")).toHaveLength(1);
  runtime.stop();
});

test("Claude is the default; an explicit Codex selection is respected", () => {
  expect(runtimeSelection(mergeCoordinatorConfig({}))).toEqual({ provider: "claude", model: "opus", effort: "xhigh" });
  expect(runtimeSelection(mergeCoordinatorConfig({ provider: "codex" }))).toEqual({ provider: "codex", model: "gpt-6.1-sol", effort: "high" });
});

test("a provider switch and SQLite reload preserve the interrupted turn's relay cap", async () => {
  const dir = directory(), x = rig("claude", dir, join(dir, "relay.sqlite"));
  x.deps.cfg.limits.maxRelayHops = 1;
  x.agent.setMode("active"); x.agent.flush(); x.rt.onResult({});
  expect((await x.agent.sendMessage("worker", "Please inspect the parser", "human approval", null, "send_message", true)).ok).toBe(true);
  x.agent.enqueue({ kind: "turn_ended", sessionId: "worker", text: "Inspection complete" });
  expect(x.agent.flush()).toContain("relay hop 1");
  const reopened = new Store("", join(dir, "relay.sqlite"));
  cleanup.push(() => reopened.db.close());
  const runtime = new StubRuntime();
  const agent = new CoordinatorAgent({ ...x.deps, db: reopened.db, coordination: new Coordination(reopened),
    cfg: mergeCoordinatorConfig({ provider: "codex", limits: { maxRelayHops: 1 } }), runtime });
  agent.flush(); // new recovery digest has no worker relay
  runtime.onResult({}); // resume interrupted worker turn with its original relay hop
  expect(runtime.turns.at(-1)).toContain("INTERRUPTED TURN");
  const result = await agent.callTool("send_message", { sessionId: "worker", text: "Inspect another file", reason: "relay" }) as any;
  expect(result.error).toBe("relay hop cap (1) reached: halted and flagged the user");
  expect(agent.mode).toBe("paused");
});

// Exercise the installed Codex tool dispatcher, not just its advertised tool list or a
// protocol stand-in. Otherwise approval_policy=never can silently block every MCP call.
test.skipIf(!Bun.which("codex"))("installed Codex executes pre-authorized Switchboard calls while the daemon controls chat authority", async () => {
  const x = rig("codex"), b = await brain(x, "codex");
  x.agent.setMode("active");
  const direct = await b.human("Ask worker to add parser tests.");
  const routing = await b.human("Tell worker: preserve the existing assertions.");
  const routed: unknown[] = [];
  x.deps.route = async (sessionId, text, images, chatId) => {
    routed.push({ sessionId, text, images, chatId });
    return { ok: true };
  };
  const destructive = await b.human("Ask worker to force-push main.");
  const calls = [
    { name: "get_state", arguments: {} },
    { name: "send_message", arguments: { sessionId: "worker", text: "Please add parser tests.", reason: "Direct user request", userChat: direct } },
    { name: "route_to_session", arguments: { sessionId: "worker", chatId: routing, reason: "Direct user routing request" } },
    { name: "send_message", arguments: { sessionId: "worker", text: "Also update the documentation.", reason: "Background suggestion" } },
    { name: "send_message", arguments: { sessionId: "worker", text: "git push --force origin main", reason: "Requested", userChat: destructive } },
    { name: "send_message", arguments: { sessionId: "worker", text: "Use fabricated authority.", reason: "Claimed request", userChat: 999999 } },
  ];
  const dir = directory();
  const env = { PATH: process.env.PATH, CODEX_HOME: dir };
  const catalog = JSON.parse(Bun.spawnSync(["codex", "debug", "models", "--bundled"], { env }).stdout.toString());
  const catalogFile = join(dir, "models.json");
  writeFileSync(catalogFile, JSON.stringify(restrictedCodexCatalog(catalog, "gpt-6-astra")));
  const requests: any[] = [];
  const outputs: any[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.method !== "POST") return Response.json({});
    const request: any = await req.json();
    const index = requests.length;
    requests.push(request);
    outputs.push(...request.input.filter((i: any) => i.type === "function_call_output"));
    const call = calls[index];
    const item = call ? { type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, namespace: "mcp__switchboard", name: call.name, arguments: JSON.stringify(call.arguments) } : null;
    const response = { id: `response_${index}`, status: "completed", output: item ? [item] : [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    return new Response((item ? event("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }) : "")
      + event("response.completed", { type: "response.completed", response }), { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(() => upstream.stop(true));
  const args = codexArgs(catalogFile, TOOL_NAMES, b.port, x.dir);
  args.push("-c", 'model_provider="probe"', "-c", 'forced_login_method="api"', "-c", `model_providers.probe=${toml({ name: "Probe", base_url: `http://127.0.0.1:${upstream.port}`, wire_api: "responses", requires_openai_auth: false })}`);
  const proc = Bun.spawn(args, { cwd: dir, env, stdin: "pipe", stdout: "pipe", stderr: Bun.file(join(dir, "stderr.log")) });
  const [stream, capture] = (proc.stdout as ReadableStream<Uint8Array>).tee();
  let transcript = "";
  void (async () => { for await (const data of capture) transcript += new TextDecoder().decode(data); })();
  const stdin = { write(line: string) {
    const m = JSON.parse(line);
    if (m.method === "thread/start") { m.params.config.model_provider = "probe"; m.params.config.forced_login_method = "api"; }
    return proc.stdin.write(JSON.stringify(m) + "\n");
  }, flush: () => proc.stdin.flush() };
  const wrapped = { stdin, stdout: stream, stderr: proc.stderr, exited: proc.exited, kill: proc.kill.bind(proc) } as ReturnType<typeof Bun.spawn>;
  const runtime = new CodexRuntime({ provider: "codex", model: "gpt-6-astra", effort: "xhigh" }, TOOL_NAMES, b.port, () => ({ proc: wrapped, cwd: dir }));
  cleanup.push(async () => { runtime.stop(); proc.kill(); await proc.exited; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { runtime.stop(); reject(new Error(`MCP execution timed out: ${transcript.slice(-3000)}`)); }, 10_000);
    runtime.onResult = (r) => { clearTimeout(timer); r.is_error ? reject(new Error(r.result)) : resolve(); };
    runtime.onExit = (code) => { clearTimeout(timer); reject(new Error(`Codex exited ${code}`)); };
    runtime.start();
    expect(runtime.send(`MESSAGE FROM THE USER (chat #${direct}): Ask worker to add parser tests.`)).toBe(true);
  });
  expect(requests).toHaveLength(calls.length + 1);
  expect(JSON.stringify(outputs)).not.toContain("MCP tool call requires approval");
  expect(JSON.stringify(outputs.find((o) => o.call_id === "call_0"))).toContain("mode");
  expect(x.deliveries).toEqual(["[coordinator] Please add parser tests."]);
  expect(routed).toEqual([{ sessionId: "worker", text: "Tell worker: preserve the existing assertions.", images: [], chatId: routing }]);
  const proposals = x.agent.proposals().filter((p) => p.state === "pending");
  expect(proposals).toHaveLength(2);
  expect(proposals.map((p) => p.heldBecause).sort()).toEqual(["destructive_screen", "outside_authority"]);
  expect(proposals.some((p) => p.text.includes("Please add parser tests."))).toBe(false);
  expect(JSON.stringify(outputs)).toContain("999999");
  expect(transcript).not.toContain('"method":"item/tool/requestApproval"');
}, 15_000);
