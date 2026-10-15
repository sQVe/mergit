import { invariant } from '../invariant.ts';
import type { NodeRow, NotificationThread, TreeRow } from '../work/work.ts';
import { groupings } from '../work/work.ts';
import { select, selectedIndex } from './selectionMoves.ts';
import { deepestNodeHolding, topLevelRowOf } from './selectionRepair.ts';
import type { Snapshot } from './sessionState.ts';
import { visibleRows } from './sessionState.ts';

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
