import type { WorkerRecommendation as Recommendation } from "../../../shared/types.ts";

export function WorkerRecommendation({ value }: { value?: Recommendation }) {
  if (!value) return null;
  return <div className="min-w-0 whitespace-pre-wrap break-words text-[11px] text-ink-3" aria-label="Worker choice reason">
    <p>{value.queued ? "Waiting" : "Worker choice"}: {value.provider} · {value.tier} · {value.model}{value.effort ? ` · ${value.effort}` : ""}</p>
    <p>{value.reason}</p>
    <p>Evaluated <time dateTime={new Date(value.at).toISOString()}>{new Date(value.at).toLocaleString()}</time>; usage may have changed.</p>
  </div>;
}
