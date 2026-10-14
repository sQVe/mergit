import { expect, test } from 'bun:test';

import { factsOf, makeHarness, makeThread, settle } from './sessionHarness.ts';

test('the snapshot lists threads before the lookup resolves and holds the facts after', async () => {
  const { session, load, lookups } = makeHarness();
  const thread = makeThread('1');

  await load(thread);

  expect(session.getSnapshot().threads).toEqual([thread]);
  expect(session.getSnapshot().subjectFacts.size).toBe(0);
  expect(lookups).toHaveLength(1);
  expect(lookups[0]?.threads).toEqual([thread]);

  lookups[0]?.resolve([factsOf(thread)]);
  await settle();

  expect(session.getSnapshot().threads).toEqual([thread]);

  expect(session.getSnapshot().subjectFacts.get(thread.id)).toEqual({
    state: 'open',
    author: 'hubot',
    latestActor: null,
  });
});

test('a second refresh sends only threads with a new updated_at', async () => {
  const { load, lookups } = makeHarness();
  const first = makeThread('1');
  const second = makeThread('2');

  await load(first, second);
  lookups[0]?.resolve([factsOf(first), factsOf(second)]);
  await settle();

  await load(first, second);

  expect(lookups).toHaveLength(1);

  const changedSecond = makeThread('2', { updatedAt: '2026-01-03T10:00:00Z' });

  await load(first, changedSecond);

  expect(lookups).toHaveLength(2);
  expect(lookups[1]?.threads).toEqual([changedSecond]);
});

test('a result for a thread whose updated_at changed during the lookup is dropped', async () => {
  const { session, load, lookups } = makeHarness();
  const thread = makeThread('1');
  const changedThread = makeThread('1', { updatedAt: '2026-01-03T10:00:00Z' });

  await load(thread);
  await load(changedThread);

  expect(lookups).toHaveLength(2);

  lookups[0]?.resolve([factsOf(thread, 'stale')]);
  await settle();

  expect(session.getSnapshot().subjectFacts.size).toBe(0);

  lookups[1]?.resolve([factsOf(changedThread, 'fresh')]);
  await settle();

  expect(session.getSnapshot().subjectFacts.get(thread.id)?.author).toBe('fresh');
});

test('a lookup that rejects keeps the threads and sends them again on the next refresh', async () => {
  const { session, load, lookups } = makeHarness();
  const first = makeThread('1');
  const second = makeThread('2');

  await load(first, second);
  lookups[0]?.reject(new Error('network down'));
  await settle();

  expect(session.getSnapshot().threads).toEqual([first, second]);
  expect(session.getSnapshot().subjectFacts.size).toBe(0);

  await load(first, second);

  expect(lookups).toHaveLength(2);
  expect(lookups[1]?.threads).toEqual([first, second]);
});

test('a thread that changed has unknown facts until its lookup answers, and after it fails', async () => {
  const { session, load, lookups } = makeHarness();
  const thread = makeThread('1');
  const changedThread = makeThread('1', { updatedAt: '2026-01-03T10:00:00Z' });

  await load(thread);
  lookups[0]?.resolve([factsOf(thread)]);
  await settle();

  await load(changedThread);

  expect(session.getSnapshot().subjectFacts.size).toBe(0);

  lookups[1]?.resolve([]);
  await settle();

  expect(session.getSnapshot().threads).toEqual([changedThread]);
  expect(session.getSnapshot().subjectFacts.size).toBe(0);
});

test('a thread answered with null facts stays listed and is not sent again', async () => {
  const { session, load, lookups } = makeHarness();
  const thread = makeThread('1');

  await load(thread);

  lookups[0]?.resolve([{ threadId: thread.id, updatedAt: thread.updatedAt, facts: null }]);

  await settle();

  expect(session.getSnapshot().threads).toEqual([thread]);
  expect(session.getSnapshot().subjectFacts.size).toBe(0);

  await load(thread);

  expect(lookups).toHaveLength(1);
});

test('stop aborts a running lookup and drops its result', async () => {
  const { session, load, lookups } = makeHarness();
  const thread = makeThread('1');

  await load(thread);
  await session.stop(new AbortController().signal);

  expect(lookups[0]?.signal.aborted).toBe(true);

  lookups[0]?.resolve([factsOf(thread)]);
  await settle();

  expect(session.getSnapshot().subjectFacts.size).toBe(0);
});
