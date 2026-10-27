import { expect, test } from 'bun:test';

import type { ReaderContext } from '../src/commands.ts';
import { catalog } from '../src/commands.ts';
import { createSession, visibleRows } from '../src/session/session.ts';
import { toThreadId, toViewerId, toViewerLogin } from '../src/work/work.ts';

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

const readerRowOf = (snapshot: ReturnType<typeof createLoadedSnapshot>): ReaderContext => {
  const threadRow = visibleRows(snapshot).find((row) => row.kind === 'thread');

  return threadRow?.kind === 'thread' ? { kind: 'reader', row: threadRow } : inbox;
};

test('reader Done marks only the reader thread, even when the selected row is a group', () => {
  const loadedSnapshot = createLoadedSnapshot();
  const reader = readerRowOf(loadedSnapshot);
  const groupSelected = { ...loadedSnapshot, selectedRowKey: 'node:review' };

  const command = catalog.find((candidate) => candidate.id === 'readerMarkDone');

  expect(command?.configId).toBe('markDone');
  expect(command?.scope).toBe('reader');
  expect(command?.keys).toEqual(['d']);
  expect(command?.disabledReason(loadedSnapshot, reader)).toBeUndefined();

  expect(command?.intent(groupSelected, reader)).toEqual({
    kind: 'application',
    intent: { kind: 'markThreadsDone', threadIds: [toThreadId('1')] },
  });
});

test('reader Done is disabled when the reader thread has left the list', () => {
  const loadedSnapshot = createLoadedSnapshot();
  const reader = readerRowOf(loadedSnapshot);
  const threadGone = { ...loadedSnapshot, threads: [] };

  const command = catalog.find((candidate) => candidate.id === 'readerMarkDone');

  expect(command?.disabledReason(threadGone, reader)).toBeDefined();
  expect(command?.disabledReason(loadedSnapshot, inbox)).toBeDefined();
});

test('reader Open sends the captured thread pages and stays available after the thread leaves', () => {
  const loadedSnapshot = createLoadedSnapshot();
  const reader = readerRowOf(loadedSnapshot);
  const threadGone = { ...loadedSnapshot, threads: [] };

  const command = catalog.find((candidate) => candidate.id === 'readerOpenInBrowser');

  expect(command?.configId).toBe('openInBrowser');
  expect(command?.disabledReason(threadGone, reader)).toBeUndefined();

  expect(command?.intent(threadGone, reader)).toEqual({
    kind: 'application',
    intent: {
      kind: 'openInBrowser',
      pages: [{ kind: 'repo', repository: 'acme/app' }],
    },
  });
});

test('reader Refresh sends its list intent and keeps its list keys', () => {
  const loadedSnapshot = createLoadedSnapshot();
  const reader = readerRowOf(loadedSnapshot);

  const refresh = catalog.find((candidate) => candidate.id === 'readerRefresh');

  expect(refresh?.configId).toBe('refresh');
  expect(refresh?.keys).toEqual(['r']);

  expect(refresh?.intent(loadedSnapshot, reader)).toEqual({
    kind: 'application',
    intent: { kind: 'refresh' },
  });
});

test('reader Undo is available only while the reader thread is hidden by a pending done', () => {
  const loadedSnapshot = createLoadedSnapshot();
  const reader = readerRowOf(loadedSnapshot);
  const hidden = { ...loadedSnapshot, hiddenThreadIds: new Set([toThreadId('1')]) };

  const undo = catalog.find((candidate) => candidate.id === 'readerUndoDone');

  expect(undo?.configId).toBe('undoDone');
  expect(undo?.keys).toEqual(['u']);

  expect(undo?.disabledReason(loadedSnapshot, reader)).toBeDefined();
  expect(undo?.disabledReason(hidden, reader)).toBeUndefined();
  expect(undo?.disabledReason(hidden, inbox)).toBeDefined();
});

test('reader Undo sends an undo for the reader thread only', () => {
  const loadedSnapshot = createLoadedSnapshot();
  const reader = readerRowOf(loadedSnapshot);

  const undo = catalog.find((candidate) => candidate.id === 'readerUndoDone');

  expect(undo?.intent(loadedSnapshot, reader)).toEqual({
    kind: 'application',
    intent: { kind: 'undoThreadDone', threadId: toThreadId('1') },
  });
});
