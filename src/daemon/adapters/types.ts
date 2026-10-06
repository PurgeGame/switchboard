import type { Confidence, Connection, Execution, Provider, SessionKind } from "../../shared/types.ts";
import type { ProcInfo } from "../proc.ts";

export interface DiscoverCtx {
  procs: Map<number, ProcInfo>;
  kids: Map<number, number[]>;
  now: number;
}

/** What an adapter knows about a live session right now. */
export interface Discovered {
  id: string;
  provider: Provider;
  kind: SessionKind;
  nativeId: string;
  name: string | null;
  cwd: string | null;
  pid: number | null;
  pidConfidence: Confidence;
  tty: string | null;
  transcriptPath: string | null;
  connection: Connection;
  limitations: string[];
  startedAt: number | null;
  model?: string | null;
  /** Live status reported by the provider itself (registry, daemon). */
  liveStatus?: { execution: Execution; confidence: Confidence; detail?: string; /** when the provider last changed it (ms) */ since?: number };
  /** PIDs whose resource usage belongs to this session, beyond `pid`'s own tree. */
  extraPids?: number[];
  extraPidsInferred?: boolean;
  meta?: Record<string, unknown>;
}

export interface ParsedRecord {
  events: import("../../shared/types.ts").SbEvent[];
  patch?: Record<string, unknown>;
}

export interface Adapter {
  readonly provider: Provider;
  discover(ctx: DiscoverCtx): Promise<Discovered[]>;
  parse(record: unknown, sessionId: string, offsetKey: string): ParsedRecord;
  /** History cap when a transcript is first seen. */
  readonly initialTranscriptBytes: number;
  /** PIDs this adapter claims, so the generic scanner skips them. */
  claimedPids(): Set<number>;
}
