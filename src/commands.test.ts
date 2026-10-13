import { expect, test } from 'bun:test';

import type { Command } from './commands.ts';
import { catalog } from './commands.ts';
import { createSession, visibleRows } from './session/session.ts';
import { toThreadId, toViewerLogin } from './work/work.ts';

const idleEffects = {
  savedSnapshot: null,
  host: 'github.com',
  savedState: null,
  saveState: () => undefined,
  markThreadDone: () => Promise.resolve({ ok: true as const, value: null }),
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
  lookUpSubjects: () => Promise.resolve([]),
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
    ['toggleAllFolds', ['shift+z'], 'toggleAllFolds'],
    ['cycleGrouping', ['s'], 'cycleGrouping'],
  ] as const;

  for (const [id, keys, kind] of expected) {
    expect(byId[id]?.keys).toEqual(keys);
    expect(byId[id]?.intent(snapshot)).toEqual({ kind: 'application', intent: { kind } });
  }
});

const loadedThread = {
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

const loadedSnapshot = { ...snapshot, threads: [loadedThread] };

const scopesOverlap = (first: Command['scope'], second: Command['scope']): boolean =>
  first === second || first === 'global' || second === 'global';

const overlappingKeys = (commands: readonly Command[]): string[] => {
  const clashes: string[] = [];

  for (const [index, command] of commands.entries()) {
    for (const other of commands.slice(index + 1)) {
      const shared = command.keys.filter((key) => other.keys.includes(key));

      if (scopesOverlap(command.scope, other.scope)) {
        clashes.push(...shared);
      }
    }
  }

  return clashes;
};

test('no key is bound to two commands whose scopes can be active together', () => {
  expect(overlappingKeys(catalog)).toEqual([]);
});

test('return folds a group on a node row and opens the detail on a thread row', () => {
  const bound = catalog.filter((candidate) => candidate.keys.includes('return'));
  const [command] = bound;
  const onNode = { ...loadedSnapshot, selectedRowKey: 'node:review' };
  const onThread = { ...loadedSnapshot, selectedRowKey: 'thread:1' };
  const nothing = { ...loadedSnapshot, selectedRowKey: 'missing' };

  expect(bound).toHaveLength(1);
  expect(command?.scope).toBe('list');

  expect(command?.disabledReason(onNode)).toBeUndefined();
  expect(command?.disabledReason(onThread)).toBeUndefined();
  expect(command?.disabledReason(nothing)).toBeDefined();

  expect(command?.intent(onNode)).toEqual({ kind: 'application', intent: { kind: 'toggleFold' } });
  expect(command?.intent(onThread)).toEqual({ kind: 'ui', action: 'openDetail' });
});

test('closeDetail has the escape key, the preview scope, and a ui intent', () => {
  const close = catalog.find((command) => command.id === 'closeDetail');

  expect(close?.keys).toEqual(['escape']);
  expect(close?.scope).toBe('preview');
  expect(close?.intent(snapshot)).toEqual({ kind: 'ui', action: 'closeDetail' });
  expect(close?.disabledReason(snapshot)).toBeUndefined();
});

test('done is disabled on a group row and enabled on a thread row', () => {
  const command = catalog.find((candidate) => candidate.id === 'markDone');
  const onNode = { ...loadedSnapshot, selectedRowKey: 'node:review' };
  const onThread = { ...loadedSnapshot, selectedRowKey: 'thread:1' };

  expect(command?.keys).toEqual(['d']);
  expect(command?.scope).toBe('list');
  expect(command?.disabledReason(onNode)).toBeDefined();
  expect(command?.disabledReason(onThread)).toBeUndefined();
  expect(command?.intent(onThread)).toEqual({ kind: 'application', intent: { kind: 'markDone' } });
});

test('undo is bound to u and returns the undoDone intent', () => {
  const command = catalog.find((candidate) => candidate.id === 'undoDone');

  expect(command?.keys).toEqual(['u']);
  expect(command?.scope).toBe('list');
  expect(command?.intent(snapshot)).toEqual({ kind: 'application', intent: { kind: 'undoDone' } });
});

test('markNodeDone is disabled on a thread row and enabled on a node row', () => {
  const command = catalog.find((candidate) => candidate.id === 'markNodeDone');
  const nodeRow = visibleRows(loadedSnapshot).find((row) => row.kind === 'node');
  const threadRow = visibleRows(loadedSnapshot).find((row) => row.kind === 'thread');

  expect(nodeRow).toBeDefined();
  expect(threadRow).toBeDefined();

  const onNode = { ...loadedSnapshot, selectedRowKey: nodeRow?.key ?? null };
  const onThread = { ...loadedSnapshot, selectedRowKey: threadRow?.key ?? null };

  expect(command?.keys).toEqual(['shift+d']);
  expect(command?.scope).toBe('list');
  expect(command?.disabledReason(onThread)).toBeDefined();
  expect(command?.disabledReason(onNode)).toBeUndefined();
});

test('confirm and cancel are disabled while no confirmation is open', () => {
  const confirm = catalog.find((candidate) => candidate.id === 'confirm');
  const cancel = catalog.find((candidate) => candidate.id === 'cancel');
  const open = { ...loadedSnapshot, confirmation: { threadIds: [loadedThread.id] } };

  expect(confirm?.keys).toEqual(['y']);
  expect(cancel?.keys).toEqual(['escape']);
  expect(confirm?.disabledReason(loadedSnapshot)).toBeDefined();
  expect(cancel?.disabledReason(loadedSnapshot)).toBeDefined();
  expect(confirm?.disabledReason(open)).toBeUndefined();
  expect(cancel?.disabledReason(open)).toBeUndefined();

  expect(confirm?.intent(open)).toEqual({
    kind: 'application',
    intent: { kind: 'markThreadsDone', threadIds: [loadedThread.id] },
  });

  expect(cancel?.intent(open)).toEqual({
    kind: 'application',
    intent: { kind: 'closeConfirmation' },
  });
});
