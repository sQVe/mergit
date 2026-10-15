import type { GitHubFailure } from '../github/github.ts';
import type { NotificationThread, ThreadId } from '../work/work.ts';
import { selectOpenThreads } from '../work/work.ts';
import { selectAfterRefresh } from './selectionRepair.ts';
import type { Snapshot } from './sessionState.ts';
import { visibleRows } from './sessionState.ts';

export const startRefresh = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  refreshStatus: 'running',
  pausedUntil: null,
});

export const applyThreads = (
  snapshot: Snapshot,
  fetched: NotificationThread[],
  doneRecords: ReadonlyMap<ThreadId, string>,
  now: Date,
): Snapshot => {
  const threads = selectOpenThreads(fetched, doneRecords);

  const previousUpdatedAt = new Map(
    snapshot.threads.map((thread) => [thread.id, thread.updatedAt]),
  );

  const unchangedIds = new Set(
    threads
      .filter((thread) => previousUpdatedAt.get(thread.id) === thread.updatedAt)
      .map((thread) => thread.id),
  );

  const subjectFacts = new Map(
    [...snapshot.subjectFacts].filter(([threadId]) => unchangedIds.has(threadId)),
  );

  const updated = { ...snapshot, threads, subjectFacts, refreshedAt: now, savedAt: null };

  return {
    ...updated,
    selectedRowKey: selectAfterRefresh(
      visibleRows(snapshot),
      snapshot.selectedRowKey,
      visibleRows(updated),
    ),
    refreshStatus: 'idle',
    errorMessage: null,
    notice: null,
    hasLoaded: true,
    feedBusy: false,
    pausedUntil: null,
  };
};

export const showSavedThreads = (
  start: Snapshot,
  saved: NotificationThread[],
  doneRecords: ReadonlyMap<ThreadId, string>,
  savedAt: Date,
): Snapshot => {
  const threads = selectOpenThreads(saved, doneRecords);

  const loaded = { ...start, threads, savedAt };

  return {
    ...loaded,
    selectedRowKey: visibleRows(loaded)[0]?.key ?? null,
    hasLoaded: true,
  };
};

export const clearAccount = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  threads: [],
  subjectFacts: new Map(),
  newThreadIds: new Set(),
  selectedRowKey: null,
  hasLoaded: false,
  refreshedAt: null,
  savedAt: null,
});

export const markFeedBusy = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  refreshStatus: 'idle',
  feedBusy: true,
});

export const failureMessage = (failure: GitHubFailure): string => {
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
