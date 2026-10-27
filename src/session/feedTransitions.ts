import type { GitHubFailure } from '../github/github.ts';
import type { NotificationThread, ThreadId } from '../work/work.ts';
import { selectOpenThreads } from '../work/work.ts';
import { selectAfterRefresh } from './selectionRepair.ts';
import type { Snapshot } from './sessionState.ts';
import { visibleRows } from './sessionState.ts';

const isoTimeStart = 11;
const isoTimeEnd = 19;

const futurePauseOf = (snapshot: Snapshot, now: Date): Date | null => {
  const { pausedUntil } = snapshot;

  return pausedUntil !== null && pausedUntil.getTime() > now.getTime() ? pausedUntil : null;
};

export const failureMessage = (failure: GitHubFailure): string => {
  if (failure.kind === 'rateLimited') {
    const resetTime = failure.resetAt.toISOString().slice(isoTimeStart, isoTimeEnd);

    return `Rate limited, paused until ${resetTime} UTC`;
  }

  if (failure.kind === 'ghMissing' || failure.kind === 'notSignedIn') {
    return failure.kind;
  }

  if (failure.kind === 'responseTooLarge') {
    return `GitHub response passed the ${failure.limitBytes} byte limit`;
  }

  return failure.message;
};

export const laterPauseOf = (first: Date | null, second: Date): Date =>
  first === null ? second : new Date(Math.max(first.getTime(), second.getTime()));

const pauseMessageOf = (pausedUntil: Date | null): string | null =>
  pausedUntil === null ? null : failureMessage({ kind: 'rateLimited', resetAt: pausedUntil });

export const startRefresh = (snapshot: Snapshot, now: Date): Snapshot => ({
  ...snapshot,
  refreshStatus: 'running',
  pausedUntil: futurePauseOf(snapshot, now),
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
  const pausedUntil = futurePauseOf(snapshot, now);

  return {
    ...updated,
    selectedRowKey: selectAfterRefresh(
      visibleRows(snapshot),
      snapshot.selectedRowKey,
      visibleRows(updated),
    ),
    refreshStatus: 'idle',
    errorMessage: pauseMessageOf(pausedUntil),
    notice: null,
    hasLoaded: true,
    feedBusy: false,
    pausedUntil,
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

export const applyFailure = (snapshot: Snapshot, failure: GitHubFailure, now: Date): Snapshot => {
  const isNotice = failure.kind === 'ghMissing' || failure.kind === 'notSignedIn';
  const activePause = futurePauseOf(snapshot, now);

  const pausedUntil =
    failure.kind === 'rateLimited' ? laterPauseOf(activePause, failure.resetAt) : activePause;

  const failureText = isNotice ? null : failureMessage(failure);

  return {
    ...snapshot,
    refreshStatus: 'idle',
    errorMessage: pauseMessageOf(pausedUntil) ?? failureText,
    notice: isNotice ? failure.kind : null,
    hasLoaded: true,
    refreshedAt: now,
    pausedUntil,
  };
};

export const clearFailure = (snapshot: Snapshot, now: Date): Snapshot => {
  const errorMessage = pauseMessageOf(futurePauseOf(snapshot, now));

  if (snapshot.errorMessage === errorMessage && snapshot.notice === null) {
    return snapshot;
  }

  return { ...snapshot, errorMessage, notice: null };
};
