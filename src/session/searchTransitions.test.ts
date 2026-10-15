import { expect, test } from 'bun:test';

import type { NotificationThread } from '../work/work.ts';
import { makeHarness, makeThread, rowKeysOf, threadKeysOf } from './sessionHarness.ts';

const queryThreads = () => [
  makeThread('1', { title: 'Fix parser', reason: 'review_requested', repository: 'acme/app' }),
  makeThread('2', { title: 'Fix lexer', reason: 'review_requested', repository: 'acme/lib' }),
  makeThread('3', { title: 'Docs', reason: 'review_requested', repository: 'acme/tools' }),
  makeThread('4', { title: 'Tidy', reason: 'mention', repository: 'acme/app' }),
];

test('openSearch opens the line and keepSearch closes it with the text applied', async () => {
  const { session, load } = makeHarness();

  await load(...queryThreads());
  session.send({ kind: 'openSearch' });

  expect(session.getSnapshot().searchOpen).toBe(true);

  session.send({ kind: 'editSearch', text: 'docs' });
  session.send({ kind: 'keepSearch' });

  expect(session.getSnapshot().searchOpen).toBe(false);
  expect(session.getSnapshot().searchText).toBe('docs');
  expect(threadKeysOf(session)).toEqual(['thread:3']);
});

test('restoreSearch closes the line and brings back the earlier text', async () => {
  const { session, load } = makeHarness();

  await load(...queryThreads());
  session.send({ kind: 'editSearch', text: 'fix' });
  session.send({ kind: 'openSearch' });
  session.send({ kind: 'editSearch', text: 'docs' });
  session.send({ kind: 'restoreSearch' });

  const snapshot = session.getSnapshot();

  expect(snapshot.searchOpen).toBe(false);
  expect(snapshot.searchText).toBe('fix');
  expect(threadKeysOf(session)).toEqual(['thread:1', 'thread:2']);
});

test('keepSearch on an empty line closes it with no text applied', async () => {
  const { session, load } = makeHarness();

  await load(...queryThreads());
  session.send({ kind: 'editSearch', text: 'fix' });
  session.send({ kind: 'openSearch' });
  session.send({ kind: 'editSearch', text: '' });
  session.send({ kind: 'keepSearch' });

  expect(session.getSnapshot().searchOpen).toBe(false);
  expect(session.getSnapshot().searchText).toBe('');
  expect(threadKeysOf(session)).toEqual(['thread:1', 'thread:2', 'thread:3', 'thread:4']);
});

test('a blank search shows every thread', async () => {
  const { session, load } = makeHarness();

  await load(...queryThreads());
  session.send({ kind: 'editSearch', text: '  ' });

  expect(threadKeysOf(session)).toEqual(['thread:1', 'thread:2', 'thread:3', 'thread:4']);
});

test('clearSearch clears the text and shows every thread', async () => {
  const { session, load } = makeHarness();

  await load(...queryThreads());
  session.send({ kind: 'editSearch', text: 'fix' });
  session.send({ kind: 'editSearch', text: 'fix lexer' });
  session.send({ kind: 'clearSearch' });

  expect(session.getSnapshot().searchText).toBe('');
  expect(threadKeysOf(session)).toEqual(['thread:1', 'thread:2', 'thread:3', 'thread:4']);
});

test('a search that hides the selected row moves the selection to a visible row', async () => {
  const { session, load, selectThread } = makeHarness();
  const threads = queryThreads();

  await load(...threads);
  selectThread(threads[3] as NotificationThread);
  session.send({ kind: 'editSearch', text: 'fix' });

  const keys = rowKeysOf(session);

  expect(keys).toContain(session.getSnapshot().selectedRowKey ?? '');
});
