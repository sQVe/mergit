import { expect, test } from 'bun:test';

import { makeHarness, makeThread } from './sessionHarness.ts';

const reviewThread = makeThread('1');

const mentionThread = makeThread('2', {
  reason: 'mention',
  repository: 'acme/lib',
});

const otherThread = makeThread('3', { repository: 'acme/other' });

const flatHarness = async () => {
  const harness = makeHarness();

  await harness.load(reviewThread, mentionThread, otherThread);
  harness.session.send({ kind: 'cycleGrouping' });
  harness.session.send({ kind: 'cycleGrouping' });

  return harness;
};

test('selection stays on the same thread across a refresh that reorders threads', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  const [a, b, c] = [makeThread('1'), makeThread('2'), makeThread('3')] as const;

  await load(a, b, c);
  selectThread(b);
  await load(c, b, a);

  expect(selected()).toBe(`thread:${b.id}`);

  session.send({ kind: 'selectNext' });
  await load(b, a, c);

  expect(selected()).toBe(`thread:${a.id}`);
});

test('when the selected thread and its group leave, the row now at its index is selected', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  const first = makeThread('1');
  const mention = makeThread('2', { reason: 'mention' });

  await load(first, mention);
  selectThread(mention);
  await load(first);

  expect(selected()).toBe(`thread:${first.id}`);

  await load();

  expect(selected()).toBeNull();
  expect(session.getSnapshot().hasLoaded).toBe(true);

  session.send({ kind: 'selectNext' });

  expect(selected()).toBeNull();
});

test('a refresh keeps the grouping, the folds, and the selected row', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'cycleGrouping' });
  selectThread(mentionThread);
  session.send({ kind: 'selectPrevious' });
  session.send({ kind: 'toggleFold' });
  session.send({ kind: 'selectFirst' });
  session.send({ kind: 'toggleFold' });
  session.send({ kind: 'selectNext' });

  const key = selected();

  await load(reviewThread, mentionThread);

  expect(session.getSnapshot().grouping).toBe('type');

  expect([...session.getSnapshot().foldedNodes.type].toSorted()).toEqual([
    'pull-requests',
    'pull-requests/acme/lib',
  ]);

  expect(selected()).toBe(key);
});

test('a refresh that removes the selected thread selects its repo row while the repo remains', async () => {
  const { load, selected, selectThread } = makeHarness();
  const second = makeThread('3');

  await load(reviewThread, second, mentionThread);
  selectThread(second);

  expect(selected()).toBe('thread:3');

  await load(reviewThread, mentionThread);

  expect(selected()).toBe('node:review/acme/app');
});

test('a refresh that removes the selected thread and its repo selects the group row', async () => {
  const { load, selected, selectThread } = makeHarness();
  const other = makeThread('4', { repository: 'acme/other' });

  await load(reviewThread, other, mentionThread);
  selectThread(other);

  expect(selected()).toBe('thread:4');

  await load(reviewThread, mentionThread);

  expect(selected()).toBe('node:review');
});

test('a refresh in none keeps the selected thread, or falls back to the row index', async () => {
  const { load, selected, selectThread } = await flatHarness();

  selectThread(mentionThread);
  await load(mentionThread, reviewThread);

  expect(selected()).toBe('thread:2');

  await load(reviewThread, mentionThread, otherThread);
  selectThread(mentionThread);
  await load(reviewThread, otherThread);

  expect(selected()).toBe('thread:3');
});
