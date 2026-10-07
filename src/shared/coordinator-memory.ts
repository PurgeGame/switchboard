export const LESSON_CATEGORIES = ["user preference", "process", "provider+tier", "repo-specific"] as const;
export type LessonCategory = typeof LESSON_CATEGORIES[number];
export interface CoordinatorLesson {
  id: string;
  text: string;
  category: LessonCategory;
  repoPath: string | null;
  source: string;
  reason: string;
  createdAt: number;
  updatedAt: number;
  hitCount: number;
  lastUsedAt: number | null;
  /** A "user preference" the coordinator wrote: not applied until the user keeps it in Settings. */
  pending?: true;
  /** Written or changed by the coordinator and not yet seen by the user: listed as new in Settings. */
  unseen?: true;
  /** Set from the writer's credential (never the request): absent means the user wrote it. */
  author?: "coordinator";
}
export interface LessonInput {
  id?: string;
  text: string;
  category: LessonCategory;
  repoPath?: string | null;
  source: string;
  reason: string;
}
export interface MemorySnapshot {
  lessons: CoordinatorLesson[];
  estimatedTokens: number;
  maxTokens: number;
}
