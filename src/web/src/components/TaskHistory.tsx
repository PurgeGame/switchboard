import type { Task } from "../../../shared/types.ts";

import { WorkerRecommendation } from "./WorkerRecommendation.tsx";

export function TaskHistory({ task }: { task: Task }) {
  if (!task.feedback?.length) return <WorkerRecommendation value={task.recommendation} />;
  return (
    <>
    <WorkerRecommendation value={task.recommendation} />
    <details className="text-[12px] text-ink-2">
      <summary className="cursor-pointer">Task history</summary>
      <ul className="space-y-2 py-2">
        {task.feedback.map((f, i) => (
          <li key={i}>
            <p className="text-ink-3">Sent back by you · <time dateTime={new Date(f.at).toISOString()}>{new Date(f.at).toLocaleString()}</time></p>
            <p className="whitespace-pre-wrap break-words">{f.note}</p>
          </li>
        ))}
      </ul>
    </details>
    </>
  );
}
