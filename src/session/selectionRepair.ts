import type { NodeRow, NotificationThread, TreeRow } from '../work/work.ts';

export const topLevelRowOf = (rows: TreeRow[], index: number): NodeRow | undefined => {
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

export const selectAfterRefresh = (
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

export const deepestNodeHolding = (
  rows: TreeRow[],
  thread: NotificationThread,
): NodeRow | undefined => {
  const holders = rows.filter(
    (row): row is NodeRow =>
      row.kind === 'node' && row.threads.some((held) => held.id === thread.id),
  );

  return holders.toSorted((left, right) => right.depth - left.depth)[0];
};
