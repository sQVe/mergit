import { expect, test } from 'bun:test';

import type { BrowserPage, NodeRow, NotificationThread, ThreadRow } from './work.ts';
import {
  isDoneLocally,
  isDoneOnGitHub,
  pagesOfRow,
  pageOfThread,
  readSubjectNumber,
  selectOpenThreads,
  toThreadId,
  toViewerLogin,
} from './work.ts';

const makeThread = (
  id: string,
  overrides: Partial<NotificationThread> = {},
): NotificationThread => ({
  id: toThreadId(id),
  reason: 'review_requested',
  unread: true,
  updatedAt: '2026-01-02T10:00:00Z',
  lastReadAt: null,
  title: `Thread ${id}`,
  subjectType: 'PullRequest',
  subjectUrl: `https://api.github.com/repos/acme/app/pulls/${id}`,
  repository: 'acme/app',
  ...overrides,
});

test('selectOpenThreads leaves out threads GitHub shows as done and keeps the rest in order', () => {
  const done = makeThread('1', { unread: false, lastReadAt: null });
  const unread = makeThread('2', { unread: true, lastReadAt: null });

  const readWithTimestamp = makeThread('3', {
    unread: false,
    lastReadAt: '2026-01-01T10:00:00Z',
  });

  const unreadWithTimestamp = makeThread('4', {
    unread: true,
    lastReadAt: '2026-01-01T10:00:00Z',
  });

  const open = selectOpenThreads([unread, done, readWithTimestamp, unreadWithTimestamp], new Map());

  expect(open).toEqual([unread, readWithTimestamp, unreadWithTimestamp]);
});

test('selectOpenThreads hides a thread whose done record matches its updated_at and shows one that changed', () => {
  const recorded = makeThread('6');
  const changed = makeThread('7', { updatedAt: '2026-01-03T10:00:00Z' });

  const doneRecords = new Map([
    [recorded.id, recorded.updatedAt],
    [changed.id, '2026-01-02T10:00:00Z'],
  ]);

  expect(isDoneLocally(recorded, doneRecords)).toBe(true);
  expect(isDoneLocally(changed, doneRecords)).toBe(false);
  expect(selectOpenThreads([recorded, changed], doneRecords)).toEqual([changed]);
});

test('selectOpenThreads keeps a thread without a subject URL', () => {
  const checkSuite = makeThread('5', { subjectType: 'CheckSuite', subjectUrl: null });

  expect(selectOpenThreads([checkSuite], new Map())).toEqual([checkSuite]);
});

test('toThreadId and toViewerLogin reject empty values', () => {
  expect(() => toThreadId('')).toThrow();
  expect(() => toViewerLogin('')).toThrow();
});

test('isDoneOnGitHub is true only for a read thread with no last read time', () => {
  expect(isDoneOnGitHub(makeThread('6', { unread: false, lastReadAt: null }))).toBe(true);
  expect(isDoneOnGitHub(makeThread('7', { unread: true, lastReadAt: null }))).toBe(false);
});

test('readSubjectNumber reads pull request and issue numbers and returns null without one', () => {
  const base = 'https://api.github.com/repos/o/r';

  expect(readSubjectNumber(`${base}/pulls/12`)).toBe(12);
  expect(readSubjectNumber(`${base}/issues/7`)).toBe(7);
  expect(readSubjectNumber(`${base}/releases/555`)).toBeNull();
  expect(readSubjectNumber(`${base}/commits/abc123def`)).toBeNull();
  expect(readSubjectNumber(null)).toBeNull();
});

const pageOf = (overrides: Partial<NotificationThread>): BrowserPage =>
  pageOfThread(makeThread('1', { repository: 'octo/mergit', ...overrides }));

test('pageOfThread maps a pull request or issue to its number', () => {
  expect(pageOf({ subjectUrl: 'https://api.github.com/repos/octo/mergit/pulls/42' })).toEqual({
    kind: 'item',
    repository: 'octo/mergit',
    number: 42,
  });

  expect(
    pageOf({
      subjectType: 'Issue',
      subjectUrl: 'https://api.github.com/repos/octo/mergit/issues/7',
    }),
  ).toEqual({ kind: 'item', repository: 'octo/mergit', number: 7 });
});

test('pageOfThread maps a commit to its SHA', () => {
  expect(
    pageOf({
      subjectType: 'Commit',
      subjectUrl: 'https://api.github.com/repos/octo/mergit/commits/0a1b2c3d4e5f',
    }),
  ).toEqual({ kind: 'commit', repository: 'octo/mergit', sha: '0a1b2c3d4e5f' });
});

test('pageOfThread maps a release and a check suite to the repo pages that list them', () => {
  expect(pageOf({ subjectType: 'Release', subjectUrl: null })).toEqual({
    kind: 'releases',
    repository: 'octo/mergit',
  });

  expect(pageOf({ subjectType: 'CheckSuite', subjectUrl: null })).toEqual({
    kind: 'actions',
    repository: 'octo/mergit',
  });
});

test('pageOfThread falls back to the repo for other types and unreadable numbers or SHAs', () => {
  const repo = { kind: 'repo', repository: 'octo/mergit' } as const;

  expect(pageOf({ subjectType: 'Discussion', subjectUrl: null })).toEqual(repo);
  expect(pageOf({ subjectType: 'PullRequest', subjectUrl: null })).toEqual(repo);

  expect(
    pageOf({ subjectType: 'Issue', subjectUrl: 'https://api.github.com/x/issues/abc' }),
  ).toEqual(repo);

  expect(pageOf({ subjectType: 'Commit', subjectUrl: null })).toEqual(repo);

  expect(
    pageOf({
      subjectType: 'Commit',
      subjectUrl: 'https://api.github.com/repos/octo/mergit/commits/xyz',
    }),
  ).toEqual(repo);
});

const nodeRowOf = (threads: NotificationThread[]): NodeRow => ({
  kind: 'node',
  key: 'node:test',
  nodeKey: 'test',
  title: 'Test',
  depth: 0,
  topLevel: true,
  folded: false,
  threads,
});

test('pagesOfRow maps a thread row to its one page', () => {
  const thread = makeThread('1', { repository: 'octo/mergit' });

  const row: ThreadRow = {
    kind: 'thread',
    key: 'thread:1',
    thread,
    depth: 1,
    nodeRowKey: null,
    last: true,
  };

  expect(pagesOfRow(row)).toEqual([pageOfThread(thread)]);
});

test('pagesOfRow maps a repo node to its repo', () => {
  const row = nodeRowOf([
    makeThread('1', { repository: 'octo/mergit' }),
    makeThread('2', { repository: 'octo/mergit' }),
  ]);

  expect(pagesOfRow(row)).toEqual([{ kind: 'repo', repository: 'octo/mergit' }]);
});

test('pagesOfRow maps a group node to one repo page per distinct repo in listed order', () => {
  const row = nodeRowOf([
    makeThread('1', { repository: 'octo/b' }),
    makeThread('2', { repository: 'octo/a' }),
    makeThread('3', { repository: 'octo/a' }),
    makeThread('4', { repository: 'octo/c' }),
    makeThread('5', { repository: 'octo/b' }),
    makeThread('6', { repository: 'octo/a' }),
  ]);

  expect(pagesOfRow(row)).toEqual([
    { kind: 'repo', repository: 'octo/a' },
    { kind: 'repo', repository: 'octo/b' },
    { kind: 'repo', repository: 'octo/c' },
  ]);
});

test('pageOfThread ignores subject URLs with trailing text after the number or SHA', () => {
  const base = 'https://api.github.com/repos/acme/app';
  const repositoryPage: BrowserPage = { kind: 'repo', repository: 'acme/app' };

  const pull = makeThread('1', { subjectUrl: `${base}/pulls/12x` });
  const commit = makeThread('2', { subjectType: 'Commit', subjectUrl: `${base}/commits/0a1bzz` });

  expect(pageOfThread(pull)).toEqual(repositoryPage);
  expect(pageOfThread(commit)).toEqual(repositoryPage);
});
