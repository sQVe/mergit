import type { GitHubFailure, SubjectLookup } from '../github/github.ts';
import { invariant } from '../invariant.ts';
import type {
  Grouping,
  NodeRow,
  NotificationThread,
  SubjectFacts,
  ThreadId,
  TreeRow,
} from '../work/work.ts';
import { groupings, selectOpenThreads, treeRows } from '../work/work.ts';

type Notice = 'ghMissing' | 'notSignedIn';

export interface Toast {
  title: string;
  lines: string[];
  tone: 'info' | 'error';
  durationMilliseconds: number;
}

export type UnsavedChange = 'grouping' | 'done' | 'seen';

interface Confirmation {
  threadIds: readonly ThreadId[];
}

export interface Snapshot {
  threads: NotificationThread[];
  hiddenThreadIds: ReadonlySet<ThreadId>;
  subjectFacts: ReadonlyMap<ThreadId, SubjectFacts>;
  newThreadIds: ReadonlySet<ThreadId>;
  selectedRowKey: string | null;
  grouping: Grouping;
  foldedNodes: Record<Grouping, ReadonlySet<string>>;
  refreshStatus: 'idle' | 'running';
  errorMessage: string | null;
  notice: Notice | null;
  hasLoaded: boolean;
  refreshedAt: Date | null;
  savedAt: Date | null;
  feedBusy: boolean;
  pausedUntil: Date | null;
  stateWarning: string | null;
  toast: Toast | null;
  confirmation: Confirmation | null;
}

export interface NewThreadInput {
  threads: NotificationThread[];
  seen: ReadonlyMap<ThreadId, string> | undefined;
  subjectFacts: ReadonlyMap<ThreadId, SubjectFacts>;
  viewerLogin: string;
  pendingThreadIds: ReadonlySet<ThreadId>;
}

export const initialSnapshot: Snapshot = {
  threads: [],
  hiddenThreadIds: new Set(),
  subjectFacts: new Map(),
  newThreadIds: new Set(),
  selectedRowKey: null,
  grouping: 'reason',
  foldedNodes: {
    reason: new Set(),
    type: new Set(),
    none: new Set(),
  },
  refreshStatus: 'idle',
  errorMessage: null,
  notice: null,
  hasLoaded: false,
  refreshedAt: null,
  savedAt: null,
  feedBusy: false,
  pausedUntil: null,
  stateWarning: null,
  toast: null,
  confirmation: null,
};

export const isViewerActor = (facts: SubjectFacts | undefined, viewerLogin: string): boolean =>
  facts?.latestActor?.toLowerCase() === viewerLogin.toLowerCase();

export const newThreadIdsOf = (input: NewThreadInput): ReadonlySet<ThreadId> => {
  const { seen, subjectFacts, viewerLogin, pendingThreadIds } = input;
  const newIds = new Set<ThreadId>();

  if (seen === undefined) {
    return newIds;
  }

  for (const thread of input.threads) {
    const seenAt = seen.get(thread.id);

    const changed = seenAt === undefined || Date.parse(thread.updatedAt) > Date.parse(seenAt);

    const ownActivity = isViewerActor(subjectFacts.get(thread.id), viewerLogin);

    if (changed && !ownActivity && !pendingThreadIds.has(thread.id)) {
      newIds.add(thread.id);
    }
  }

  return newIds;
};

export const visibleRows = (snapshot: Snapshot): TreeRow[] => {
  const shown = snapshot.threads.filter((thread) => !snapshot.hiddenThreadIds.has(thread.id));

  return treeRows(shown, snapshot.grouping, snapshot.foldedNodes[snapshot.grouping]);
};

const topLevelRowOf = (rows: TreeRow[], index: number): NodeRow | undefined => {
  for (let candidate = index; candidate >= 0; candidate -= 1) {
    const row = rows[candidate];

    if (row?.kind === 'node' && row.topLevel) {
      return row;
    }
  }

  return undefined;
};

const holdersOf = (previousRows: TreeRow[], previousIndex: number): string[] => {
  const row = previousRows[previousIndex];
  const holders: string[] = [];

  if (row?.kind === 'thread' && row.nodeRowKey !== null) {
    holders.push(row.nodeRowKey);
  }

  const topLevel = topLevelRowOf(previousRows, previousIndex);

  if (topLevel !== undefined) {
    holders.push(topLevel.key);
  }

  return holders;
};

const selectAfterRefresh = (
  previousRows: TreeRow[],
  previousKey: string | null,
  rows: TreeRow[],
): string | null => {
  if (rows.some((row) => row.key === previousKey)) {
    return previousKey;
  }

  const previousIndex = previousRows.findIndex((row) => row.key === previousKey);

  const holder = holdersOf(previousRows, previousIndex).find((key) =>
    rows.some((row) => row.key === key),
  );

  if (holder !== undefined) {
    return holder;
  }

  const index = Math.min(Math.max(previousIndex, 0), rows.length - 1);

  return rows[index]?.key ?? null;
};

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

  const updated = { ...snapshot, threads, subjectFacts };

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
    refreshedAt: now,
    savedAt: null,
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

  const loaded = { ...start, threads };

  return {
    ...loaded,
    selectedRowKey: visibleRows(loaded)[0]?.key ?? null,
    hasLoaded: true,
    savedAt,
  };
};

export const applySubjectLookups = (snapshot: Snapshot, lookups: SubjectLookup[]): Snapshot => {
  const subjectFacts = new Map(snapshot.subjectFacts);

  for (const lookup of lookups) {
    if (lookup.facts === null) {
      subjectFacts.delete(lookup.threadId);
    } else {
      subjectFacts.set(lookup.threadId, lookup.facts);
    }
  }

  return { ...snapshot, subjectFacts };
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

const select = (snapshot: Snapshot, selectedRowKey: string | null): Snapshot => {
  if (selectedRowKey === snapshot.selectedRowKey) {
    return snapshot;
  }

  return { ...snapshot, selectedRowKey };
};

const selectedIndex = (snapshot: Snapshot, rows: TreeRow[]): number =>
  rows.findIndex((row) => row.key === snapshot.selectedRowKey);

export const moveSelection = (snapshot: Snapshot, step: 1 | -1): Snapshot => {
  const rows = visibleRows(snapshot);

  const next = Math.min(Math.max(selectedIndex(snapshot, rows) + step, 0), rows.length - 1);

  return select(snapshot, rows[next]?.key ?? null);
};

export const selectEdge = (snapshot: Snapshot, edge: 'first' | 'last'): Snapshot => {
  const rows = visibleRows(snapshot);
  const row = edge === 'first' ? rows[0] : rows.at(-1);

  return select(snapshot, row?.key ?? null);
};

export const jumpTopLevel = (snapshot: Snapshot, step: 1 | -1): Snapshot => {
  const rows = visibleRows(snapshot);
  const current = selectedIndex(snapshot, rows);
  const holder = topLevelRowOf(rows, current);
  const holderIndex = holder === undefined ? -1 : rows.indexOf(holder);
  const start = step === -1 && holderIndex >= 0 ? holderIndex : current;

  for (let index = start + step; index >= 0 && index < rows.length; index += step) {
    const row = rows[index];

    if (row?.kind === 'node' && row.topLevel) {
      return select(snapshot, row.key);
    }
  }

  return snapshot;
};

const withFolds = (snapshot: Snapshot, folds: ReadonlySet<string>): Snapshot => ({
  ...snapshot,
  foldedNodes: { ...snapshot.foldedNodes, [snapshot.grouping]: folds },
});

const nodeRowOf = (row: TreeRow): string | null => (row.kind === 'node' ? row.key : row.nodeRowKey);

const nodeKeyOf = (row: TreeRow): string | null => {
  const nodeRowKey = nodeRowOf(row);

  return nodeRowKey === null ? null : nodeRowKey.slice('node:'.length);
};

export const toggleFold = (snapshot: Snapshot): Snapshot => {
  const rows = visibleRows(snapshot);
  const row = rows[selectedIndex(snapshot, rows)];

  const nodeKey = row === undefined ? null : nodeKeyOf(row);

  if (row === undefined || nodeKey === null) {
    return snapshot;
  }

  const folds = new Set(snapshot.foldedNodes[snapshot.grouping]);

  if (!folds.delete(nodeKey)) {
    folds.add(nodeKey);
  }

  return select(withFolds(snapshot, folds), nodeRowOf(row));
};

export const toggleAllFolds = (snapshot: Snapshot): Snapshot => {
  const rows = visibleRows(snapshot);

  const topLevel = rows.filter((row): row is NodeRow => row.kind === 'node' && row.topLevel);

  const folds = new Set(snapshot.foldedNodes[snapshot.grouping]);
  const anyFolded = topLevel.some((row) => folds.has(row.nodeKey));

  for (const row of topLevel) {
    if (anyFolded) {
      folds.delete(row.nodeKey);
    } else {
      folds.add(row.nodeKey);
    }
  }

  const folded = withFolds(snapshot, folds);
  const holder = topLevelRowOf(rows, selectedIndex(snapshot, rows));

  const stillVisible = visibleRows(folded).some((row) => row.key === snapshot.selectedRowKey);

  return select(folded, stillVisible ? snapshot.selectedRowKey : (holder?.key ?? null));
};

const anchorThread = (row: TreeRow | undefined): NotificationThread | undefined =>
  row?.kind === 'thread' ? row.thread : row?.threads[0];

const deepestNodeHolding = (rows: TreeRow[], thread: NotificationThread): NodeRow | undefined => {
  const holders = rows.filter(
    (row): row is NodeRow =>
      row.kind === 'node' && row.threads.some((held) => held.id === thread.id),
  );

  return holders.toSorted((left, right) => right.depth - left.depth)[0];
};

export const cycleGrouping = (snapshot: Snapshot): Snapshot => {
  const rows = visibleRows(snapshot);
  const anchor = anchorThread(rows[selectedIndex(snapshot, rows)]);

  const next = groupings[(groupings.indexOf(snapshot.grouping) + 1) % groupings.length];

  invariant(next !== undefined, 'groupings is not empty');

  const regrouped = { ...snapshot, grouping: next };
  const nextRows = visibleRows(regrouped);

  const threadRow = nextRows.find((row) => row.kind === 'thread' && row.thread.id === anchor?.id);

  const target =
    threadRow ?? (anchor === undefined ? nextRows[0] : deepestNodeHolding(nextRows, anchor));

  return { ...regrouped, selectedRowKey: target?.key ?? null };
};

export const selectedThreadOf = (snapshot: Snapshot): NotificationThread | undefined => {
  const row = visibleRows(snapshot).find((candidate) => candidate.key === snapshot.selectedRowKey);

  return row?.kind === 'thread' ? row.thread : undefined;
};

export const hideThreads = (snapshot: Snapshot, threadIds: ReadonlySet<ThreadId>): Snapshot => {
  const rows = visibleRows(snapshot);

  const hidden = {
    ...snapshot,
    hiddenThreadIds: new Set([...snapshot.hiddenThreadIds, ...threadIds]),
  };

  const nextRows = visibleRows(hidden);
  const remainingKeys = new Set(nextRows.map((row) => row.key));

  if (snapshot.selectedRowKey !== null && remainingKeys.has(snapshot.selectedRowKey)) {
    return hidden;
  }

  const index = rows.findIndex((row) => !remainingKeys.has(row.key));
  const next = nextRows[Math.min(index, nextRows.length - 1)];

  return { ...hidden, selectedRowKey: next?.key ?? null };
};

export const showThreads = (snapshot: Snapshot, threadIds: readonly ThreadId[]): Snapshot => {
  const hiddenThreadIds = new Set(snapshot.hiddenThreadIds);

  for (const threadId of threadIds) {
    hiddenThreadIds.delete(threadId);
  }

  const shown = { ...snapshot, hiddenThreadIds };
  const rows = visibleRows(shown);
  const firstId = threadIds[0];
  const threadRow = rows.find((row) => row.kind === 'thread' && row.thread.id === firstId);
  const thread = shown.threads.find((candidate) => candidate.id === firstId);

  const target = threadRow ?? (thread === undefined ? undefined : deepestNodeHolding(rows, thread));

  return { ...shown, selectedRowKey: target?.key ?? snapshot.selectedRowKey };
};

export const releaseThreads = (snapshot: Snapshot, threadIds: ReadonlySet<ThreadId>): Snapshot => {
  const hiddenThreadIds = new Set(
    [...snapshot.hiddenThreadIds].filter((threadId) => !threadIds.has(threadId)),
  );

  return { ...snapshot, hiddenThreadIds };
};

export const openConfirmation = (snapshot: Snapshot): Snapshot => {
  const row = visibleRows(snapshot).find((candidate) => candidate.key === snapshot.selectedRowKey);

  if (row?.kind !== 'node') {
    return snapshot;
  }

  return { ...snapshot, confirmation: { threadIds: row.threads.map((thread) => thread.id) } };
};

export const closeConfirmation = (snapshot: Snapshot): Snapshot =>
  snapshot.confirmation === null ? snapshot : { ...snapshot, confirmation: null };
