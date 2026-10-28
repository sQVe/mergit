import type { NotificationThread, ThreadId, ThreadRow, TreeRow } from '../work/work.ts';
import { topLevelRowOf } from './selectionRepair.ts';
import type { Snapshot } from './sessionState.ts';
import { visibleRows } from './sessionState.ts';

export const select = (snapshot: Snapshot, selectedRowKey: string | null): Snapshot => {
  if (selectedRowKey === snapshot.selectedRowKey) {
    return snapshot;
  }

  return { ...snapshot, selectedRowKey };
};

export const selectedIndex = (snapshot: Snapshot, rows: TreeRow[]): number =>
  rows.findIndex((row) => row.key === snapshot.selectedRowKey);

export const moveSelection = (snapshot: Snapshot, step: number): Snapshot => {
  const rows = visibleRows(snapshot);

  const next = Math.min(Math.max(selectedIndex(snapshot, rows) + step, 0), rows.length - 1);

  return select(snapshot, rows[next]?.key ?? null);
};

export const selectRowNumber = (snapshot: Snapshot, rowNumber: number): Snapshot => {
  const rows = visibleRows(snapshot);
  const index = Math.min(Math.max(rowNumber, 1), rows.length) - 1;

  return select(snapshot, rows[index]?.key ?? null);
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

export const selectRowKey = (snapshot: Snapshot, rowKey: string): Snapshot => {
  const isVisible = visibleRows(snapshot).some((row) => row.key === rowKey);

  return isVisible ? select(snapshot, rowKey) : snapshot;
};

export const adjacentThreadRowOf = (
  snapshot: Snapshot,
  threadId: ThreadId,
  step: 1 | -1,
): ThreadRow | undefined => {
  const rows = visibleRows(snapshot);
  const current = rows.findIndex((row) => row.kind === 'thread' && row.thread.id === threadId);

  if (current === -1) {
    return undefined;
  }

  for (let index = current + step; index >= 0 && index < rows.length; index += step) {
    const row = rows[index];

    if (row?.kind === 'thread') {
      return row;
    }
  }

  return undefined;
};

export const selectedThreadOf = (snapshot: Snapshot): NotificationThread | undefined => {
  const row = visibleRows(snapshot).find((candidate) => candidate.key === snapshot.selectedRowKey);

  return row?.kind === 'thread' ? row.thread : undefined;
};
