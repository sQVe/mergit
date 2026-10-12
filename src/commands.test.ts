import { expect, test } from 'bun:test';

import { catalog } from './commands.ts';
import { createSession } from './session/session.ts';
import { toThreadId, toViewerLogin } from './work/work.ts';

const idleEffects = {
  savedSnapshot: null,
  savedGrouping: null,
  saveGrouping: () => undefined,
  stateWarning: null,
  readViewer: () =>
    Promise.resolve({ ok: true as const, value: { login: toViewerLogin('octocat'), etag: null } }),
  saveSnapshot: () => undefined,
  pollFeed: () =>
    Promise.resolve({
      ok: true as const,
      value: { kind: 'unchanged' as const, pollInterval: null },
    }),
  readFeed: () =>
    Promise.resolve({
      ok: true as const,
      value: { feed: { pages: [] }, threads: [], pollInterval: null },
    }),
  verifyFeed: () =>
    Promise.resolve({ ok: true as const, value: { kind: 'stable' as const, pollInterval: null } }),
  now: () => new Date(0),
  setTimer: () => () => undefined,
};

const snapshot = createSession(idleEffects).getSnapshot();

test('quit returns a terminal intent and help returns a UI intent', () => {
  const intents = Object.fromEntries(
    catalog.map((command) => [command.id, command.intent(snapshot)]),
  );

  expect(intents['quit']).toEqual({ kind: 'terminal', action: 'quit' });
  expect(intents['help']).toEqual({ kind: 'ui', action: 'toggleHelp' });
});

test('list commands return the matching application intents on j, k, and r', () => {
  const byId = Object.fromEntries(catalog.map((command) => [command.id, command]));

  expect(byId['selectNext']?.keys).toEqual(['j', 'down']);
  expect(byId['selectPrevious']?.keys).toEqual(['k', 'up']);
  expect(byId['refresh']?.keys).toEqual(['r']);

  expect(byId['selectNext']?.intent(snapshot)).toEqual({
    kind: 'application',
    intent: { kind: 'selectNext' },
  });

  expect(byId['selectPrevious']?.intent(snapshot)).toEqual({
    kind: 'application',
    intent: { kind: 'selectPrevious' },
  });

  expect(byId['refresh']?.intent(snapshot)).toEqual({
    kind: 'application',
    intent: { kind: 'refresh' },
  });
});

test('tree commands list their keys and return their intents', () => {
  const byId = Object.fromEntries(catalog.map((command) => [command.id, command]));

  const expected = [
    ['selectFirst', ['g'], 'selectFirst'],
    ['selectLast', ['shift+g'], 'selectLast'],
    ['selectNextGroup', ['shift+j'], 'selectNextGroup'],
    ['selectPreviousGroup', ['shift+k'], 'selectPreviousGroup'],
    ['toggleFold', ['z', 'space'], 'toggleFold'],
    ['toggleNodeFold', ['return'], 'toggleFold'],
    ['toggleAllFolds', ['shift+z'], 'toggleAllFolds'],
    ['cycleGrouping', ['s'], 'cycleGrouping'],
  ] as const;

  for (const [id, keys, kind] of expected) {
    expect(byId[id]?.keys).toEqual(keys);
    expect(byId[id]?.intent(snapshot)).toEqual({ kind: 'application', intent: { kind } });
  }
});

test('return does nothing on a thread row and folds on a node row', () => {
  const thread = {
    id: toThreadId('1'),
    reason: 'review_requested',
    unread: true,
    updatedAt: '2026-01-02T10:00:00Z',
    lastReadAt: null,
    title: 'One',
    subjectType: 'PullRequest',
    subjectUrl: null,
    repository: 'acme/app',
  };

  const loaded = { ...snapshot, threads: [thread], selectedRowKey: 'node:review' };
  const command = catalog.find((candidate) => candidate.id === 'toggleNodeFold');

  expect(command?.disabledReason(loaded)).toBeUndefined();
  expect(command?.disabledReason({ ...loaded, selectedRowKey: 'thread:1' })).toBeDefined();
});

test('no catalog key is bound to two commands', () => {
  const keys = catalog.flatMap((command) => command.keys);

  expect(new Set(keys).size).toBe(keys.length);
});
