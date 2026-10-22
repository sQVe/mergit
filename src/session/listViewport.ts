import type { Snapshot } from './sessionState.ts';
import { visibleRows } from './sessionState.ts';

const scrollTop = (
  currentTop: number,
  selectedIndex: number,
  height: number,
  count: number,
): number => {
  const maximumTop = Math.max(0, count - height);
  const clamped = Math.min(currentTop, maximumTop);

  if (selectedIndex < clamped) {
    return Math.max(0, selectedIndex);
  }

  if (selectedIndex >= clamped + height) {
    return Math.min(maximumTop, selectedIndex - height + 1);
  }

  return clamped;
};

export const clampListTop = (snapshot: Snapshot): Snapshot => {
  const rows = visibleRows(snapshot);
  const selectedIndex = rows.findIndex((row) => row.key === snapshot.selectedRowKey);
  const height = Math.max(1, snapshot.listRows);
  const listTop = scrollTop(snapshot.listTop, selectedIndex, height, rows.length);

  if (listTop === snapshot.listTop) {
    return snapshot;
  }

  return { ...snapshot, listTop };
};

export const setListRows = (snapshot: Snapshot, rows: number): Snapshot => {
  if (rows === snapshot.listRows) {
    return snapshot;
  }

  return { ...snapshot, listRows: rows };
};
