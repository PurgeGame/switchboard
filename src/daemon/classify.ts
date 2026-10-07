// Classify how a turn ended, from the agent's final message.
// Deterministic heuristics first; a cheap model call only for genuinely ambiguous questions.

export type Outcome = "success" | "failure" | "incomplete" | "limit" | "unclear";

export interface TurnEndClass {
  /** Is the agent waiting on the user? "ambiguous" means heuristics could not decide. */
  question: "yes" | "no" | "ambiguous";
  /** The question is only "shall I continue / proceed?" (an auto-continue candidate). */
  continuationAsk: boolean;
  /** Real choice between options, or a request for information only the user has. */
  realChoice: boolean;
  outcome: Outcome;
  questionText: string | null;
}

const ASK = /\b(should i|shall i|do you want(?: me)?|would you like(?: me)?|want me to|can you confirm|could you confirm|please confirm|let me know|which (?:one|option|approach|of these|would you)|what would you like|how would you like|do you prefer|are you ok with|okay to|ok to proceed|proceed\?|go ahead\?|(?:y\/n)|\[y\/n\])/i;
// Read requests across the final message: a permission explanation often follows the ask.
const REQUEST = /\b(?:(?:please|could you|can you|would you|you (?:need to|must))\s+(?:allow|approve|authorize|confirm|choose|select|pick|provide|send|share|enter|reply|answer|upload|paste|enable|grant|decide|tell me)|(?:i need|i'm waiting for|waiting (?:for|on))\s+(?:you(?:r)?|the user(?:'s)?|human)|(?:your|human)\s+(?:approval|permission|confirmation|input|decision)\s+(?:is (?:needed|required)|before)|(?:allow|approve|confirm|choose|select|reply|provide|paste|upload)\b[^.!?]{0,120}\b(?:to continue|before i can|so i can))\b/i;
const WHICH_INPUT = /\b(?:which (?:branch|repo(?:sitory)?|environment|target|file|version|name)|what (?:is your|should|would|do you)|where (?:should|do you)|when (?:should|do you)|how (?:should|would you))\b[^?]*\?/i;
const HUMAN_GATE = /\b(?:permission|approval|authorize|allow|denied|blocked|classifier|human|user input)\b/i;

const CONTINUE_ASK = /\b(shall i|should i|want me to|would you like me to|do you want me to|ready to|ok(?:ay)? to)\s+(?:go ahead|proceed|continue|keep going|carry on|move on|start|begin|implement|do (?:it|that|this|the rest)|apply|run|finish|tackle|work on)\b|\b(?:proceed|continue|go ahead|keep going)\s*(?:with[^?]{0,80})?\?\s*$/i;
const OPTIONS = /(^|\n)\s*(?:\d+[.)]|[-*]|\(?[a-d]\))\s+\S.*(\n\s*(?:\d+[.)]|[-*]|\(?[a-d]\))\s+\S.*){1,}/;
const CHOICE = /\b(which|or)\b[^?]{0,200}\?|\b(option [a-d1-9]|approach [a-d1-9])\b/i;

const FAIL = /\b(fail(?:ed|ing|s)?|error(?:s)?|could not|couldn't|unable to|cannot|can't|broken|crash(?:ed|es)?|regression|not working|exception)\b/i;
const INCOMPLETE = /\b(remaining|still need|not yet|todo|to do:|next steps?|partially|incomplete|left to do|haven't|have not|pending|in progress|will continue|i'll continue|stopping here)\b/i;
const LIMIT = /\b(usage limit|rate limit|session limit|context (?:window|limit)|out of (?:tokens|credits)|quota|resets? (?:at|in))\b/i;
const SUCCESS = /\b(done|complete(?:d)?|finished|implemented|fixed|all (?:\d+ )?tests? pass(?:ed|ing)?|passing|merged|shipped|works|working now|succeeded|successfully|ready for review)\b/i;

/** The last non-empty paragraph, where questions to the user usually live. */
function tail(text: string): string {
  const paras = text.trim().split(/\n\s*\n/).filter((p) => p.trim());
  return (paras.at(-1) ?? "").trim();
}

export function classifyTurnEnd(text: string | null | undefined): TurnEndClass {
  const t = (text ?? "").trim();
  if (!t) return { question: "no", continuationAsk: false, realChoice: false, outcome: "unclear", questionText: null };
  // Quoted transcripts and code examples are not requests from this assistant.
  const prose = t.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/^\s*>.*$/gm, "");
  const paras = prose.split(/\n\s*\n/).filter((p) => p.trim());
  const request = paras.filter((p) => REQUEST.test(p) || ASK.test(p) || WHICH_INPUT.test(p)).at(-1);
  const last = (request ?? tail(prose)).trim();
  const lastLine = last.split("\n").filter((l) => l.trim()).at(-1) ?? "";
  const endsWithQ = /\?\s*[)*_`"']*\s*$/.test(lastLine);
  const askWords = ASK.test(last);
  const directRequest = REQUEST.test(last);
  const options = OPTIONS.test(last) && (endsWithQ || askWords || directRequest);
  const continuationAsk = !directRequest && !HUMAN_GATE.test(prose) && (endsWithQ || askWords) && CONTINUE_ASK.test(last) && !CHOICE.test(last.replace(CONTINUE_ASK, ""));
  const realChoice = directRequest || options || (endsWithQ && CHOICE.test(last) && !continuationAsk) || (askWords && HUMAN_GATE.test(prose));

  let question: TurnEndClass["question"];
  if (directRequest || (endsWithQ && (askWords || options || last.length < 400))) question = "yes";
  else if (options || (askWords && /\b(let me know|please confirm|which)\b/i.test(last))) question = "yes";
  else if (endsWithQ || askWords) question = "ambiguous";
  else question = "no";

  let outcome: Outcome = "unclear";
  if (LIMIT.test(t)) outcome = "limit";
  else if (FAIL.test(last) && !/\b(no|zero|0) (?:errors?|failures?)\b|without errors/i.test(last)) outcome = "failure";
  else if (INCOMPLETE.test(last)) outcome = "incomplete";
  else if (SUCCESS.test(t)) outcome = "success";

  return { question, continuationAsk, realChoice, outcome, questionText: question === "no" ? null : last.slice(0, 1500) };
}

/** Cache + single-flight wrapper around an optional model call for ambiguous cases. */
export class AmbiguityResolver {
  private cache = new Map<string, boolean>();
  constructor(private ask: ((text: string) => Promise<boolean | null>) | null) {}

  async isQuestion(key: string, text: string): Promise<boolean | null> {
    if (this.cache.has(key)) return this.cache.get(key)!;
    if (!this.ask) return null;
    const r = await this.ask(text).catch(() => null);
    if (r !== null) this.cache.set(key, r);
    return r;
  }
}

/** Ask Haiku via the user's Claude login (no API key; `claude -p`). Returns null on any failure. */
export async function haikuIsQuestion(text: string): Promise<boolean | null> {
  const prompt =
    "An AI coding agent ended its turn with the message below. Is it waiting for the human to answer a question or make a decision before it can continue? Reply with exactly YES or NO.\n\n---\n" +
    text.slice(-3000);
  try {
    const p = Bun.spawn(["claude", "-p", "--model", "haiku", "--no-session-persistence", "--setting-sources", "", prompt], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      cwd: "/tmp",
      env: { ...process.env, SB_INTERNAL: "classifier" }, // discovery skips internal sessions
    });
    const timer = setTimeout(() => p.kill(), 30_000);
    const out = (await new Response(p.stdout).text()).trim().toUpperCase();
    clearTimeout(timer);
    if (out.startsWith("YES")) return true;
    if (out.startsWith("NO")) return false;
    return null;
  } catch {
    return null;
  }
}
