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
  const { session, selected } = await flatHarness();

  session.send({ kind: 'selectFirst' });

  expect(selected()).toBe('thread:1');

  session.send({ kind: 'selectNext' });

  expect(selected()).toBe('thread:2');

  session.send({ kind: 'selectLast' });

  expect(selected()).toBe('thread:3');

  session.send({ kind: 'selectPrevious' });

  expect(selected()).toBe('thread:2');
});
