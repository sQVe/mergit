import { expect, test } from 'bun:test';

import { visibleRows } from './session.ts';
import { flatHarness, makeHarness, makeThread } from './sessionHarness.ts';

const reviewThread = makeThread('1');

const mentionThread = makeThread('2', {
  reason: 'mention',
  repository: 'acme/lib',
});

const threadKeys = (session: ReturnType<typeof makeHarness>['session']): string[] =>
  visibleRows(session.getSnapshot()).map((row) => row.key);

const otherThread = makeThread('3', { repository: 'acme/other' });

test('toggleFold folds the node that holds the selected thread and moves the cursor to it', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  selectThread(reviewThread);

  expect(selected()).toBe('thread:1');

  session.send({ kind: 'toggleFold' });

  expect(session.getSnapshot().foldedNodes.reason.has('review/acme/app')).toBe(true);

  expect(selected()).toBe('node:review/acme/app');
  expect(threadKeys(session)).not.toContain('thread:1');
  expect(threadKeys(session)).toContain('thread:2');
});

test('toggleFold on a folded node unfolds it and keeps the cursor on the node', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  selectThread(reviewThread);
  session.send({ kind: 'toggleFold' });
  session.send({ kind: 'toggleFold' });

  expect(session.getSnapshot().foldedNodes.reason.size).toBe(0);
  expect(selected()).toBe('node:review/acme/app');
  expect(threadKeys(session)).toContain('thread:1');
});

test('toggleFold does nothing without rows', () => {
  const { session } = makeHarness();
  const before = session.getSnapshot();

  session.send({ kind: 'toggleFold' });

  expect(session.getSnapshot()).toBe(before);
});

test('toggleAllFolds folds every top-level node, moves the cursor into the group, then unfolds them all', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  selectThread(mentionThread);
  session.send({ kind: 'toggleAllFolds' });

  expect(threadKeys(session)).toEqual(['node:review', 'node:mention']);
  expect(selected()).toBe('node:mention');

  session.send({ kind: 'toggleAllFolds' });

  expect(session.getSnapshot().foldedNodes.reason.size).toBe(0);
  expect(selected()).toBe('node:mention');
  expect(threadKeys(session)).toHaveLength(6);
});

test('toggleAllFolds unfolds all top-level nodes when only one is folded', async () => {
  const { session, load } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'toggleFold' });
  session.send({ kind: 'toggleAllFolds' });

  expect(session.getSnapshot().foldedNodes.reason.size).toBe(0);
});

test('cycleGrouping goes reason, type, none, reason and keeps the cursor on the same thread', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  const issue = makeThread('3', {
    subjectType: 'Issue',
    repository: 'acme/lib',
  });

  await load(reviewThread, mentionThread, issue);
  selectThread(mentionThread);

  const seen: string[] = [];

  for (let step = 0; step < 3; step += 1) {
    session.send({ kind: 'cycleGrouping' });
    seen.push(session.getSnapshot().grouping);

    expect(selected()).toBe('thread:2');
  }

  expect(seen).toEqual(['type', 'none', 'reason']);
});

test('cycleGrouping from a node selects the first thread under it, then keeps that thread', async () => {
  const { session, load, selected } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'selectNextGroup' });

  expect(selected()).toBe('node:mention');

  session.send({ kind: 'cycleGrouping' });

  expect(selected()).toBe('thread:2');
});

test('cycleGrouping selects the nearest visible node when a fold hides the thread', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  selectThread(mentionThread);
  session.send({ kind: 'cycleGrouping' });
  session.send({ kind: 'toggleFold' });

  expect(selected()).toBe('node:pull-requests/acme/lib');

  for (let step = 0; step < 2; step += 1) {
    session.send({ kind: 'cycleGrouping' });
  }

  expect(session.getSnapshot().grouping).toBe('reason');
  expect(selected()).toBe('thread:2');

  session.send({ kind: 'cycleGrouping' });

  expect(session.getSnapshot().grouping).toBe('type');
  expect(selected()).toBe('node:pull-requests/acme/lib');
});

test('a fold in one grouping does not fold a node in another', async () => {
  const { session, load, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'cycleGrouping' });
  selectThread(reviewThread);
  session.send({ kind: 'toggleFold' });
  session.send({ kind: 'cycleGrouping' });
  session.send({ kind: 'cycleGrouping' });

  expect(session.getSnapshot().grouping).toBe('reason');

  expect(session.getSnapshot().foldedNodes.type.has('pull-requests/acme/app')).toBe(true);

  expect(session.getSnapshot().foldedNodes.reason.size).toBe(0);
  expect(threadKeys(session)).toContain('thread:1');
});

test('none lists only thread rows in input order', async () => {
  const { session } = await flatHarness(reviewThread, mentionThread, otherThread);

  expect(session.getSnapshot().grouping).toBe('none');
  expect(threadKeys(session)).toEqual(['thread:1', 'thread:2', 'thread:3']);
});

test('group jumps and folds change nothing in none and do not throw', async () => {
  const { session, selected, selectThread } = await flatHarness(
    reviewThread,
    mentionThread,
    otherThread,
  );

  selectThread(mentionThread);

  const before = session.getSnapshot();

  for (const kind of ['selectNextGroup', 'selectPreviousGroup', 'toggleAllFolds', 'toggleFold']) {
    session.send({ kind } as Parameters<typeof session.send>[0]);

    expect(selected()).toBe('thread:2');
    expect(session.getSnapshot().foldedNodes).toEqual(before.foldedNodes);
    expect(threadKeys(session)).toEqual(['thread:1', 'thread:2', 'thread:3']);
  }
});
