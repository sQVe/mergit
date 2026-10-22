import { expect, test } from 'bun:test';

import { makeHarness } from './sessionHarness.ts';

test('openCommandLine opens the line with empty text, and editCommandLine sets the text', () => {
  const { session } = makeHarness();

  session.send({ kind: 'openCommandLine' });
  session.send({ kind: 'editCommandLine', text: 'mess' });

  expect(session.getSnapshot().commandLineOpen).toBe(true);
  expect(session.getSnapshot().commandLineText).toBe('mess');
});

test('closeCommandLine closes the line and clears the text', () => {
  const { session } = makeHarness();

  session.send({ kind: 'openCommandLine' });
  session.send({ kind: 'editCommandLine', text: 'mess' });
  session.send({ kind: 'closeCommandLine' });

  expect(session.getSnapshot().commandLineOpen).toBe(false);
  expect(session.getSnapshot().commandLineText).toBe('');
});

test('reportUnknownCommand closes the line and shows an error toast naming the command', () => {
  const { session } = makeHarness();

  session.send({ kind: 'openCommandLine' });
  session.send({ kind: 'editCommandLine', text: 'foo' });
  session.send({ kind: 'reportUnknownCommand', name: 'foo' });

  const snapshot = session.getSnapshot();

  expect(snapshot.commandLineOpen).toBe(false);
  expect(snapshot.commandLineText).toBe('');
  expect(snapshot.toast?.tone).toBe('error');
  expect(snapshot.toast?.title).toContain('foo');
});

test('reportCancelledKeys shows an info toast naming the keys and changes nothing else', () => {
  const { session } = makeHarness();
  const before = session.getSnapshot();

  session.send({ kind: 'reportCancelledKeys', keys: 'z/' });

  const snapshot = session.getSnapshot();

  expect(snapshot.toast?.tone).toBe('info');
  expect(snapshot.toast?.title).toBe('Cancelled z/');
  expect(snapshot.toast?.lines).toEqual([]);
  expect(snapshot.searchOpen).toBe(before.searchOpen);
  expect(snapshot.selectedRowKey).toBe(before.selectedRowKey);
});
