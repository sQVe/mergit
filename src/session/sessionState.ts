import type { GitHubFailure } from '../github/github.ts';
import type { NotificationThread, ThreadId } from '../work/work.ts';
import { selectOpenThreads } from '../work/work.ts';

type Notice = 'ghMissing' | 'notSignedIn';

export interface Snapshot {
  threads: NotificationThread[];
  selectedThreadId: ThreadId | null;
  refreshStatus: 'idle' | 'running';
  errorMessage: string | null;
  notice: Notice | null;
  hasLoaded: boolean;
  refreshedAt: Date | null;
  feedBusy: boolean;
  pausedUntil: Date | null;
}

export const initialSnapshot: Snapshot = {
  threads: [],
  selectedThreadId: null,
  refreshStatus: 'idle',
  errorMessage: null,
  notice: null,
  hasLoaded: false,
  refreshedAt: null,
  feedBusy: false,
  pausedUntil: null,
};

const selectAfterRefresh = (
  previousThreads: NotificationThread[],
  previousId: ThreadId | null,
  threads: NotificationThread[],
): ThreadId | null => {
  const previousIndex = previousThreads.findIndex((thread) => thread.id === previousId);
  const stillPresent = threads.some((thread) => thread.id === previousId);

  if (stillPresent) {
    return previousId;
  }

  const index = Math.min(Math.max(previousIndex, 0), threads.length - 1);

  return threads[index]?.id ?? null;
};

export const startRefresh = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  refreshStatus: 'running',
  pausedUntil: null,
});

export const applyThreads = (
  snapshot: Snapshot,
  fetched: NotificationThread[],
  now: Date,
): Snapshot => {
  const threads = selectOpenThreads(fetched);

  return {
    threads,
    selectedThreadId: selectAfterRefresh(snapshot.threads, snapshot.selectedThreadId, threads),
    refreshStatus: 'idle',
    errorMessage: null,
    notice: null,
    hasLoaded: true,
    refreshedAt: now,
    feedBusy: false,
    pausedUntil: null,
  };
};

export const markFeedBusy = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  refreshStatus: 'idle',
  feedBusy: true,
});

const failureMessage = (failure: GitHubFailure): string => {
  if (failure.kind === 'rateLimited') {
    const resetTime = /T(\d{2}:\d{2}:\d{2})/.exec(failure.resetAt.toISOString())?.[1] ?? '';

    return `Rate limited, paused until ${resetTime} UTC`;
  }

  if (failure.kind === 'ghMissing' || failure.kind === 'notSignedIn') {
    return failure.kind;
  }

  return failure.message;
};

export const applyFailure = (snapshot: Snapshot, failure: GitHubFailure, now: Date): Snapshot => {
  const isNotice = failure.kind === 'ghMissing' || failure.kind === 'notSignedIn';

  return {
    ...snapshot,
    refreshStatus: 'idle',
    errorMessage: isNotice ? null : failureMessage(failure),
    notice: isNotice ? failure.kind : null,
    hasLoaded: true,
    refreshedAt: now,
    pausedUntil: failure.kind === 'rateLimited' ? failure.resetAt : null,
  };
};

export const clearFailure = (snapshot: Snapshot): Snapshot => {
  if (snapshot.errorMessage === null && snapshot.notice === null) {
    return snapshot;
  }

  return { ...snapshot, errorMessage: null, notice: null };
};

export const moveSelection = (snapshot: Snapshot, step: 1 | -1): Snapshot => {
  const { threads } = snapshot;
  const current = threads.findIndex((thread) => thread.id === snapshot.selectedThreadId);
  const next = Math.min(Math.max(current + step, 0), threads.length - 1);
  const selectedThreadId = threads[next]?.id ?? null;

  if (selectedThreadId === snapshot.selectedThreadId) {
    return snapshot;
  }

  return { ...snapshot, selectedThreadId };
};
