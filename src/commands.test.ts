import { expect, test } from 'bun:test';

import type { Intent, ReaderContext } from './commands.ts';
import { catalog, keyHintOf, keyNamesOf, readableKeyOf, readableStrokeOf } from './commands.ts';
import type { ApplicationIntent, Filter } from './session/session.ts';
import { createSession, visibleRows } from './session/session.ts';
import type { BrowserPage } from './work/work.ts';
import { toThreadId, toViewerId, toViewerLogin } from './work/work.ts';

const idleEffects = {
  savedSnapshot: null,
  host: 'github.com',
  refreshKey: 'r',
  savedState: null,
  saveState: () => undefined,
  markThreadDone: () => Promise.resolve({ ok: true as const, value: null }),
  openInBrowser: () => Promise.resolve({ ok: true as const }),
  configNotices: [],
  stateWarning: null,
  readViewer: () =>
    Promise.resolve({
      ok: true as const,
      value: { id: toViewerId('U_octocat'), login: toViewerLogin('octocat'), etag: null },
    }),
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
  lookUpSubjects: () => Promise.resolve({ lookups: [], failures: [] }),
  now: () => new Date(0),
  setTimer: () => () => undefined,
};

const createSnapshot = () => createSession(idleEffects).getSnapshot();

const inbox: ReaderContext = { kind: 'inbox' };

test('quit returns a terminal intent and help returns a UI intent', () => {
  const snapshot = createSnapshot();

  const enabled = catalog.filter(
    (command) => command.disabledReason(snapshot, inbox) === undefined,
  );

  const intents = Object.fromEntries(
    enabled.map((command) => [command.id, command.intent(snapshot, inbox)]),
  );

  expect(intents['quit']).toEqual({ kind: 'terminal', action: 'quit' });
  expect(intents['help']).toEqual({ kind: 'ui', action: 'toggleHelp' });
});

test('list commands return the matching application intents on j, k, and r', () => {
  const snapshot = createSnapshot();

  const byId = Object.fromEntries(catalog.map((command) => [command.id, command]));

  expect(byId['selectNext']?.keys).toEqual(['j', 'down']);
  expect(byId['selectPrevious']?.keys).toEqual(['k', 'up']);
  expect(byId['refresh']?.keys).toEqual(['r']);

  expect(byId['selectNext']?.intent(snapshot, inbox)).toEqual({
    kind: 'application',
    intent: { kind: 'selectNext' },
  });

  expect(byId['selectPrevious']?.intent(snapshot, inbox)).toEqual({
    kind: 'application',
    intent: { kind: 'selectPrevious' },
  });

  expect(byId['refresh']?.intent(snapshot, inbox)).toEqual({
    kind: 'application',
    intent: { kind: 'refresh' },
  });
});

test('tree commands list their keys and return their intents', () => {
  const snapshot = createSnapshot();

  const byId = Object.fromEntries(catalog.map((command) => [command.id, command]));

  const expected = [
    ['selectFirst', ['gg'], 'selectFirst'],
    ['selectLast', ['shift+g'], 'selectLast'],
    ['selectNextGroup', ['shift+j'], 'selectNextGroup'],
    ['selectPreviousGroup', ['shift+k'], 'selectPreviousGroup'],
    ['toggleFold', ['za', 'space'], 'toggleFold'],
    ['cycleGrouping', ['s'], 'cycleGrouping'],
  ] as const;

  for (const [id, keys, kind] of expected) {
    expect(byId[id]?.keys).toEqual(keys);
    expect(byId[id]?.intent(snapshot, inbox)).toEqual({ kind: 'application', intent: { kind } });
  }
});

test('paging commands return scrollPage intents with and without a count', () => {
  const snapshot = createSnapshot();

  const byId = Object.fromEntries(catalog.map((command) => [command.id, command]));

  const expected = [
    ['halfPageDown', 'down', 'half'],
    ['halfPageUp', 'up', 'half'],
    ['pageDown', 'down', 'full'],
    ['pageUp', 'up', 'full'],
  ] as const;

  for (const [id, direction, size] of expected) {
    expect(byId[id]?.intent(snapshot, inbox)).toEqual({
      kind: 'application',
      intent: { kind: 'scrollPage', direction, size, count: undefined },
    });

    expect(byId[id]?.intent(snapshot, inbox, 3)).toEqual({
      kind: 'application',
      intent: { kind: 'scrollPage', direction, size, count: 3 },
    });
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

const createLoadedSnapshot = () => ({ ...createSnapshot(), threads: [loadedThread] });

test('return folds a group on a node row and opens the detail on a thread row', () => {
  const loadedSnapshot = createLoadedSnapshot();

  const bound = catalog.filter(
    (candidate) => candidate.scope === 'list' && candidate.keys.includes('return'),
  );

  const [command] = bound;
  const onNode = { ...loadedSnapshot, selectedRowKey: 'node:review' };
  const onThread = { ...loadedSnapshot, selectedRowKey: 'thread:1' };
  const nothing = { ...loadedSnapshot, selectedRowKey: 'missing' };

  expect(bound).toHaveLength(1);
  expect(command?.scope).toBe('list');

  expect(command?.disabledReason(onNode, inbox)).toBeUndefined();
  expect(command?.disabledReason(onThread, inbox)).toBeUndefined();
  expect(command?.disabledReason(nothing, inbox)).toBeDefined();

  expect(command?.intent(onNode, inbox)).toEqual({
    kind: 'application',
    intent: { kind: 'toggleFold' },
  });

  expect(command?.intent(onThread, inbox)).toMatchObject({
    kind: 'ui',
    action: 'openDetail',
    row: { kind: 'thread', key: 'thread:1' },
  });
});

test('closeDetail has the escape key, the reader scope, and a ui intent', () => {
  const loadedSnapshot = createLoadedSnapshot();
  const threadRow = visibleRows(loadedSnapshot).find((row) => row.key === 'thread:1');

  const reader: ReaderContext =
    threadRow?.kind === 'thread' ? { kind: 'reader', row: threadRow } : inbox;

  const close = catalog.find((command) => command.id === 'closeDetail');

  expect(close?.keys).toEqual(['escape']);
  expect(close?.scope).toBe('reader');
  expect(close?.intent(loadedSnapshot, reader)).toEqual({ kind: 'ui', action: 'closeDetail' });
  expect(close?.disabledReason(loadedSnapshot, inbox)).toBeDefined();
  expect(close?.disabledReason(loadedSnapshot, reader)).toBeUndefined();
});

test('reader moves are off without a reader, for a detached thread, and past the ends', () => {
  const threads = [loadedThread, { ...loadedThread, id: toThreadId('2') }];
  const snapshot = { ...createSnapshot(), threads };
  const next = catalog.find((command) => command.id === 'readerNextThread');

  const [onFirst = inbox, onSecond = inbox] = visibleRows(snapshot).flatMap(
    (row): ReaderContext[] => (row.kind === 'thread' ? [{ kind: 'reader', row }] : []),
  );

  expect(next?.disabledReason(snapshot, inbox)).toBeDefined();
  expect(next?.disabledReason(snapshot, onFirst)).toBeUndefined();
  expect(next?.disabledReason(snapshot, onSecond)).toBeDefined();
  expect(next?.disabledReason({ ...snapshot, threads: threads.slice(1) }, onFirst)).toBeDefined();
  expect(next?.intent(snapshot, onFirst)).toMatchObject({ row: { key: 'thread:2' } });
});

test('markDone marks one thread on a thread row and every shown thread on a node row', () => {
  const loadedSnapshot = createLoadedSnapshot();

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
  expect(command?.disabledReason(onNode, inbox)).toBeUndefined();
  expect(command?.disabledReason(onThread, inbox)).toBeUndefined();
  expect(command?.disabledReason({ ...loadedSnapshot, selectedRowKey: null }, inbox)).toBeDefined();

  expect(command?.intent(onThread, inbox)).toEqual({
    kind: 'application',
    intent: { kind: 'markDone' },
  });

  expect(command?.intent(onNode, inbox)).toEqual({
    kind: 'application',
    intent: { kind: 'markThreadsDone', threadIds: nodeThreadIds },
  });
});

test('undo is bound to u and returns the undoDone intent', () => {
  const snapshot = createSnapshot();

  const command = catalog.find((candidate) => candidate.id === 'undoDone');

  expect(command?.keys).toEqual(['u']);
  expect(command?.scope).toBe('list');

  expect(command?.intent(snapshot, inbox)).toEqual({
    kind: 'application',
    intent: { kind: 'undoDone' },
  });
});

const intentOf = (pages: BrowserPage[]): Intent => ({
  kind: 'application',
  intent: { kind: 'openInBrowser', pages },
});

test('o on a thread row, a repo node, and a group node sends the expected open intent', () => {
  const loadedSnapshot = createLoadedSnapshot();

  const command = catalog.find((candidate) => candidate.id === 'openInBrowser');

  const threads = [
    { ...loadedThread, subjectUrl: 'https://api.github.com/repos/acme/app/pulls/42' },
    { ...loadedThread, id: toThreadId('2'), repository: 'acme/lib', subjectUrl: null },
  ];

  const rows = visibleRows({ ...loadedSnapshot, threads });

  const openedOn = (key: string | undefined) =>
    command?.intent({ ...loadedSnapshot, threads, selectedRowKey: key ?? null }, inbox);

  const groupRow = rows.find((row) => row.kind === 'node' && row.topLevel);

  const repoRow = rows.find(
    (row) => row.kind === 'node' && !row.topLevel && row.title === 'acme/app',
  );

  const threadRow = rows.find((row) => row.kind === 'thread' && row.thread.id === threads[0]?.id);

  expect(command?.keys).toEqual(['o', 'gx']);
  expect(command?.scope).toBe('list');
  expect(command?.disabledReason({ ...loadedSnapshot, selectedRowKey: null }, inbox)).toBeDefined();

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
  const loadedSnapshot = createLoadedSnapshot();

  const command = catalog.find((candidate) => candidate.id === 'openInBrowser');

  const groupOf = (repositories: number) => {
    const threads = Array.from({ length: repositories }, (_, index) => ({
      ...loadedThread,
      id: toThreadId(String(index + 1)),
      repository: `acme/repo${index}`,
    }));

    const rows = visibleRows({ ...loadedSnapshot, threads });
    const group = rows.find((row) => row.kind === 'node' && row.topLevel);

    return command?.intent(
      { ...loadedSnapshot, threads, selectedRowKey: group?.key ?? null },
      inbox,
    );
  };

  const three = groupOf(3);

  expect(three?.kind).toBe('application');
  expect(three?.kind === 'application' ? three.intent.kind : null).toBe('openInBrowser');

  const four = groupOf(4);

  expect(four?.kind === 'ui' && four.action === 'askOpen' ? four.pages : []).toHaveLength(4);
});

test('the input commands act on the search line and clearSearch is disabled without a search', () => {
  const snapshot = createSnapshot();

  const byId = Object.fromEntries(catalog.map((command) => [command.id, command]));

  expect(byId['openSearch']?.keys).toEqual(['/']);

  expect(byId['submitInput']?.intent(snapshot, inbox)).toEqual({
    kind: 'application',
    intent: { kind: 'keepSearch' },
  });

  expect(byId['cancelInput']?.intent(snapshot, inbox)).toEqual({
    kind: 'application',
    intent: { kind: 'restoreSearch' },
  });

  expect(byId['clearInput']?.intent(snapshot, inbox)).toEqual({
    kind: 'application',
    intent: { kind: 'editSearch', text: '' },
  });

  expect(byId['closeEmptyInput']?.keys).toEqual(['backspace']);
  expect(byId['closeEmptyInput']?.preventDefault).toBe(false);
  expect(byId['closeEmptyInput']?.disabledReason(snapshot, inbox)).toBeUndefined();

  expect(
    byId['closeEmptyInput']?.disabledReason({ ...snapshot, searchText: 'a' }, inbox),
  ).toBeDefined();

  expect(byId['clearSearch']?.disabledReason(snapshot, inbox)).toBeDefined();

  expect(
    byId['clearSearch']?.disabledReason({ ...snapshot, searchText: 'a' }, inbox),
  ).toBeUndefined();
});

const byId = (id: string) => catalog.find((command) => command.id === id);

test('the command line opens on colon and its commands run, close, clear, and quit', () => {
  const snapshot = createSnapshot();

  const commandIntentOf = (id: string) => byId(id)?.intent(snapshot, inbox);
  const open = byId('openCommandLine');
  const emptyClose = byId('closeEmptyCommandLine');

  const intents = [
    ['openCommandLine', { kind: 'application', intent: { kind: 'openCommandLine' } }],
    ['runCommandLine', { kind: 'ui', action: 'runCommandLine' }],
    ['closeCommandLine', { kind: 'application', intent: { kind: 'closeCommandLine' } }],
    ['clearCommandLine', { kind: 'application', intent: { kind: 'editCommandLine', text: '' } }],
    ['quitFromCommandLine', { kind: 'terminal', action: 'quit' }],
  ] as const;

  expect([open?.keys, open?.scope]).toEqual([[':'], 'list']);
  expect(intents.map(([id]) => commandIntentOf(id))).toEqual(intents.map(([, intent]) => intent));

  expect(emptyClose?.preventDefault).toBe(false);
  expect(emptyClose?.disabledReason(snapshot, inbox)).toBeUndefined();
  expect(emptyClose?.disabledReason({ ...snapshot, commandLineText: 'a' }, inbox)).toBeDefined();
});

test('the completion keys are disabled only when the last word has no candidates', () => {
  const loadedSnapshot = createLoadedSnapshot();

  const withCandidates = { ...loadedSnapshot, searchText: 'on' };
  const withoutCandidates = { ...loadedSnapshot, searchText: 'zzz' };

  for (const id of ['nextSearchCompletion', 'previousSearchCompletion']) {
    expect(byId(id)?.disabledReason(withoutCandidates, inbox)).toBeDefined();
    expect(byId(id)?.disabledReason(withCandidates, inbox)).toBeUndefined();
  }
});

test('shift+f clears filters and is disabled without filters', () => {
  const snapshot = createSnapshot();

  const command = byId('clearFilters');
  const filters: Filter[] = [{ field: 'repo', value: 'acme/app', negated: false }];

  expect(command?.keys).toEqual(['shift+f']);
  expect(command?.disabledReason({ ...snapshot, filters: [] }, inbox)).toBeDefined();
  expect(command?.disabledReason({ ...snapshot, filters }, inbox)).toBeUndefined();
});

const application = (intent: ApplicationIntent): Intent => ({ kind: 'application', intent });

test('each remaining command returns its intent', () => {
  const snapshot = createSnapshot();

  const quit: Intent = { kind: 'terminal', action: 'quit' };

  const expected = [
    ['openSearch', application({ kind: 'openSearch' })],
    ['clearSearch', application({ kind: 'clearSearch' })],
    ['openFilters', application({ kind: 'openFilters' })],
    ['clearFilters', application({ kind: 'clearFilters' })],
    ['nextSearchCompletion', application({ kind: 'nextSearchCompletion' })],
    ['previousSearchCompletion', application({ kind: 'previousSearchCompletion' })],
    ['quitFromInput', quit],
    ['closeEmptyInput', application({ kind: 'keepSearch' })],
    ['closeEmptyCommandLine', application({ kind: 'closeCommandLine' })],
    ['closeHelp', { kind: 'ui', action: 'closeHelp' }],
    ['showMessages', { kind: 'ui', action: 'openMessages' }],
    ['closeMessages', { kind: 'ui', action: 'closeMessages' }],
    ['confirmOpen', { kind: 'ui', action: 'confirmOpen' }],
    ['cancelOpen', { kind: 'ui', action: 'cancelOpen' }],
    ['applyFilterRow', application({ kind: 'applyFilterRow' })],
    ['takeFilterRow', application({ kind: 'takeFilterRow' })],
    ['moveFilterUp', application({ kind: 'moveFilterCursor', direction: 'up' })],
    ['moveFilterDown', application({ kind: 'moveFilterCursor', direction: 'down' })],
    ['closeFilters', application({ kind: 'closeFilters' })],
    ['clearFilterDraft', application({ kind: 'editFilterDraft', text: '' })],
    ['closeEmptyFilterDraft', application({ kind: 'leaveFilters' })],
    ['quitFromFilters', quit],
  ] satisfies [string, Intent][];

  for (const [id, intent] of expected) {
    expect(byId(id)?.intent(snapshot, inbox)).toEqual(intent);
  }
});

test('readableKeyOf gives each raw key its readable name', () => {
  const expected: [string, string][] = [
    ['return', 'Enter'],
    ['escape', 'Esc'],
    ['space', 'Space'],
    ['tab', 'Tab'],
    ['shift+tab', 'Shift+Tab'],
    ['backspace', 'Backspace'],
    ['ctrl+c', 'Ctrl+C'],
    ['shift+g', 'G'],
    ['zshift+r', 'zR'],
    ['gg', 'gg'],
    ['ctrl+d', 'Ctrl+D'],
    ['meta+j', 'Alt+j'],
    ['gmeta+j', 'gAlt+j'],
    ['up', '↑'],
    ['down', '↓'],
    ['q', 'q'],
  ];

  for (const [key, name] of expected) {
    expect(readableKeyOf(key)).toBe(name);
  }
});

test('keyNamesOf returns the readable keys of a command by id', () => {
  expect(keyNamesOf(catalog, 'confirmOpen')).toEqual(['y', 'Enter']);
  expect(keyNamesOf(catalog, 'missing')).toEqual([]);
});

test('keyHintOf joins key names with a slash unless told otherwise', () => {
  const pair = [{ ...catalog[0]!, id: 'pair', keys: ['a', 'space'] }];

  expect(keyHintOf(pair, 'pair')).toBe('a/Space');
  expect(keyHintOf(pair, 'pair', ' or ')).toBe('a or Space');
});

test('keyHintOf gives nothing for a command without keys or an unknown command', () => {
  const bare = [{ ...catalog[0]!, id: 'bare', keys: [] }];

  expect(keyHintOf(bare, 'bare')).toBeUndefined();
  expect(keyHintOf(bare, 'missing')).toBeUndefined();
});

test('readableStrokeOf names a shifted stroke that is not a letter by its modifier and name', () => {
  expect(readableStrokeOf({ name: 'up', shift: true })).toBe('shift+up');
  expect(readableStrokeOf({ name: 'a', shift: true })).toBe('A');
});
