import { expect, test } from 'bun:test';

import { visibleRows } from './session.ts';
import type { createSession } from './session.ts';
import {
  failure,
  fireDoneTimerAt,
  makeHarness,
  makeThread,
  markSelectedDone,
  rowKeysOf,
  settle,
} from './sessionHarness.ts';

test('done hides the selected thread and the next thread takes its row', async () => {
  const harness = makeHarness();
  const [one, two, three] = [makeThread('1'), makeThread('2'), makeThread('3')];

  await harness.load(one, two, three);
  harness.selectThread(two);
  harness.session.send({ kind: 'markDone' });

  expect(rowKeysOf(harness.session)).not.toContain(`thread:${two.id}`);
  expect(harness.selected()).toBe(`thread:${three.id}`);
});

test('done on the last thread of a group selects the row now at its index', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2', { reason: 'mention' })];

  await harness.load(one, two);
  harness.selectThread(two);

  const index = rowKeysOf(harness.session).indexOf(`thread:${two.id}`);

  harness.session.send({ kind: 'markDone' });

  const rows = rowKeysOf(harness.session);

  expect(rows).not.toContain(`thread:${two.id}`);

  expect(harness.selected()).toBe(rows[Math.min(index, rows.length - 1)] ?? null);

  expect(harness.selected()).toBe(`thread:${one.id}`);
});

test('done on a thread that ends its group selects the next group row', async () => {
  const harness = makeHarness();

  const [one, two, three] = [
    makeThread('1'),
    makeThread('2'),
    makeThread('3', { reason: 'mention' }),
  ];

  await harness.load(one, two, three);
  harness.selectThread(two);

  const rowsBefore = rowKeysOf(harness.session);
  const index = rowsBefore.indexOf(`thread:${two.id}`);

  harness.session.send({ kind: 'markDone' });

  expect(harness.selected()).toBe(rowKeysOf(harness.session)[index] ?? null);
  expect(harness.selected()).not.toBe(`thread:${two.id}`);
  expect(harness.selected()).not.toBeNull();
});

const selectedNodeThreadIds = (harness: ReturnType<typeof makeHarness>) => {
  const snapshot = harness.session.getSnapshot();
  const row = visibleRows(snapshot).find((candidate) => candidate.key === snapshot.selectedRowKey);

  return row?.kind === 'node' ? row.threads.map((thread) => thread.id) : [];
};

const markNodeAt = async (steps: number, fold: boolean) => {
  const harness = makeHarness();

  await harness.load(
    makeThread('1', { repository: 'acme/app' }),
    makeThread('2', { repository: 'acme/app' }),
    makeThread('3', { repository: 'acme/lib' }),
    makeThread('4', { reason: 'mention', repository: 'acme/other' }),
  );

  harness.session.send({ kind: 'selectFirst' });

  for (let step = 0; step < steps; step += 1) {
    harness.session.send({ kind: 'selectNext' });
  }

  if (fold) {
    harness.session.send({ kind: 'toggleFold' });
  }

  harness.session.send({ kind: 'markThreadsDone', threadIds: selectedNodeThreadIds(harness) });

  return harness.session.getSnapshot();
};

const selectionIsShown = (
  snapshot: ReturnType<typeof createSession>['getSnapshot'] extends () => infer S ? S : never,
) => visibleRows(snapshot).some((row) => row.key === snapshot.selectedRowKey);

test('marking done on a folded repo node selects a remaining row', async () => {
  const snapshot = await markNodeAt(1, true);

  expect(snapshot.selectedRowKey).not.toBeNull();
  expect(selectionIsShown(snapshot)).toBe(true);
});

test('marking done on a folded group node selects a remaining row', async () => {
  const snapshot = await markNodeAt(0, true);

  expect(snapshot.selectedRowKey).not.toBeNull();
  expect(selectionIsShown(snapshot)).toBe(true);
});

test('marking done on an unfolded node selects a remaining row', async () => {
  const snapshot = await markNodeAt(1, false);

  expect(snapshot.selectedRowKey).not.toBeNull();
  expect(selectionIsShown(snapshot)).toBe(true);
});

test('marking done on an unfolded node that a refresh grew keeps the node selected', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];

  await harness.load(one);
  harness.session.send({ kind: 'selectFirst' });

  const selected = harness.session.getSnapshot().selectedRowKey;
  const threadIds = selectedNodeThreadIds(harness);

  await harness.load(one, two);
  harness.session.send({ kind: 'markThreadsDone', threadIds });

  expect(selected).not.toBeNull();
  expect(harness.session.getSnapshot().selectedRowKey).toBe(selected);
});

test('marking done on a folded node that a refresh grew keeps the node selected', async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];

  await harness.load(one);
  harness.session.send({ kind: 'selectFirst' });
  harness.session.send({ kind: 'toggleFold' });

  const selected = harness.session.getSnapshot().selectedRowKey;
  const threadIds = selectedNodeThreadIds(harness);

  await harness.load(one, two);
  harness.session.send({ kind: 'markThreadsDone', threadIds });

  expect(selected).not.toBeNull();
  expect(harness.session.getSnapshot().selectedRowKey).toBe(selected);
});

test('undo of a thread alone in a folded group selects that group row after the selection moved elsewhere', async () => {
  const harness = makeHarness();
  const other = makeThread('1');
  const target = makeThread('2', { reason: 'mention', repository: 'acme/lib' });

  await harness.load(other, target);
  harness.session.send({ kind: 'selectLast' });
  harness.session.send({ kind: 'selectPreviousGroup' });
  harness.selectThread(target);
  harness.session.send({ kind: 'selectPrevious' });

  const groupKey = harness.selected();

  expect(groupKey).toBe('node:mention/acme/lib');

  harness.session.send({ kind: 'toggleFold' });
  harness.session.send({ kind: 'markThreadsDone', threadIds: [target.id] });

  expect(harness.selected()).not.toBe(groupKey);

  harness.session.send({ kind: 'undoDone' });

  const snapshot = harness.session.getSnapshot();

  expect(rowKeysOf(harness.session)).not.toContain(`thread:${target.id}`);
  expect(snapshot.selectedRowKey).toBe(groupKey);
});

test('undo of a thread that a refresh dropped keeps the current selection', async () => {
  const harness = makeHarness();
  const [one, two, three] = [makeThread('1'), makeThread('2'), makeThread('3')];

  await harness.load(one, two, three);
  harness.selectThread(two);
  harness.session.send({ kind: 'markDone' });
  await harness.loadWith('fresh', [one, three]);
  harness.selectThread(one);
  harness.session.send({ kind: 'undoDone' });

  expect(harness.selected()).toBe(`thread:${one.id}`);
  expect(rowKeysOf(harness.session)).not.toContain(`thread:${two.id}`);
});

const foldedGroupHarness = async () => {
  const harness = makeHarness();
  const [one, two] = [makeThread('1'), makeThread('2')];

  await harness.load(one, two);
  harness.selectThread(one);

  return { harness };
};

const expectFoldedHolder = (harness: ReturnType<typeof makeHarness>) => {
  const snapshot = harness.session.getSnapshot();
  const keys = visibleRows(snapshot).map((row) => row.key);

  expect(snapshot.foldedNodes.reason.has('review/acme/app')).toBe(true);
  expect(keys).toContain(snapshot.selectedRowKey ?? '');
  expect(snapshot.selectedRowKey).toBe('node:review/acme/app');
};

test('undo of a done thread whose group was folded selects the group row and keeps the fold', async () => {
  const { harness } = await foldedGroupHarness();

  markSelectedDone(harness);
  harness.selectThread(makeThread('2'));
  harness.session.send({ kind: 'toggleFold' });
  harness.session.send({ kind: 'undoDone' });

  expectFoldedHolder(harness);
});

test('a failed send of a thread whose group was folded selects the group row', async () => {
  const { harness } = await foldedGroupHarness();
  const before = markSelectedDone(harness);

  harness.selectThread(makeThread('2'));
  harness.session.send({ kind: 'toggleFold' });
  await fireDoneTimerAt(harness, before);
  harness.sends[0]?.resolve(failure('Boom'));
  await settle();

  expectFoldedHolder(harness);
});

test('undo of a done thread that is not first in its unfolded group selects its own row', async () => {
  const harness = makeHarness();
  const [one, two, three] = [makeThread('1'), makeThread('2'), makeThread('3')];

  await harness.load(one, two, three);
  harness.selectThread(two);
  markSelectedDone(harness);
  harness.selectThread(one);
  harness.session.send({ kind: 'undoDone' });

  expect(harness.selected()).toBe(`thread:${two.id}`);
});
