import { select, selectedIndex as indexOfSelected, selectRowNumber } from './selectionMoves.ts';
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

const clampBetween = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum);

export const scrollPage = (
  snapshot: Snapshot,
  direction: 'down' | 'up',
  size: 'half' | 'full',
  count: number | undefined,
): Snapshot => {
  const rows = visibleRows(snapshot);
  const height = Math.max(1, snapshot.listRows);

  const distance =
    size === 'half' ? (count ?? Math.max(1, Math.floor(height / 2))) : (count ?? 1) * height;

  const step = direction === 'down' ? distance : -distance;

  const listTop = Math.max(0, snapshot.listTop + step);
  const index = clampBetween(indexOfSelected(snapshot, rows) + step, 0, rows.length - 1);

  return { ...select(snapshot, rows[index]?.key ?? null), listTop };
};

export const placeSelectedRow = (
  snapshot: Snapshot,
  position: 'center' | 'top' | 'bottom',
  count: number | undefined,
): Snapshot => {
  const selected = count === undefined ? snapshot : selectRowNumber(snapshot, count);
  const rows = visibleRows(selected);
  const height = Math.max(1, selected.listRows);
  const index = Math.max(0, indexOfSelected(selected, rows));

  const tops = {
    top: index,
    center: index - Math.floor((height - 1) / 2),
    bottom: index - height + 1,
  };

  const listTop = Math.max(0, tops[position]);

  return { ...selected, listTop };
};
