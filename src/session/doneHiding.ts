import type { ThreadId } from '../work/work.ts';
import { deepestNodeHolding } from './selectionRepair.ts';
import type { Snapshot } from './sessionState.ts';
import { visibleRows } from './sessionState.ts';

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
