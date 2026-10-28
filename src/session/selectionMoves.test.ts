import { expect, test } from 'bun:test';

import { adjacentThreadRowOf } from './session.ts';
import { flatHarness, makeHarness, makeThread } from './sessionHarness.ts';

const reviewThread = makeThread('1');

const mentionThread = makeThread('2', {
  reason: 'mention',
  repository: 'acme/lib',
});

const otherThread = makeThread('3', { repository: 'acme/other' });

test('selectNext and selectPrevious move one row and stop at the ends', async () => {
  const { session, load, selected } = makeHarness();

  const [a, b, c] = [makeThread('1'), makeThread('2'), makeThread('3')] as const;

  await load(a, b, c);
  session.send({ kind: 'selectPrevious' });

  expect(selected()).toBe('node:review');

  session.send({ kind: 'selectNext' });

  expect(selected()).toBe('node:review/acme/app');

  session.send({ kind: 'selectNext' });
  session.send({ kind: 'selectNext' });
  session.send({ kind: 'selectNext' });
  session.send({ kind: 'selectNext' });

  expect(selected()).toBe(`thread:${c.id}`);

  session.send({ kind: 'selectPrevious' });

  expect(selected()).toBe(`thread:${b.id}`);
});

test('selectFirst and selectLast select the first and last visible rows', async () => {
  const { session, load, selected } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'selectLast' });

  expect(selected()).toBe('thread:2');

  session.send({ kind: 'selectFirst' });

  expect(selected()).toBe('node:review');
});

test('selectNextGroup and selectPreviousGroup move between top-level groups and stop at the ends', async () => {
  const { session, load, selected } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'selectPreviousGroup' });

  expect(selected()).toBe('node:review');

  session.send({ kind: 'selectNextGroup' });

  expect(selected()).toBe('node:mention');

  session.send({ kind: 'selectNextGroup' });

  expect(selected()).toBe('node:mention');

  session.send({ kind: 'selectPreviousGroup' });

  expect(selected()).toBe('node:review');
});

test('selectPreviousGroup from a thread in the second group selects the first group row', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  selectThread(mentionThread);
  session.send({ kind: 'selectPreviousGroup' });

  expect(selected()).toBe('node:review');
});

test('j, k, g, and G move over thread rows in none', async () => {
  const { session, selected } = await flatHarness(reviewThread, mentionThread, otherThread);

  session.send({ kind: 'selectFirst' });

  expect(selected()).toBe('thread:1');

  session.send({ kind: 'selectNext' });

  expect(selected()).toBe('thread:2');

  session.send({ kind: 'selectLast' });

  expect(selected()).toBe('thread:3');

  session.send({ kind: 'selectPrevious' });

  expect(selected()).toBe('thread:2');
});

test('a counted selectNext and selectPrevious move that many rows and clamp at the ends', async () => {
  const { session, load, selected } = makeHarness();

  const [a, b] = [makeThread('1'), makeThread('2')] as const;

  await load(a, b);
  session.send({ kind: 'selectNext', count: 2 });

  expect(selected()).toBe('thread:1');

  session.send({ kind: 'selectNext', count: 9999 });

  expect(selected()).toBe(`thread:${b.id}`);

  session.send({ kind: 'selectPrevious', count: 3 });

  expect(selected()).toBe('node:review');

  session.send({ kind: 'selectPrevious', count: 9999 });

  expect(selected()).toBe('node:review');
});

test('a counted selectLast selects that visible row and clamps at the last row', async () => {
  const { session, load, selected } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'selectLast', count: 2 });

  expect(selected()).toBe('node:review/acme/app');

  session.send({ kind: 'selectLast', count: 9999 });

  expect(selected()).toBe('thread:2');
});

test('a counted selectFirst selects that visible row and clamps at the last row', async () => {
  const { session, load, selected } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'selectFirst', count: 3 });

  expect(selected()).toBe('thread:1');

  session.send({ kind: 'selectFirst', count: 9999 });

  expect(selected()).toBe('thread:2');
});

test('adjacentThreadRowOf crosses from one group onto the next group thread row and stops at the ends', async () => {
  const { session, load } = makeHarness();

  const [first, second, third] = [
    makeThread('1'),
    makeThread('2', { reason: 'mention' }),
    makeThread('3', { reason: 'mention' }),
  ] as const;

  await load(first, second, third);

  const snapshot = session.getSnapshot();

  expect(adjacentThreadRowOf(snapshot, first.id, 1)?.thread.id).toBe(second.id);
  expect(adjacentThreadRowOf(snapshot, second.id, -1)?.thread.id).toBe(first.id);
  expect(adjacentThreadRowOf(snapshot, third.id, 1)).toBeUndefined();
  expect(adjacentThreadRowOf(snapshot, first.id, -1)).toBeUndefined();
});

test('adjacentThreadRowOf skips the threads of a folded group', async () => {
  const { session, load, selectThread } = makeHarness();

  const [first, second, third, fourth] = [
    makeThread('1'),
    makeThread('2', { reason: 'mention' }),
    makeThread('3', { reason: 'mention' }),
    makeThread('4', { reason: 'assign' }),
  ] as const;

  await load(first, second, third, fourth);
  selectThread(first);
  session.send({ kind: 'selectNextGroup' });
  session.send({ kind: 'closeFold' });

  const snapshot = session.getSnapshot();

  expect(adjacentThreadRowOf(snapshot, first.id, 1)?.thread.id).toBe(fourth.id);
  expect(adjacentThreadRowOf(snapshot, fourth.id, -1)?.thread.id).toBe(first.id);
  expect(adjacentThreadRowOf(snapshot, second.id, 1)).toBeUndefined();
});

test('selectRow selects a visible row and ignores a row key that is not visible', async () => {
  const { session, load, selected, selectThread } = makeHarness();

  await load(reviewThread, mentionThread);
  session.send({ kind: 'selectRow', rowKey: `thread:${mentionThread.id}` });

  expect(selected()).toBe(`thread:${mentionThread.id}`);

  selectThread(reviewThread);
  session.send({ kind: 'selectRow', rowKey: 'thread:missing' });

  expect(selected()).toBe(`thread:${reviewThread.id}`);
});
