import type { GitHubFailure } from '../github/github.ts';
import { invariant } from '../invariant.ts';
import type { Grouping, NodeRow, NotificationThread, TreeRow } from '../work/work.ts';
import { buildTree, flattenTree, groupings, selectOpenThreads } from '../work/work.ts';

type Notice = 'ghMissing' | 'notSignedIn';

export interface Snapshot {
  threads: NotificationThread[];
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
}

export const initialSnapshot: Snapshot = {
  threads: [],
  selectedRowKey: null,
  grouping: 'reason',
  foldedNodes: {
    reason: new Set(),
    repo: new Set(),
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
};

export const visibleRows = (snapshot: Snapshot): TreeRow[] =>
  flattenTree(
    buildTree(snapshot.threads, snapshot.grouping),
    snapshot.foldedNodes[snapshot.grouping],
  );

const selectAfterRefresh = (
  previousRows: TreeRow[],
  previousKey: string | null,
  rows: TreeRow[],
): string | null => {
  if (rows.some((row) => row.key === previousKey)) {
    return previousKey;
  }

  const previousIndex = previousRows.findIndex((row) => row.key === previousKey);
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
  now: Date,
): Snapshot => {
  const threads = selectOpenThreads(fetched);

  const updated = { ...snapshot, threads };

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

export const showSavedThreads = (saved: NotificationThread[], savedAt: Date): Snapshot => {
  const threads = selectOpenThreads(saved);

  const loaded = { ...initialSnapshot, threads };

  return {
    ...loaded,
    selectedRowKey: visibleRows(loaded)[0]?.key ?? null,
    hasLoaded: true,
    savedAt,
  };
};

export const clearAccount = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  threads: [],
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

  for (let index = current + step; index >= 0 && index < rows.length; index += step) {
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

const nodeKeyOf = (row: TreeRow): string =>
  row.kind === 'node' ? row.nodeKey : row.nodeRowKey.slice('node:'.length);

const nodeRowOf = (row: TreeRow): string => (row.kind === 'node' ? row.key : row.nodeRowKey);

export const toggleFold = (snapshot: Snapshot): Snapshot => {
  const rows = visibleRows(snapshot);
  const row = rows[selectedIndex(snapshot, rows)];

  if (row === undefined) {
    return snapshot;
  }

  const folds = new Set(snapshot.foldedNodes[snapshot.grouping]);
  const nodeKey = nodeKeyOf(row);

  if (!folds.delete(nodeKey)) {
    folds.add(nodeKey);
  }

  return select(withFolds(snapshot, folds), nodeRowOf(row));
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
