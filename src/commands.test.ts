import { expect, test } from 'bun:test';

import type { Command, Intent } from './commands.ts';
import { catalog } from './commands.ts';
import { createSession, visibleRows } from './session/session.ts';
import type { BrowserPage } from './work/work.ts';
import { toThreadId, toViewerLogin } from './work/work.ts';

const idleEffects = {
  savedSnapshot: null,
  host: 'github.com',
  savedState: null,
  saveState: () => undefined,
  markThreadDone: () => Promise.resolve({ ok: true as const, value: null }),
  openInBrowser: () => Promise.resolve({ ok: true as const }),
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

const globalOverlaps = (global: Command['scope'], other: Command['scope']): boolean =>
  global === 'global' && other !== 'input' && other !== 'filter';

const scopesOverlap = (first: Command['scope'], second: Command['scope']): boolean =>
  first === second || globalOverlaps(first, second) || globalOverlaps(second, first);

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
  const bound = catalog.filter(
    (candidate) => candidate.scope === 'list' && candidate.keys.includes('return'),
  );

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

test('markDone marks one thread on a thread row and every shown thread on a node row', () => {
  const command = catalog.find((candidate) => candidate.id === 'markDone');
  const nodeRow = visibleRows(loadedSnapshot).find((row) => row.kind === 'node');
  const threadRow = visibleRows(loadedSnapshot).find((row) => row.kind === 'thread');

  expect(nodeRow?.kind).toBe('node');
  expect(threadRow).toBeDefined();

  const onNode = { ...loadedSnapshot, selectedRowKey: nodeRow?.key ?? null };
  const onThread = { ...loadedSnapshot, selectedRowKey: threadRow?.key ?? null };
  const nodeThreadIds = nodeRow?.kind === 'node' ? nodeRow.threads.map((thread) => thread.id) : [];

  expect(command?.keys).toEqual(['d']);
  expect(command?.scope).toBe('list');
  expect(nodeThreadIds.length).toBeGreaterThan(0);
  expect(command?.disabledReason(onNode)).toBeUndefined();
  expect(command?.disabledReason(onThread)).toBeUndefined();
  expect(command?.disabledReason({ ...loadedSnapshot, selectedRowKey: null })).toBeDefined();
  expect(command?.intent(onThread)).toEqual({ kind: 'application', intent: { kind: 'markDone' } });

  expect(command?.intent(onNode)).toEqual({
    kind: 'application',
    intent: { kind: 'markThreadsDone', threadIds: nodeThreadIds },
  });
});

test('undo is bound to u and returns the undoDone intent', () => {
  const command = catalog.find((candidate) => candidate.id === 'undoDone');

  expect(command?.keys).toEqual(['u']);
  expect(command?.scope).toBe('list');
  expect(command?.intent(snapshot)).toEqual({ kind: 'application', intent: { kind: 'undoDone' } });
});

const intentOf = (pages: BrowserPage[]): Intent => ({
  kind: 'application',
  intent: { kind: 'openInBrowser', pages },
});

test('o on a thread row, a repo node, and a group node sends the expected open intent', () => {
  const command = catalog.find((candidate) => candidate.id === 'openInBrowser');

  const threads = [
    { ...loadedThread, subjectUrl: 'https://api.github.com/repos/acme/app/pulls/42' },
    { ...loadedThread, id: toThreadId('2'), repository: 'acme/lib', subjectUrl: null },
  ];

  const rows = visibleRows({ ...loadedSnapshot, threads });

  const openedOn = (key: string | undefined) =>
    command?.intent({ ...loadedSnapshot, threads, selectedRowKey: key ?? null });

  const groupRow = rows.find((row) => row.kind === 'node' && row.topLevel);

  const repoRow = rows.find(
    (row) => row.kind === 'node' && !row.topLevel && row.title === 'acme/app',
  );

  const threadRow = rows.find((row) => row.kind === 'thread' && row.thread.id === threads[0]?.id);

  expect(command?.keys).toEqual(['o']);
  expect(command?.scope).toBe('list');
  expect(command?.disabledReason({ ...loadedSnapshot, selectedRowKey: null })).toBeDefined();

  expect(openedOn(threadRow?.key)).toEqual(
    intentOf([{ kind: 'item', repository: 'acme/app', number: 42 }]),
  );

  expect(openedOn(repoRow?.key)).toEqual(intentOf([{ kind: 'repo', repository: 'acme/app' }]));

  expect(openedOn(groupRow?.key)).toEqual(
    intentOf([
      { kind: 'repo', repository: 'acme/app' },
      { kind: 'repo', repository: 'acme/lib' },
    ]),
  );
});

test('o on a group node over 3 repos opens at once, and over 4 repos opens the dialog', () => {
  const command = catalog.find((candidate) => candidate.id === 'openInBrowser');

  const groupOf = (repositories: number) => {
    const threads = Array.from({ length: repositories }, (_, index) => ({
      ...loadedThread,
      id: toThreadId(String(index + 1)),
      repository: `acme/repo${index}`,
    }));

    const rows = visibleRows({ ...loadedSnapshot, threads });
    const group = rows.find((row) => row.kind === 'node' && row.topLevel);

    return command?.intent({ ...loadedSnapshot, threads, selectedRowKey: group?.key ?? null });
  };

  const three = groupOf(3);

  expect(three?.kind).toBe('application');
  expect(three?.kind === 'application' ? three.intent.kind : null).toBe('openInBrowser');

  const four = groupOf(4);

  expect(four?.kind === 'ui' && four.action === 'askOpen' ? four.pages : []).toHaveLength(4);
});

test('the input commands act on the search line and clearSearch is disabled without a search', () => {
  const byId = Object.fromEntries(catalog.map((command) => [command.id, command]));

  expect(byId['openSearch']?.keys).toEqual(['/']);

  expect(byId['submitInput']?.intent(snapshot)).toEqual({
    kind: 'application',
    intent: { kind: 'keepSearch' },
  });

  expect(byId['cancelInput']?.intent(snapshot)).toEqual({
    kind: 'application',
    intent: { kind: 'restoreSearch' },
  });

  expect(byId['clearInput']?.intent(snapshot)).toEqual({
    kind: 'application',
    intent: { kind: 'editSearch', text: '' },
  });

  expect(byId['closeEmptyInput']?.keys).toEqual(['backspace']);
  expect(byId['closeEmptyInput']?.preventDefault).toBe(false);
  expect(byId['closeEmptyInput']?.disabledReason(snapshot)).toBeUndefined();
  expect(byId['closeEmptyInput']?.disabledReason({ ...snapshot, searchText: 'a' })).toBeDefined();
  expect(byId['clearSearch']?.disabledReason(snapshot)).toBeDefined();

  expect(byId['clearSearch']?.disabledReason({ ...snapshot, searchText: 'a' })).toBeUndefined();
});
