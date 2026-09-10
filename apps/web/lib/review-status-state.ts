export type ReviewState = {
  id: string;
  number: number;
  status: string;
  headSha?: string | null;
};

export type ReviewStatusEvent = {
  repoId: string;
  pullRequestId: string;
  number: number;
  status: string;
  headSha?: string | null;
};

export function applyReviewRequested<T extends ReviewState>(state: Record<string, T[]>, event: { repoId: string; pullRequest: T }): Record<string, T[]> {
  const existing = state[event.repoId] ?? [];
  const previous = existing.find(pr => pr.number === event.pullRequest.number);
  if (previous?.headSha && !event.pullRequest.headSha) return state;
  return { ...state, [event.repoId]: [event.pullRequest, ...existing.filter(pr => pr.number !== event.pullRequest.number)] };
}

export function applyReviewStatus<T extends ReviewState>(state: Record<string, T[]>, event: ReviewStatusEvent): Record<string, T[]> {
  if (!event.headSha) return state;
  const existing = state[event.repoId];
  if (!existing?.some(pr => pr.id === event.pullRequestId && pr.number === event.number && pr.headSha === event.headSha)) return state;
  return { ...state, [event.repoId]: existing.map(pr =>
    pr.id === event.pullRequestId && pr.number === event.number && pr.headSha === event.headSha ? { ...pr, status: event.status } : pr,
  ) };
}
